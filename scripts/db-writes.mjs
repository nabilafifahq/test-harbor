// Runs every user action on the Order Desk against a fresh local database (same code and schema as production)
// and prints which tables, rows and columns each action changes. Results are in docs/07-database-writes.md.
//   MODE=replay (default)  recorded DeepSeek readings, every user action on the 40 emails
//   MODE=model             new mail, webhook and agent run, needs test/fake-model.mjs on port 3600
//   MODE=dead              what is written when the model is unreachable
//   OUT=file.json          also write the results as JSON
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-writes-'));
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.LLM_MODE; delete process.env.AGENT_REPLAY;
const MODE = process.env.MODE || 'replay';
if (MODE === 'dead') { process.env.LLM_BASE_URL = 'http://localhost:3999/v1'; process.env.LLM_MODEL = 'fake'; process.env.LLM_API_KEY = 'x'; } else if (MODE === 'model') { process.env.LLM_BASE_URL = 'http://localhost:3600/v1'; process.env.LLM_MODEL = 'fake'; process.env.LLM_API_KEY = 'local-fake'; }
else { delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; }
process.env.CRON_SECRET = 'local-cron';
process.env.DEMO_PASSWORD = 'pw';

const { handle } = await import(`${REPO}/src/app.js`);
const { getDb } = await import(`${REPO}/src/db.js`);
const server = http.createServer(handle).listen(3700);
const base = 'http://localhost:3700';
const db = await getDb();

const TABLES = ['customers', 'customer_contacts', 'ship_to_addresses', 'products', 'customer_prices', 'inventory', 'incoming_supply', 'sales_orders', 'sales_order_lines',
  'emails', 'agent_reads', 'cases', 'comments', 'outbox', 'audit_events', 'users', 'sessions', 'app_meta'];
let PK = {};
async function loadPks() {
  const r = await db.query(`select tc.table_name, kcu.column_name, kcu.ordinal_position from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_name = kcu.table_name
    where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' order by kcu.ordinal_position`);
  PK = {};
  for (const x of r.rows) (PK[x.table_name] ||= []).push(x.column_name);
}
async function snap() {
  const out = {};
  for (const t of TABLES) {
    let rows;
    try { rows = (await db.query(`select * from ${t}`)).rows; } catch { continue; }
    const m = new Map();
    for (const row of rows) {
      const key = PK[t] ? PK[t].map((c) => String(row[c])).join('|') : JSON.stringify(row);
      m.set(key, row);
    }
    out[t] = m;
  }
  return out;
}
const norm = (v) => JSON.stringify(v instanceof Date ? v.toISOString() : v);
function diff(a, b) {
  const res = {};
  for (const t of TABLES) {
    const A = a[t] || new Map(), B = b[t] || new Map();
    const ins = [], del = [], upd = {};
    for (const [k, row] of B) {
      if (!A.has(k)) ins.push(k);
      else {
        const cols = Object.keys(row).filter((c) => norm(row[c]) !== norm(A.get(k)[c]));
        if (cols.length) { const sig = cols.sort().join(', '); (upd[sig] ||= []).push(k); }
      }
    }
    for (const k of A.keys()) if (!B.has(k)) del.push(k);
    if (ins.length || del.length || Object.keys(upd).length) res[t] = { inserted: ins.length, deleted: del.length, updated: Object.fromEntries(Object.entries(upd).map(([c, ks]) => [c, ks.length])), ins_keys: ins.slice(0, 6), upd_keys: Object.values(upd).flat().slice(0, 6), ins_keys_all: ins, upd_all: Object.values(upd).flat() };
  }
  return res;
}

const jars = {};
async function call(user, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(jars[user] ? { cookie: jars[user] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) jars[user] = sc.split(';')[0];
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const waitQueue = async () => { for (let i = 0; i < 120; i++) { const s = (await call('x', 'GET', '/api/status')).data; if (s && !s.pending) return s; await new Promise((r) => setTimeout(r, 1000)); } throw new Error('queue stuck'); };

const results = [];
async function step(name, who, fn) {
  const before = await snap();
  let r; try { r = await fn(); } catch (e) { r = { status: 'error', data: String(e) }; }
  await new Promise((ok) => setTimeout(ok, 300));
  const after = await snap();
  const d = diff(before, after);
  results.push({ name, who, http: r?.status, response: r?.data && typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 200) : r?.data, writes: d });
  console.log(`\n### ${name} [${who}] -> HTTP ${r?.status}`);
  for (const [t, x] of Object.entries(d)) console.log(`  ${t}: +${x.inserted} -${x.deleted}${Object.keys(x.updated).length ? ' ~' + JSON.stringify(x.updated) : ''}${x.ins_keys.length ? ' new=' + x.ins_keys.join(',') : ''}${x.upd_keys.length ? ' changed=' + x.upd_keys.join(',') : ''}`);
  if (!Object.keys(d).length) console.log('  (no writes)');
  const extra = [];
  for (const k of d.audit_events?.ins_keys_all || []) { const a = after.audit_events.get(k); extra.push(`audit ${a.actor_type}:${a.actor} ${a.action}${a.email_id ? ' ' + a.email_id : ''}`); }
  for (const k of d.cases?.upd_all || []) { const A = before.cases.get(k), B = after.cases.get(k); const ch = ['status', 'erp_status', 'assignee', 'lane'].filter((c) => A[c] !== B[c]).map((c) => `${c} ${A[c]}->${B[c]}`); extra.push(`cases ${k}: ${ch.join(', ') || 'no state change'}`); }
  for (const k of d.cases?.ins_keys_all || []) { const B = after.cases.get(k); extra.push(`cases ${k} new: lane ${B.lane}, status ${B.status}, erp ${B.erp_status}, kind ${B.proposal.kind}`); }
  for (const k of d.sales_orders?.ins_keys_all || []) { const B = after.sales_orders.get(k); extra.push(`sales_orders ${k}: ${B.customer_id} ${B.ship_to_id} status ${B.status} by ${B.created_by} from ${B.source_email}`); }
  for (const k of d.sales_orders?.upd_all || []) extra.push(`sales_orders ${k}: status ${before.sales_orders.get(k).status}->${after.sales_orders.get(k).status}`);
  for (const k of d.sales_order_lines?.upd_all || []) extra.push(`sales_order_lines ${k}: qty_ordered ${before.sales_order_lines.get(k).qty_ordered}->${after.sales_order_lines.get(k).qty_ordered}`);
  for (const k of d.inventory?.upd_all || []) { const A = before.inventory.get(k), B = after.inventory.get(k); extra.push(`inventory ${k}: allocated ${A.allocated}->${B.allocated}, available ${A.available}->${B.available}`); }
  for (const k of d.users?.upd_all || []) { const A = before.users.get(k), B = after.users.get(k); extra.push(`users ${k}: failed_count ${A.failed_count}->${B.failed_count}, locked_until ${A.locked_until ? 'set' : 'null'}->${B.locked_until ? 'set' : 'null'}`); }
  if (extra.length) console.log('    ' + extra.slice(0, 14).join('\n    '));
  results[results.length - 1].detail = extra;
  return r;
}


// ---- first load: seed, queue, reads, checks, auto-commit (system, no user) ----
await call('x', 'GET', '/api/status');
const qs = await waitQueue();
await loadPks();
const after0 = await snap();
console.log(`### First request after deploy (${MODE}): seed + agent run`, JSON.stringify({ reader: qs.reader, processed: qs.processed, lanes: qs.lanes }));
console.log('  rows: ' + TABLES.map((t) => `${t} ${after0[t]?.size ?? '-'}`).join(', '));
const seedAudit = (await db.query("select action, actor_type, count(*)::int n from audit_events group by 1,2 order by 1")).rows;
console.log('  audit at seed: ' + seedAudit.map((r) => `${r.actor_type}:${r.action} ${r.n}`).join(', '));
const agentSo = (await db.query("select so_number, source_email, created_by, status from sales_orders where source_email is not null order by 1")).rows;
console.log('  orders written by the agent at seed: ' + agentSo.map((r) => `${r.so_number}<-${r.source_email} (${r.created_by}, ${r.status})`).join(', '));
const reads = (await db.query("select status, model, count(*)::int n from agent_reads group by 1,2")).rows;
console.log('  agent_reads: ' + reads.map((r) => `${r.status}/${r.model} ${r.n}`).join(', '));
const cases = Object.fromEntries((await db.query('select * from cases order by email_id')).rows.map((c) => [c.email_id, c]));
console.log('  cases: ' + Object.values(cases).map((c) => `${c.email_id} ${c.lane}/${c.proposal.kind || '-'}/${c.intent}/${c.approver_role}/${c.status}/${c.erp_status}`).join('\n         '));

await call('ops', 'POST', '/api/login', { username: 'ops', password: 'pw' });
await call('credit', 'POST', '/api/login', { username: 'credit', password: 'pw' });
await call('admin', 'POST', '/api/login', { username: 'admin', password: 'pw' });

if (MODE === 'model') {
  await step('New email typed in the console (clean order)', 'ops', async () => { const r = await call('ops', 'POST', '/api/emails', { from_email: 'maria@bluefinbistro.example', from_name: 'Maria Lopez', subject: 'Top up', body: 'Hi, please send HPS-1408 x 2 for Thursday. PO BB-9001. Thanks, Maria' }); await waitQueue(); return r; });
  await step('New email typed in the console (unknown sender)', 'ops', async () => { const r = await call('ops', 'POST', '/api/emails', { from_email: 'owner@newcafe.example', from_name: 'New Cafe', subject: 'Prices?', body: 'Do you deliver cups and lids to Bayside? What do 12oz cups cost?' }); await waitQueue(); return r; });
  await step('Inbound webhook with a raw .eml (mail provider)', 'system', async () => {
    const raw = 'From: Maria Lopez <maria@bluefinbistro.example>\r\nSubject: Need gloves\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nPlease send 1 case of HPS-1201 to the usual address. Maria';
    const res = await fetch(base + '/api/inbound', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-cron' }, body: JSON.stringify({ raw }) });
    await waitQueue(); return { status: res.status, data: await res.json() };
  });
  await step('Run the agent now (button or cron) with nothing pending', 'admin', () => call('admin', 'POST', '/api/agent/run', {}));
} else if (MODE !== 'dead') {
  await step('Sign in with a wrong password', 'ops', () => call('bad', 'POST', '/api/login', { username: 'ops', password: 'nope' }));
  await step('Sign in', 'ops', () => call('ops2', 'POST', '/api/login', { username: 'ops', password: 'pw' }));
  await step('Open queue, ticket, stock, audit, results pages', 'ops', async () => { await call('ops', 'GET', '/api/tickets?view=inbox'); await call('ops', 'GET', '/api/tickets/E005'); await call('ops', 'GET', '/api/stock'); await call('ops', 'GET', '/api/audit'); return call('ops', 'GET', '/api/results'); });
  await step('Assign to me (E005)', 'ops', () => call('ops', 'POST', '/api/tickets/E005/assign', { assignee: 'me' }));
  await step('Assign to Credit, then unassign (E007)', 'ops', async () => { await call('ops', 'POST', '/api/tickets/E007/assign', { assignee: 'credit' }); return call('ops', 'POST', '/api/tickets/E007/assign', { assignee: null }); });
  await step('Internal note (E002)', 'ops', () => call('ops', 'POST', '/api/tickets/E002/comment', { body: 'Checked with the warehouse, fine to ship Thursday.' }));
  await step('Preview an edited order (E006)', 'credit', () => call('credit', 'POST', '/api/tickets/E006/preview', { orders: cases.E006.proposal.orders }));
  await step('Operations approves a credit-blocked order (E006)', 'ops', () => call('ops', 'POST', '/api/tickets/E006/approve', {}));
  await step('Operations approves the injection ticket (E012)', 'ops', () => call('ops', 'POST', '/api/tickets/E012/approve', {}));
  await step('Credit approves with an edit and a credit release (E006)', 'credit', () => { const o = cases.E006.proposal.orders[0]; return call('credit', 'POST', '/api/tickets/E006/approve', { orders: [{ ship_to_id: o.ship_to_id, lines: o.lines.map((l, i) => ({ sku: l.sku, qty: i === 0 ? Math.max(1, l.qty - 1) : l.qty })) }], credit_override: true, reason: 'Customer paid by card this morning.' }); });
  await step('Reject a draft (E019, discontinued item)', 'ops', () => call('ops', 'POST', '/api/tickets/E019/reject', { reason: 'Customer to choose the successor item.' }));
  // sweep: the natural action on every remaining ticket
  const done = new Set(['E006', 'E019']);
  const who = (c) => (c.approver_role === 'admin' ? 'admin' : c.approver_role === 'credit' ? 'credit' : 'ops');
  for (const c of Object.values(cases)) {
    if (done.has(c.email_id)) continue;
    const k = c.proposal.kind;
    if (c.lane === 'auto_committed' || c.lane === 'no_action') continue;
    if (c.lane === 'waiting_on_customer') { await step(`Ask the customer (${c.email_id}, ${c.intent})`, 'ops', () => call('ops', 'POST', `/api/tickets/${c.email_id}/reply`, { body: (c.proposal.questions || [])[0] || 'Could you confirm the details?' })); continue; }
    if (['order', 'change', 'cancel'].includes(k)) {
      const flags = c.flags.map((f) => f.code).join(' ');
      const body = c.approver_role === 'credit' ? { credit_override: /CREDIT_BLOCK/.test(flags), reason: 'Checked by Credit and AR.' } : {};
      await step(`Approve and write to ERP (${c.email_id}, ${k}, flags: ${flags || 'none'})`, who(c), () => call(who(c), 'POST', `/api/tickets/${c.email_id}/approve`, body));
      continue;
    }
    if (k === 'quote') { await step(`Approve a quote (${c.email_id})`, 'ops', () => call('ops', 'POST', `/api/tickets/${c.email_id}/approve`, {})); await step(`Reply with the quote (${c.email_id})`, 'ops', () => call('ops', 'POST', `/api/tickets/${c.email_id}/reply`, { body: 'Here are your prices.' })); continue; }
    if (c.intent === 'complaint') { await step(`Resolve a complaint (${c.email_id})`, who(c), () => call(who(c), 'POST', `/api/tickets/${c.email_id}/status`, { status: 'resolved', reason: 'Credit note issued in AR.' })); continue; }
    await step(`Reply on a routed ticket (${c.email_id}, ${c.intent})`, who(c), () => call(who(c), 'POST', `/api/tickets/${c.email_id}/reply`, { body: 'Thanks, we are on it.' }));
  }
  await step('Approve the same ticket again (E005)', 'ops', () => call('ops', 'POST', '/api/tickets/E005/approve', {}));
  await step('Reject a ticket already written to ERP (E001)', 'ops', () => call('ops', 'POST', '/api/tickets/E001/reject', { reason: 'test' }));
  await step('Set status by hand: reopen a resolved complaint (E027 open)', 'credit', () => call('credit', 'POST', '/api/tickets/E027/status', { status: 'open' }));
  await step('Set status by hand: close a closed no-action ticket (E029)', 'ops', () => call('ops', 'POST', '/api/tickets/E029/status', { status: 'closed' }));
  await step('Sign out', 'ops', () => call('ops2', 'POST', '/api/logout', {}));
  await step('Five wrong passwords in a row', 'credit', async () => { let r; for (let i = 0; i < 5; i++) r = await call('bad2', 'POST', '/api/login', { username: 'credit', password: 'x' + i }); return r; });
  await step('Reset the demo', 'admin', async () => { const r = await call('admin', 'POST', '/api/admin/reset', {}); await waitQueue(); return r; });
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ cases: Object.values(cases).map((c) => ({ id: c.email_id, lane: c.lane, kind: c.proposal.kind, intent: c.intent, role: c.approver_role })), results }, null, 2));
server.close();
process.exit(0);
