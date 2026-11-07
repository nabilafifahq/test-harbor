// HTTP API. Runs as one Vercel function (api/index.js) and as a plain Node server locally (src/server.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { seed } from './seed.js';
import { processEmail, commitProposal, audit, buildMatcher, httpErr, PRIORITY_RANK, DEMO_NOW } from './agent.js';
import { login, logout, sessionUser, readCookie, cookieName, CAN, SESSION_ABSOLUTE_MS } from './auth.js';
import { InvertedIndex, MinHeap, sortBy, parseQuery, facets } from './algo.js';
import { llmModel, llmConfigured } from './llm.js';
import { enqueue, queueStatus, runAgentQueue } from './queue.js';
import { parseEml } from './eml.js';
// Same lookup as waitUntil() in @vercel/functions (Apache-2.0), without its peer dependencies (ws, AWS SDK).
const waitUntil = (job) => globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(job);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PASSWORD = process.env.DEMO_PASSWORD || 'harbor-point-demo-2026';
const AUTO_COMMIT = process.env.AUTO_COMMIT !== 'false';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => Math.round(v * 100) / 100;

// ---------- one-time setup, safe when several function instances start together ----------
let ready = false;
export async function runPipeline(db) {
  await seed(db, DATA_DIR, PASSWORD);
  // With a model configured the inbox is queued and read in the background (queue.js).
  if (llmConfigured()) { await enqueue(db); return { queued: true }; }
  const matcher = await buildMatcher(db);
  const emails = (await db.query('select * from emails order by received_at')).rows;
  for (const e of emails) await processEmail(db, { ...e, received_at: new Date(e.received_at).toISOString() }, { autoCommit: AUTO_COMMIT, matcher });
  return { processed: emails.length };
}
async function ensureReady(db) {
  if (ready) return;
  await db.exec('create table if not exists app_meta (k text primary key, v text, at timestamptz default now())');
  for (let i = 0; i < 55; i++) {
    const s = (await db.query("select v, at from app_meta where k='seed:v2'")).rows[0];
    if (s?.v === 'done') { ready = true; return; }
    if (!s || Date.now() - new Date(s.at).getTime() > 120000) {
      if (s) await db.query("delete from app_meta where k='seed:v2' and v='running'");
      const claim = await db.query("insert into app_meta (k, v) values ('seed:v2','running') on conflict (k) do nothing returning k");
      if (claim.rows.length) {
        try { const r = await runPipeline(db); await db.query("update app_meta set v='done', at=now() where k='seed:v2'"); ready = true; if (r.queued) inBackground(db); return; }
        catch (e) { await db.query("delete from app_meta where k='seed:v2'"); throw e; }
      }
    }
    await sleep(1000);
  }
  throw httpErr(503, 'Loading the demo inbox. Refresh in a few seconds.');
}

// ---------- background agent runs ----------
// waitUntil keeps the Vercel function alive after the response; locally the Node process stays up anyway.
// When a run ends with work left and made progress, it starts the next run itself (needs CRON_SECRET).
export function inBackground(db) {
  const job = (async () => {
    const before = (await queueStatus(db)).processed;
    const s = await runAgentQueue(db, { autoCommit: AUTO_COMMIT });
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (s.pending && s.processed > before && process.env.CRON_SECRET && host) {
      await fetch(`https://${host}/api/agent/run`, { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  })().catch((e) => console.error('[agent] background run failed', e));
  waitUntil(job);
  return job;
}

const bearerOk = (req) => Boolean(process.env.CRON_SECRET) && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

// New mail from the console form, or from a mail provider's inbound webhook. Raw .eml or plain fields.
async function ingest(db, b, by) {
  const e = typeof b.raw === 'string' && b.raw.trim() ? parseEml(b.raw.slice(0, 200000)) : { from_name: str(b.from_name, 200), from_email: str(b.from_email, 200).toLowerCase(), subject: str(b.subject, 300), body: str(b.body, 20000), attachments: [] };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.from_email || '')) throw httpErr(422, 'Add the sender address, for example chef@oakandember.example.');
  if (!str(e.body)) throw httpErr(422, 'The email body is empty. Paste the text of the email.');
  const n = Number((await db.query('select count(*)::int as n from emails')).rows[0].n);
  if (n >= Number(process.env.MAX_EMAILS || 300)) throw httpErr(429, 'The demo inbox is full. An Admin can reset the demo.');
  const last = (await db.query('select max(received_at) as m from emails')).rows[0].m;
  // The demo runs on the inbox day, so new mail lands just after the last email or at the demo clock.
  const at = new Date(Math.max(new Date(last).getTime() + 60000, new Date(DEMO_NOW).getTime())).toISOString();
  const id = `E${String(n + 1).padStart(3, '0')}`;
  const ticket = `HP-${1001 + n}`;
  await db.query('insert into emails values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [id, ticket, at, e.from_name || e.from_email, e.from_email, e.subject || '(no subject)', e.body.slice(0, 20000), JSON.stringify(e.attachments || [])]);
  await enqueue(db, [id]);
  await audit(db, by, by === 'inbound' ? 'system' : 'human', null, 'email_received', { email_id: id, ticket_no: ticket, from: e.from_email, source: b.raw ? 'eml' : 'form' });
  if (!llmConfigured()) await runAgentQueue(db, { autoCommit: AUTO_COMMIT }); // rules only: instant
  else inBackground(db);
  return { email_id: id, ticket_no: ticket, queued: llmConfigured() };
}

// ---------- helpers ----------
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let b = req.body;
  if (b === undefined) {
    b = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 200000) reject(httpErr(413, 'Request too large.')); });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
  if (Buffer.isBuffer(b)) b = b.toString();
  if (typeof b === 'string') { try { return b ? JSON.parse(b) : {}; } catch { throw httpErr(400, 'The request body is not valid JSON.'); } }
  return b || {};
}
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isSecure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https') || Boolean(process.env.VERCEL);

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; the cookie is SameSite=Lax anyway
  try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}

// ---------- ticket list: search, filter, sort, paginate ----------
async function loadTickets(db) {
  const r = await db.query(`select c.email_id, c.ticket_no, c.intent, c.label, c.customer_id, cu.name as customer_name, c.lane, c.status, c.erp_status, c.priority, c.sla_due_at, c.assignee, u.display_name as assignee_name,
      c.summary, c.flags, c.proposal, c.approver_role, e.received_at, e.from_name, e.from_email, e.subject, e.body,
      (select count(*)::int from comments m where m.email_id=c.email_id) as comment_count
    from cases c join emails e using (email_id) left join customers cu using (customer_id) left join users u on u.username=c.assignee`);
  return r.rows.map((t) => {
    const lines = (t.proposal.orders || []).flatMap((o) => o.lines);
    return {
      id: t.email_id, ticket_no: t.ticket_no, intent: t.intent, label: t.label, customer_id: t.customer_id, customer_name: t.customer_name || t.from_name,
      lane: t.lane, status: t.status, erp_status: t.erp_status, priority: t.priority, sla_due_at: new Date(t.sla_due_at).toISOString(), assignee: t.assignee, assignee_name: t.assignee_name,
      summary: t.summary, flags: t.flags.map((f) => f.code), flag_severity: t.flags.some((f) => f.severity === 'bad') ? 'bad' : t.flags.length ? 'warn' : null,
      total: t.proposal.total ?? null, skus: lines.map((l) => l.sku), received_at: new Date(t.received_at).toISOString(), from_name: t.from_name, from_email: t.from_email, subject: t.subject,
      suggested: t.lane === 'waiting_on_customer' ? 'ask_customer' : t.lane === 'auto_committed' ? 'done' : t.lane === 'no_action' ? 'none' : t.proposal.kind === 'route' ? 'route' : 'approve',
      approver_role: t.approver_role, comment_count: t.comment_count,
      _text: `${t.ticket_no} ${t.email_id} ${t.customer_name || ''} ${t.from_name} ${t.from_email} ${t.subject} ${t.body} ${t.summary} ${lines.map((l) => `${l.sku} ${l.name}`).join(' ')} ${t.proposal.customer_po || ''} ${t.intent} ${t.label}`,
    };
  });
}

const OPEN = new Set(['new', 'open']);
const VIEWS = {
  inbox: (t) => OPEN.has(t.status),
  mine: (t, u) => t.assignee === u.username && !['resolved', 'closed'].includes(t.status),
  unassigned: (t) => !t.assignee && OPEN.has(t.status),
  waiting: (t) => t.status === 'pending_customer',
  auto: (t) => t.lane === 'auto_committed',
  resolved: (t) => ['resolved', 'closed'].includes(t.status),
  all: () => true,
};
const SORTS = {
  priority: [{ get: (t) => PRIORITY_RANK[t.priority] }, { get: (t) => t.sla_due_at }],
  sla: [{ get: (t) => t.sla_due_at }],
  newest: [{ get: (t) => t.received_at, dir: 'desc' }],
  oldest: [{ get: (t) => t.received_at }],
  value: [{ get: (t) => t.total ?? -1, dir: 'desc' }],
  customer: [{ get: (t) => (t.customer_name || '').toLowerCase() }],
};

function applyFilters(items, f, user) {
  const has = (k) => f[k] && f[k].length;
  return items.filter((t) =>
    (!has('status') || f.status.includes(t.status)) &&
    (!has('priority') || f.priority.includes(t.priority)) &&
    (!has('label') || f.label.includes(String(t.label).toLowerCase())) &&
    (!has('lane') || f.lane.includes(t.lane)) &&
    (!has('flag') || f.flag.some((x) => t.flags.map((c) => c.toLowerCase()).includes(x.toLowerCase()))) &&
    (!has('customer') || f.customer.some((x) => (t.customer_name || '').toLowerCase().includes(x))) &&
    (!has('sku') || f.sku.some((x) => t.skus.map((s) => s.toLowerCase()).includes(x))) &&
    (!has('assignee') || f.assignee.some((x) => (x === 'me' ? t.assignee === user.username : x === 'none' ? !t.assignee : t.assignee === x))) &&
    (!has('is') || f.is.every((x) => ({ urgent: t.priority === 'urgent', unassigned: !t.assignee, mine: t.assignee === user.username, flagged: t.flags.length > 0, overdue: OPEN.has(t.status) && t.sla_due_at < new Date(DEMO_NOW).toISOString(), committed: t.erp_status === 'committed' })[x] ?? true)));
}

function nextUp(items, user) {
  const heap = new MinHeap((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || a.sla_due_at.localeCompare(b.sla_due_at) || a.received_at.localeCompare(b.received_at));
  for (const t of items) if (OPEN.has(t.status) && (!t.assignee || t.assignee === user.username)) heap.push(t);
  return heap.peek()?.id || null;
}

async function listTickets(db, url, user) {
  const all = await loadTickets(db);
  const sp = url.searchParams;
  const view = VIEWS[sp.get('view')] ? sp.get('view') : 'inbox';
  const { filters, text } = parseQuery(sp.get('q') || '');
  for (const k of ['status', 'priority', 'label', 'flag', 'assignee', 'lane']) if (sp.get(k)) (filters[k] ||= []).push(...sp.get(k).toLowerCase().split(','));
  let items = all.filter((t) => VIEWS[view](t, user));
  if (text) {
    const ix = new InvertedIndex();
    for (const t of items) ix.add(t.id, t._text);
    const hits = ix.search(text);
    items = items.filter((t) => hits.has(t.id));
  }
  const facetBase = items;
  items = applyFilters(items, filters, user);
  const sort = SORTS[sp.get('sort')] ? sp.get('sort') : 'priority';
  items = sortBy(items, [...SORTS[sort], { get: (t) => t.received_at }]);
  const size = Math.min(Number(sp.get('size')) || 25, 100);
  const page = Math.max(Number(sp.get('page')) || 1, 1);
  const counts = Object.fromEntries(Object.keys(VIEWS).map((v) => [v, all.filter((t) => VIEWS[v](t, user)).length]));
  const labelCounts = facets(all.filter((t) => OPEN.has(t.status) || t.status === 'pending_customer'), ['label']).label;
  return {
    view, sort, page, size, total: items.length,
    items: items.slice((page - 1) * size, page * size).map(({ _text, ...t }) => t),
    facets: facets(facetBase, ['status', 'priority', 'label', 'flags']),
    counts, label_counts: labelCounts, next_up: nextUp(all, user), demo_now: DEMO_NOW,
  };
}

async function ticketDetail(db, id, user) {
  const c = (await db.query('select c.*, cu.name as customer_name, cu.payment_terms, cu.credit_limit, cu.open_balance, cu.status as customer_status from cases c left join customers cu using (customer_id) where email_id=$1', [id])).rows[0];
  if (!c) throw httpErr(404, 'Ticket not found.');
  const e = (await db.query('select * from emails where email_id=$1', [id])).rows[0];
  const [a, m, o, users] = await Promise.all([
    db.query('select * from audit_events where email_id=$1 order by id', [id]),
    db.query('select m.*, u.display_name from comments m left join users u on u.username=m.author where email_id=$1 order by id', [id]),
    db.query('select * from outbox where email_id=$1 order by id', [id]),
    db.query('select username, display_name, role from users order by username'),
  ]);
  return {
    ...c, email: e, audit: a.rows, comments: m.rows, outbox: o.rows, users: users.rows,
    can: { approve: CAN.approve(user, c) && c.erp_status !== 'committed' && ['order', 'change', 'cancel'].includes(c.proposal.kind) && !['resolved', 'closed'].includes(c.status), reset: CAN.reset(user) },
  };
}

async function stock(db) {
  const rows = (await db.query("select p.sku, p.name, p.category, p.sell_uom, i.on_hand, i.allocated, i.available, coalesce((select sum(qty) from incoming_supply s where s.sku=p.sku),0)::int as incoming, (select min(expected_date) from incoming_supply s where s.sku=p.sku) as next_in from products p join inventory i using (sku) where p.status='ACTIVE' order by p.sku")).rows;
  const open = (await db.query("select email_id, ticket_no, proposal from cases where erp_status='none' and status in ('new','open','pending_customer')")).rows;
  const demand = new Map();
  for (const t of open) for (const o of t.proposal.orders || []) for (const l of o.lines) {
    const d = demand.get(l.sku) || { qty: 0, tickets: [] };
    d.qty += l.qty; d.tickets.push(t.ticket_no); demand.set(l.sku, d);
  }
  return rows.map((r) => ({ ...r, pending_demand: demand.get(r.sku)?.qty || 0, pending_tickets: demand.get(r.sku)?.tickets || [], short_by: Math.max(0, (demand.get(r.sku)?.qty || 0) - r.available) }));
}

export async function results(db) {
  let golden = {};
  try { golden = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'golden_labels.json'), 'utf8')).emails.map((g) => [g.email_id, g])); } catch { /* optional */ }
  const rows = (await db.query('select c.email_id, c.ticket_no, c.intent, c.lane, c.status, c.erp_status, c.model, cu.name as customer_name, c.summary from cases c left join customers cu using (customer_id) order by c.ticket_no')).rows;
  const per = rows.map((r) => ({ ...r, expected_lane: golden[r.email_id]?.expected_lane || null, expected_intent: golden[r.email_id]?.intent || null }));
  const scored = per.filter((r) => r.expected_lane);
  const laneMatch = scored.filter((r) => r.lane === r.expected_lane).length;
  const intentMatch = scored.filter((r) => r.intent === r.expected_intent).length;
  const unsafe = scored.filter((r) => r.lane === 'auto_committed' && r.expected_lane !== 'auto_committed').length;
  const missedAuto = scored.filter((r) => r.expected_lane === 'auto_committed' && r.lane !== 'auto_committed').length;
  const committed = (await db.query("select coalesce(sum(l.qty_ordered*l.unit_price),0) as v, count(distinct o.so_number)::int as n from sales_orders o join sales_order_lines l using (so_number) where o.source_email is not null")).rows[0];
  return { emails: rows.length, lanes: facets(rows, ['lane']).lane, intents: facets(rows, ['intent']).intent, scored: scored.length, lane_agreement: laneMatch, intent_agreement: intentMatch, unsafe_auto_commits: unsafe, missed_auto_commits: missedAuto, orders_written: committed.n, value_written: money(Number(committed.v)), model: rows[0]?.model || 'rules', per };
}

// ---------- router ----------
export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const cid = crypto.randomUUID().slice(0, 8);
  let db;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (req.method !== 'GET' && !sameOrigin(req)) throw httpErr(403, 'Cross-site request refused.');
    db = await getDb();
    await ensureReady(db);
    const secure = isSecure(req);
    const cname = cookieName(secure);
    const token = readCookie(req, cname);

    // Machine calls: a mail provider posting new mail, or a scheduler draining the queue.
    if ((p === '/api/inbound' && req.method === 'POST') || p === '/api/agent/run') {
      if (bearerOk(req)) {
        if (p === '/api/inbound') return send(res, 202, await ingest(db, await readBody(req), 'inbound'));
        inBackground(db);
        return send(res, 202, await queueStatus(db));
      }
      if (p === '/api/inbound') throw httpErr(401, 'Missing or wrong token.');
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await login(db, str(b.username, 64), str(b.password, 256));
      if (r.error) return send(res, r.status, { error: r.error });
      await audit(db, r.user.username, 'human', null, 'signed_in', {});
      return send(res, 200, { user: r.user }, { 'set-cookie': `${cname}=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_ABSOLUTE_MS / 1000}${secure ? '; Secure' : ''}` });
    }
    const user = await sessionUser(db, token);
    if (p === '/api/logout' && req.method === 'POST') {
      await logout(db, token);
      return send(res, 200, { ok: true }, { 'set-cookie': `${cname}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}` });
    }
    if (!user) throw httpErr(401, 'Please sign in.');

    if (p === '/api/me') return send(res, 200, { user, model: llmModel(), auto_commit: AUTO_COMMIT, durable: db.durable, demo_now: DEMO_NOW });
    if (p === '/api/tickets' && req.method === 'GET') return send(res, 200, { ...(await listTickets(db, url, user)), queue: await queueStatus(db) });
    if (p === '/api/agent/status') return send(res, 200, await queueStatus(db));
    if (p === '/api/agent/run' && req.method === 'POST') {
      const s = await queueStatus(db);
      if (s.pending) inBackground(db);
      return send(res, 202, s);
    }
    if (p === '/api/emails' && req.method === 'POST') return send(res, 202, await ingest(db, await readBody(req), user.username));
    if (p === '/api/stock') return send(res, 200, await stock(db));
    if (p === '/api/results') return send(res, 200, await results(db));
    if (p === '/api/catalog') return send(res, 200, (await db.query("select p.sku, p.name, p.sell_uom, p.pack, p.list_price, p.status, i.available from products p join inventory i using (sku) order by sku")).rows);
    if (p === '/api/audit') {
      const { text } = parseQuery(url.searchParams.get('q') || '');
      let rows = (await db.query('select a.*, c.ticket_no from audit_events a left join cases c using (email_id) order by a.id desc limit 1000')).rows;
      if (text) { const ix = new InvertedIndex(); rows.forEach((r, i) => ix.add(i, `${r.actor} ${r.actor_type} ${r.action} ${r.ticket_no || ''} ${r.email_id || ''} ${JSON.stringify(r.detail)}`)); const hits = ix.search(text); rows = rows.filter((_, i) => hits.has(i)); }
      const actorType = url.searchParams.get('actor_type');
      if (actorType) rows = rows.filter((r) => r.actor_type === actorType);
      return send(res, 200, rows.slice(0, 300));
    }
    if (p === '/api/admin/reset' && req.method === 'POST') {
      if (!CAN.reset(user)) throw httpErr(403, 'Only an Admin can reset the demo.');
      await db.query("delete from app_meta where k='seed:v2'");
      ready = false;
      await ensureReady(db);
      return send(res, 200, { ok: true, queue: await queueStatus(db) });
    }

    const m = p.match(/^\/api\/tickets\/(E\d{3})(?:\/([a-z_]+))?$/);
    if (m) {
      const [, id, action] = m;
      if (!action && req.method === 'GET') return send(res, 200, await ticketDetail(db, id, user));
      if (req.method !== 'POST') throw httpErr(405, 'Method not allowed.');
      const b = await readBody(req);
      const t = (await db.query('select * from cases where email_id=$1', [id])).rows[0];
      if (!t) throw httpErr(404, 'Ticket not found.');
      const touch = async (status) => db.query("update cases set status=$2, assignee=coalesce(assignee,$3), row_version=row_version+1, updated_at=now() where email_id=$1", [id, status, user.username]);
      if (action === 'approve') {
        if (!CAN.approve(user, t)) throw httpErr(403, t.flags.some((f) => f.code === 'SECURITY_INJECTION') ? 'This ticket has a security flag. Only an Admin can approve it.' : 'Credit and price exceptions need the Credit and AR role.');
        try {
          const r = await commitProposal(db, id, { actor: user.username, actorType: 'human', role: user.role, orders: Array.isArray(b.orders) ? b.orders : undefined, reason: str(b.reason, 500), creditOverride: Boolean(b.credit_override), expectedVersion: b.row_version });
          await db.query('update cases set assignee=coalesce(assignee,$2) where email_id=$1', [id, user.username]);
          return send(res, 200, r);
        } catch (e) {
          if (e.audit) await audit(db, user.username, 'human', id, 'commit_refused', { errors: e.audit.errors });
          throw e;
        }
      }
      if (action === 'reject') {
        const reason = str(b.reason, 500);
        if (!reason) throw httpErr(422, 'Add a short reason so the next person knows why.');
        if (t.erp_status === 'committed') throw httpErr(409, 'This is already in the ERP. Open a cancellation instead.');
        await db.query("update cases set status='closed', assignee=coalesce(assignee,$2), row_version=row_version+1 where email_id=$1", [id, user.username]);
        await audit(db, user.username, 'human', id, 'rejected', { reason });
        return send(res, 200, { ok: true });
      }
      if (action === 'assign') {
        const who = b.assignee === 'me' ? user.username : b.assignee ? str(b.assignee, 32) : null;
        if (who && !(await db.query('select 1 from users where username=$1', [who])).rows.length) throw httpErr(422, 'Unknown user.');
        await db.query("update cases set assignee=$2, status=case when status='new' then 'open' else status end, row_version=row_version+1 where email_id=$1", [id, who]);
        await audit(db, user.username, 'human', id, who ? 'assigned' : 'unassigned', { to: who });
        return send(res, 200, { ok: true });
      }
      if (action === 'status') {
        const s = str(b.status, 20);
        if (!['open', 'pending_customer', 'resolved', 'closed'].includes(s)) throw httpErr(422, 'Unknown status.');
        await touch(s);
        await audit(db, user.username, 'human', id, 'status_changed', { from: t.status, to: s, note: str(b.reason, 500) || null });
        return send(res, 200, { ok: true });
      }
      if (action === 'comment') {
        const body = str(b.body, 4000);
        if (!body) throw httpErr(422, 'Write a note first.');
        await db.query('insert into comments (email_id, author, body) values ($1,$2,$3)', [id, user.username, body]);
        if (t.status === 'new') await touch('open');
        await audit(db, user.username, 'human', id, 'note_added', { length: body.length });
        return send(res, 200, { ok: true });
      }
      if (action === 'reply') {
        const body = str(b.body, 8000);
        if (!body) throw httpErr(422, 'The reply is empty.');
        const e = (await db.query('select from_email, subject from emails where email_id=$1', [id])).rows[0];
        await db.query('insert into outbox (email_id, to_email, subject, body, sent_by) values ($1,$2,$3,$4,$5)', [id, e.from_email, `Re: ${e.subject}`, body, user.username]);
        const next = t.erp_status === 'committed' ? 'resolved' : 'pending_customer';
        await touch(next);
        await audit(db, user.username, 'human', id, 'reply_queued', { to: e.from_email, next_status: next });
        return send(res, 200, { ok: true, status: next });
      }
      throw httpErr(404, 'Unknown action.');
    }
    throw httpErr(404, 'Not found.');
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(cid, e);
    return send(res, e.status || 500, { error: e.status ? e.message : `Something went wrong on our side. Reference ${cid}.` });
  }
}
