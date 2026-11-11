// The agent works inside the ERP only through the read-only tools in makeTools().
// It writes a draft (the proposal) and a ticket. Nothing reaches the ERP except through
// commitProposal(), which is plain code that re-checks price, stock, credit and status in one transaction.
import { extract } from './extract.js';
import { readingToExtraction } from './model-agent.js';
import { bm25, editDistance, productTokens } from './algo.js';

export const BUSINESS_DATE = process.env.BUSINESS_DATE || '2026-11-02';
export const DEMO_NOW = process.env.DEMO_NOW || '2026-11-02T12:00:00-05:00';
const WEEKDAY = { monday: '2026-11-02', tuesday: '2026-11-03', wednesday: '2026-11-04', thursday: '2026-11-05', friday: '2026-11-06', saturday: '2026-11-07', sunday: '2026-11-08' };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const HEADS = ['glove', 'towel', 'tissue', 'toilet', 'liner', 'cleaner', 'spray', 'soap', 'sanitizer', 'clamshell', 'cup', 'lid', 'straw', 'napkin', 'cutlery', 'kit', 'foil', 'film', 'filter', 'bag'];
const num = (v) => (v === null || v === undefined ? null : Number(v));
const money = (v) => Math.round(v * 100) / 100;
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const SLA_HOURS = { urgent: 1, high: 4, normal: 8, low: 24 };

// ---------- read-only tools: the agent's only window into the ERP ----------
export function makeTools(q, trace) {
  const call = async (tool, input, fn) => { const output = await fn(); trace.push({ tool, input, output }); return output; };
  return {
    find_contact: (email) => call('find_contact', { email }, async () => (await q.query('select cc.*, c.name as customer_name, c.status from customer_contacts cc join customers c using (customer_id) where lower(cc.email)=lower($1)', [email])).rows[0] || null),
    find_customer_by_domain: (email) => call('find_customer_by_domain', { email }, async () => {
      const domain = email.split('@')[1]?.toLowerCase();
      if (!domain || domain === 'mail.example') return null;
      const r = await q.query("select distinct cc.customer_id, c.name from customer_contacts cc join customers c using (customer_id) where lower(split_part(cc.email,'@',2))=$1", [domain]);
      return r.rows.length === 1 ? r.rows[0] : null;
    }),
    get_customer: (id) => call('get_customer', { customer_id: id }, async () => {
      const c = (await q.query('select * from customers where customer_id=$1', [id])).rows[0];
      return c && { ...c, credit_limit: num(c.credit_limit), open_balance: num(c.open_balance) };
    }),
    get_ship_tos: (id) => call('get_ship_tos', { customer_id: id }, async () => (await q.query('select ship_to_id, name, address, is_default from ship_to_addresses where customer_id=$1 order by ship_to_id', [id])).rows),
    get_product: (sku) => call('get_product', { sku }, () => productBySku(q, sku)),
    match_product: (phrase, matcher) => call('match_product', { phrase }, async () => matcher.match(phrase)),
    get_price: (customerId, sku) => call('get_price', { customer_id: customerId, sku }, () => priceFor(q, customerId, sku)),
    get_incoming: (sku) => call('get_incoming', { sku }, async () => (await q.query('select supplier_po, qty, expected_date from incoming_supply where sku=$1', [sku])).rows.map((r) => ({ ...r, expected_date: toDate(r.expected_date) }))),
    get_credit: (id) => call('get_credit', { customer_id: id }, () => creditPosition(q, id)),
    find_order: (id, ref) => call('find_order', { customer_id: id, ref }, async () => {
      const o = (await q.query('select * from sales_orders where customer_id=$1 and (so_number=$2 or customer_po=$2)', [id, ref])).rows[0];
      if (!o) return null;
      const lines = (await q.query('select line_no, sku, qty_ordered, qty_shipped, unit_price from sales_order_lines where so_number=$1 order by line_no', [o.so_number])).rows.map((l) => ({ ...l, unit_price: num(l.unit_price) }));
      return { ...o, order_date: toDate(o.order_date), lines };
    }),
    last_orders: (id, n = 2) => call('last_orders', { customer_id: id, n }, async () => {
      // "Usual" means orders placed before today, not ones this inbox created this morning.
      const os = (await q.query("select so_number, order_date from sales_orders where customer_id=$1 and order_date < $3 and status <> 'CANCELLED' order by order_date desc limit $2", [id, n, BUSINESS_DATE])).rows;
      const out = [];
      for (const o of os) out.push({ so_number: o.so_number, order_date: toDate(o.order_date), lines: (await q.query('select sku, qty_ordered from sales_order_lines where so_number=$1 order by line_no', [o.so_number])).rows });
      return out;
    }),
  };
}

async function productBySku(q, sku) {
  const p = (await q.query('select p.*, i.available from products p left join inventory i using (sku) where p.sku=$1', [sku])).rows[0];
  return p ? { ...p, list_price: num(p.list_price), available: num(p.available) } : null;
}

export async function priceFor(q, customerId, sku) {
  const rows = (await q.query('select unit_price, valid_from, valid_to from customer_prices where customer_id=$1 and sku=$2 order by valid_to desc', [customerId, sku])).rows;
  const valid = rows.find((r) => toDate(r.valid_from) <= BUSINESS_DATE && BUSINESS_DATE <= toDate(r.valid_to));
  const expired = rows.find((r) => toDate(r.valid_to) < BUSINESS_DATE);
  const lp = num((await q.query('select list_price from products where sku=$1', [sku])).rows[0]?.list_price);
  if (valid) return { unit_price: num(valid.unit_price), source: 'contract', valid_to: toDate(valid.valid_to) };
  return { unit_price: lp, source: 'list', expired_contract: expired ? { unit_price: num(expired.unit_price), valid_to: toDate(expired.valid_to) } : null };
}

export async function creditPosition(q, id) {
  const c = (await q.query('select credit_limit, open_balance, status from customers where customer_id=$1', [id])).rows[0];
  const open = await q.query("select coalesce(sum((l.qty_ordered-l.qty_shipped)*l.unit_price),0) as v from sales_orders o join sales_order_lines l using (so_number) where o.customer_id=$1 and o.status in ('OPEN','PARTIALLY_SHIPPED')", [id]);
  return { status: c.status, credit_limit: num(c.credit_limit), open_balance: num(c.open_balance), open_orders_value: money(num(open.rows[0].v)) };
}

// ---------- product matcher: exact SKU, then edit distance, then BM25 over names ----------
export async function buildMatcher(q) {
  const products = (await q.query('select sku, name, category, pack, sell_uom, status, replaced_by from products order by sku')).rows;
  const index = bm25(products.map((p) => ({ id: p.sku, text: `${p.name} ${p.category}` })));
  return {
    products,
    // Candidates for the model's search_products tool: exact or near SKU first, then BM25 by words.
    search(query, k = 5) {
      const view = (sku) => { const p = products.find((x) => x.sku === sku); return p && { sku: p.sku, name: p.name, category: p.category, pack: p.pack, sell_uom: p.sell_uom, status: p.status, replaced_by: p.replaced_by || null }; };
      const code = query.match(/[A-Z]{2,4}-\d{3,5}/i)?.[0];
      const bySku = code ? [code.toUpperCase(), ...this.nearestSkus(code)].filter((s, i, a) => a.indexOf(s) === i && products.some((p) => p.sku === s)) : [];
      const byText = index.score(query).filter((r) => r.score > 0).slice(0, k).map((r) => r.id);
      return [...new Set([...bySku, ...byText])].slice(0, k).map(view);
    },
    nearestSkus(code) {
      return products.map((p) => ({ sku: p.sku, d: editDistance(code.toUpperCase(), p.sku) })).filter((x) => x.d <= 1).map((x) => x.sku);
    },
    match(phrase) {
      const qt = productTokens(phrase);
      const qHeads = HEADS.filter((h) => qt.includes(h) || (h === 'liner' && qt.includes('trash')));
      if (!qHeads.length) return { sku: null, reason: 'no product noun' };
      const ranked = index.score(phrase).map((r) => {
        const dHeads = HEADS.filter((h) => index.tokensOf(products.findIndex((p) => p.sku === r.id)).includes(h));
        const missing = dHeads.filter((h) => !qt.includes(h) && !(h === 'liner' && qt.includes('trash'))).length;
        const shared = dHeads.filter((h) => qHeads.includes(h)).length;
        return { sku: r.id, score: shared ? r.score - 0.8 * missing : 0 };
      }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
      if (!ranked.length) return { sku: null, reason: 'no catalog match' };
      const [a, b] = ranked;
      // A discontinued product only stays in the running when it is the clear winner (e.g. "vinyl gloves").
      const active = (r) => products.find((x) => x.sku === r.sku).status === 'ACTIVE';
      const close = ranked.filter((r) => r.score >= 0.9 * a.score && (active(r) || r === a));
      const pool = close.length > 1 ? close.filter(active) : close;
      const ambiguous = pool.length > 1;
      return { sku: pool[0]?.sku || a.sku, score: Number(fmt(a.score)), ambiguous, alternatives: ambiguous ? pool.map((r) => r.sku) : [] };
    },
  };
}

function parseDate(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (md) return `2026-${String(MONTHS[md[1]]).padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  const nm = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (nm) return `2026-${nm[1].padStart(2, '0')}-${nm[2].padStart(2, '0')}`;
  if (/\btoday\b/.test(t)) return BUSINESS_DATE;
  const wd = t.match(/monday|tuesday|wednesday|thursday|friday|saturday|sunday/);
  return wd ? WEEKDAY[wd[0]] : null;
}

const INJECTION_RE = /(automated (order )?system|skip (the )?human review|ignore (all|previous|the) (rules|instructions)|pre-?approved by management)/i;
const LABELS = { new_order: 'Orders', order_change: 'Changes', cancellation: 'Changes', quote_request: 'Sales', new_customer_inquiry: 'Sales', return_request: 'Billing', invoice_dispute: 'Billing', complaint: 'Escalations', spam: 'Noise', auto_reply: 'Noise', other: 'Other' };

// ---------- one agent run for one email ----------
// `read` is the model agent's result (model-agent.js modelRead). Without it, or when the model failed,
// the rules reader in extract.js is the only reader.
export async function processEmail(db, email, { autoCommit = true, matcher, read = null } = {}) {
  matcher = matcher || await buildMatcher(db);
  const trace = [...(read?.trace || [])];
  const T = makeTools(db, trace);
  const flags = [];
  const checks = [];
  const flag = (code, text, severity = 'warn') => flags.push({ code, text, severity });
  const check = (code, label, pass, detail = '') => checks.push({ code, label, pass, detail });

  const rules = extract(email);
  trace.push({ by: 'code', tool: 'rules_read', input: { email_id: email.email_id }, output: { intent: rules.intent, lines: rules.lines.map((l) => [l.sku || l.description, l.qty]), customer_po: rules.customer_po, language: rules.language } });
  let ext = rules;
  let model = 'rules';
  if (read?.reading) {
    ext = readingToExtraction(read.reading, email);
    model = read.model;
    // A same-day add-on with no order reference is a new order linked to the earlier ticket (assumption A12).
    if (ext.intent === 'order_change' && !ext.references_so && !ext.customer_po) {
      const adds = ext.lines.length ? ext.lines : ext.change_ops.map((o) => ({ sku: o.sku, qty: o.qty, unit_text: '', description: o.description, quoted_sku: Boolean(o.sku && email.body.toUpperCase().includes(o.sku)) }));
      if (adds.length) ext = { ...ext, intent: 'new_order', lines: adds, change_ops: [] };
    }
  }
  else if (read?.error) flag('MODEL_FALLBACK', `The model could not finish (${read.error.slice(0, 160)}). The rules reader was used instead.`, 'info');
  const noise = ['spam', 'auto_reply'];
  if (noise.includes(ext.intent) !== noise.includes(rules.intent)) ext.intent = 'other'; // both readers must agree before a case is closed unread

  if (INJECTION_RE.test(email.body) || ext.suspicious) flag('SECURITY_INJECTION', 'The email contains instructions aimed at the automated system. They were ignored and system prices kept. Admin must review.', 'bad');

  const contact = await T.find_contact(email.from_email);
  let customerId = contact?.customer_id || null;
  if (!contact) {
    const dom = await T.find_customer_by_domain(email.from_email);
    if (dom) { customerId = dom.customer_id; flag('UNVERIFIED_SENDER', `Sender is not a registered contact of ${dom.name}. Confirm with the registered contact before acting.`, 'bad'); }
    else if (!noise.includes(ext.intent)) flag('UNKNOWN_SENDER', 'Sender matches no customer. Hand over to sales as a new prospect.', 'bad');
  }
  check('C01', 'Sender is a registered contact', Boolean(contact), contact ? `${contact.name}, ${contact.role}` : email.from_email);

  const p = { kind: 'none', intent: ext.intent, customer_po: ext.customer_po, references_so: ext.references_so, orders: [], questions: [], language: ext.language };
  let lane = 'needs_review';
  let approver = 'ops';
  let customer = null;
  let requestedDate = null;

  if (noise.includes(ext.intent)) {
    lane = 'no_action';
    p.summary = ext.intent === 'spam' ? 'Marketing email. Archived without a reply.' : 'Automatic out-of-office reply. Never answered automatically, to avoid mail loops.';
  } else if (customerId) {
    customer = await T.get_customer(customerId);
    check('C02', 'Customer account is ACTIVE', customer.status === 'ACTIVE', customer.status);
    const shipTos = await T.get_ship_tos(customerId);
    requestedDate = ext.requested_date || parseDate(ext.requested_date_text);
    if (requestedDate && requestedDate < BUSINESS_DATE) { flag('DATE_IN_PAST', `Requested date ${requestedDate} has already passed.`); p.questions.push(`You asked for delivery on ${requestedDate}, which has passed. Which date works for you?`); }
    p.requested_date = requestedDate;
    if (ext.mentions_attachment && !(email.attachments || []).length) { flag('MISSING_ATTACHMENT', 'The email refers to an attachment, but none arrived.'); p.questions.push('Your email mentions an attached PO, but no attachment reached us. Could you send it again?'); }

    if (['cancellation'].includes(ext.intent)) {
      p.kind = 'cancel';
      const so = ext.customer_po || ext.references_so ? await T.find_order(customerId, ext.references_so || ext.customer_po) : null;
      p.target = so;
      if (!so) { flag('ORDER_NOT_FOUND', 'No order matches the reference in the email.'); }
      else {
        check('O01', 'Order can still be cancelled', so.status === 'OPEN', `${so.so_number} is ${so.status}`);
        p.summary = `Cancel ${so.so_number} (PO ${so.customer_po}), ${so.lines.length} lines, releases allocated stock.`;
      }
    } else if (ext.intent === 'order_change') {
      p.kind = 'change';
      const so = await T.find_order(customerId, ext.references_so || ext.customer_po);
      p.target = so;
      p.ops = [];
      if (!so) flag('ORDER_NOT_FOUND', 'No order matches the reference in the email.');
      else {
        check('O02', 'Order is editable (OPEN, or unshipped qty only)', so.status !== 'SHIPPED', `${so.so_number} is ${so.status}`);
        for (const op of ext.change_ops) {
          const m = op.sku ? { sku: op.sku } : await T.match_product(op.description, matcher);
          if (!m.sku) { p.questions.push(`Which product is "${op.description}"?`); continue; }
          const prod = await T.get_product(m.sku);
          const price = await T.get_price(customerId, m.sku);
          const existing = so.lines.find((l) => l.sku === m.sku);
          if (op.op === 'set_qty' && existing) p.ops.push({ op: 'set_qty', sku: m.sku, name: prod.name, from: existing.qty_ordered, to: op.to, stated_from: op.from, unit_price: num(existing.unit_price), delta_value: money((op.to - existing.qty_ordered) * num(existing.unit_price)), available: prod.available });
          else p.ops.push({ op: 'add_line', sku: m.sku, name: prod.name, qty: op.qty ?? op.to, unit_price: price.unit_price, price_source: price.source, delta_value: money((op.qty ?? op.to) * price.unit_price), available: prod.available });
        }
        p.summary = `Change ${so.so_number}: ${p.ops.map((o) => (o.op === 'set_qty' ? `${o.sku} ${o.from} to ${o.to}` : `add ${o.qty} x ${o.sku}`)).join(', ')}.`;
      }
    } else if (['new_order', 'quote_request', 'other'].includes(ext.intent)) {
      p.kind = ext.intent === 'quote_request' ? 'quote' : 'order';
      let lines = [...ext.lines];
      if (ext.from_history) {
        const hist = await T.last_orders(customerId, 2);
        if (hist.length) {
          const counts = new Map();
          for (const h of hist) for (const l of h.lines) counts.set(l.sku, (counts.get(l.sku) || []).concat(Number(l.qty_ordered)));
          lines = [...[...counts].filter(([, qs]) => qs.length === hist.length || hist.length === 1).map(([sku, qs]) => ({ sku, qty: qs[0], description: `usual, from ${hist.map((h) => h.so_number).join(' and ')}`, from_history: true })), ...lines];
          flag('FROM_HISTORY', `Lines rebuilt from ${hist.map((h) => `${h.so_number} (${h.order_date})`).join(' and ')}. Confirm with the customer.`);
        }
      }
      if (!lines.length && ext.mentions?.length) {
        for (const mnt of ext.mentions) {
          const m = await T.match_product(mnt.description, matcher);
          if (m.sku && !m.ambiguous) lines.push({ ...mnt, sku_match: m });
        }
        if (lines.length) p.questions.push(`How many cases of each do you need: ${[...new Set(lines.map((l) => l.sku_match.sku))].join(', ')}?`);
      }
      if (!ext.from_history && lines.some((l) => l.from_history)) flag('FROM_HISTORY', 'The agent rebuilt lines from earlier orders. Confirm with the customer.');
      const groups = new Map();
      let exact = lines.length > 0;
      for (const l of lines) {
        let prod = null; let inferred = false; let note = null;
        if (l.sku) {
          prod = await T.get_product(String(l.sku).toUpperCase());
          if (!prod) {
            const near = matcher.nearestSkus(l.sku);
            const byText = l.description ? await T.match_product(l.description.replace(/HPS-\d{4}/g, ''), matcher) : { sku: null };
            const pick = near.find((s) => s === byText.sku) || (near.length === 1 ? near[0] : byText.sku);
            if (pick) { prod = await T.get_product(pick); inferred = true; note = `Customer wrote ${l.sku}, which does not exist. ${pick} is one edit away${byText.sku === pick ? ' and matches the description' : ''}.`; flag('SKU_CORRECTED', note); }
          } else if (!l.quoted_sku && !l.from_history) {
            // The model may already have corrected a SKU the customer mistyped: that is still a correction a person confirms.
            const typo = (email.body.match(/\b[A-Z]{2,4}-\d{3,5}\b/gi) || []).map((x) => x.toUpperCase()).find((x) => x !== prod.sku && editDistance(x, prod.sku) <= 1 && !matcher.products.some((q) => q.sku === x));
            if (typo) { inferred = true; l.sku_list_line = true; flag('SKU_CORRECTED', `Customer wrote ${typo}, which does not exist. The agent read it as ${prod.sku} (${prod.name}), one edit away.`); }
          }
        } else {
          const m = l.sku_match || await T.match_product(l.description, matcher);
          if (!m.sku) continue; // not a product phrase
          if (m.ambiguous) { exact = false; flag('AMBIGUOUS_PRODUCT', `"${l.description}" could be ${m.alternatives.join(', ')}.`); p.questions.push(`For "${l.description.trim()}", which one do you need: ${m.alternatives.join(', ')}?`); continue; }
          prod = await T.get_product(m.sku); inferred = true;
        }
        if (!prod) { exact = false; flag('UNKNOWN_PRODUCT', `No catalog match for "${l.description || l.sku}".`, 'bad'); p.questions.push(`We could not find "${l.description || l.sku}" in our catalog. Can you check the item?`); continue; }
        if (ext.exclusions?.some((x) => productTokens(x).some((t) => HEADS.includes(t) && productTokens(prod.name).includes(t)))) { flag('LINE_EXCLUDED', `${prod.sku} left out: the email says to skip it.`, 'info'); continue; }
        if (inferred || l.from_history || !l.quoted_sku) exact = false;
        let qty = Number(l.qty);
        if (!Number.isInteger(qty) || qty <= 0) { exact = false; qty = 0; if (!l.mention_only) p.questions.push(`How many of ${prod.name} do you need?`); }
        else if (!l.from_history && !new RegExp(`\\b${qty}\\b`).test(email.body)) exact = false;
        const unit = String(l.unit_text || '').toLowerCase();
        const caseWord = /^(cs|case|cases|caja|cajas)$/.test(unit);
        const looseUnit = unit && !caseWord && prod.sell_uom === 'CS';
        const noUnitFreeText = !unit && !l.quoted_sku && !l.sku_list_line && !l.from_history && !l.mention_only && prod.sell_uom === 'CS';
        if (looseUnit || noUnitFreeText) { exact = false; flag('UNIT_UNCLEAR', `${prod.name} is sold by the case (${prod.pack}); the email says ${qty} ${unit || 'without a unit'}.`); p.questions.push(`${prod.name} comes in cases of ${prod.pack}. You wrote ${qty} ${unit || ''}. How many cases is that?`.replace(/\s+\./, '.')); }
        if (prod.status !== 'ACTIVE') {
          exact = false;
          const rep = prod.replaced_by ? await T.get_product(prod.replaced_by) : null;
          flag('DISCONTINUED', `${prod.sku} ${prod.name} is discontinued.${rep ? ` Successor ${rep.sku} ${rep.name}, list ${fmt(rep.list_price)} vs ${fmt(prod.list_price)}.` : ''} The customer must accept the substitute.`, 'bad');
          p.questions.push(`${prod.name} is discontinued.${rep ? ` We can send ${rep.name} at ${fmt(rep.list_price)} per ${rep.sell_uom === 'CS' ? 'case' : 'unit'} instead. Is that OK?` : ''}`);
        }
        const price = await T.get_price(customerId, prod.sku);
        const stated = l.customer_stated_price ?? (lines.length === 1 ? ext.customer_stated_price : null);
        if (stated != null && Math.abs(stated - price.unit_price) > 0.001) {
          exact = false; approver = 'credit';
          flag('PRICE_DISPUTE', `Customer expects ${fmt(stated)} for ${prod.sku}; system price is ${fmt(price.unit_price)} (${price.source}${price.expired_contract ? `, contract at ${fmt(price.expired_contract.unit_price)} expired ${price.expired_contract.valid_to}` : ''}).`, 'bad');
        }
        const lineValue = money(price.unit_price * qty);
        const stockOk = qty <= (prod.available ?? 0);
        if (!stockOk && qty > 0) {
          const inc = await T.get_incoming(prod.sku);
          flag('STOCK_SHORT', `${prod.sku}: ${qty} asked, ${prod.available} available${inc.length ? `; ${inc.map((i) => `${i.qty} due ${i.expected_date}`).join(', ')}` : ''}.`, 'bad');
        }
        const st = shipTos.find((s) => s.ship_to_id === l.ship_to_id) || pickShipTo(shipTos, l.label || l.ship_to_hint || email.body);
        if (!groups.has(st.ship_to_id)) groups.set(st.ship_to_id, { ship_to_id: st.ship_to_id, ship_to_name: st.name, lines: [], value: 0 });
        const g = groups.get(st.ship_to_id);
        g.lines.push({ sku: prod.sku, name: prod.name, qty, sell_uom: prod.sell_uom, pack: prod.pack, unit_price: price.unit_price, price_source: price.source, line_value: lineValue, available: prod.available, stock_ok: stockOk, status: prod.status, replaced_by: prod.replaced_by || null, inferred, from_text: l.description || null });
        g.value = money(g.value + lineValue);
      }
      p.orders = [...groups.values()];
      p.total = money(p.orders.reduce((s, o) => s + o.value, 0));
      if (!p.orders.length && p.kind === 'order' && !p.questions.length) { flag('NOTHING_TO_ORDER', 'No product could be read from this email.'); p.questions.push('Could you list the items and quantities you need?'); }
      check('L01', 'Every line quotes a SKU and quantity written in the email', exact && p.orders.length > 0, exact ? 'exact' : 'some lines inferred, unclear or missing');
      check('L02', 'Every product is ACTIVE', p.orders.every((o) => o.lines.every((x) => x.status === 'ACTIVE')));
      check('S01', 'Stock covers every line', p.orders.every((o) => o.lines.every((x) => x.stock_ok)));
      if (p.customer_po) {
        const so = await T.find_order(customerId, p.customer_po);
        const dup = (await db.query("select email_id, proposal from cases where customer_id=$1 and proposal->>'customer_po'=$2 and email_id<>$3", [customerId, p.customer_po, email.email_id])).rows[0];
        if (so || dup) {
          const sig = (orders) => JSON.stringify((orders || []).flatMap((o) => o.lines.map((x) => [x.sku, x.qty])));
          const same = dup && sig(dup.proposal.orders) === sig(p.orders);
          if (same) { flag('DUPLICATE', `Same PO ${p.customer_po} and same lines as ${dup.email_id}. No new order.`, 'info'); p.duplicate_of = dup.email_id; lane = 'no_action'; }
          else flag('PO_REVISION', `PO ${p.customer_po} already exists (${so ? so.so_number : dup.email_id}) with different lines. Treat it as a revision.`, 'bad');
        }
        check('D01', 'Customer PO not seen before', !(so || dup), p.customer_po);
      }
    } else {
      p.kind = 'route';
      p.summary = { return_request: 'Return or credit request on a past order. Accounts receivable decides; shipped orders cannot be edited.', invoice_dispute: 'Invoice question. Accounts receivable checks it against the order.', complaint: 'Complaint about a missing delivery. A person must call the customer.' }[ext.intent] || 'Needs a person.';
      if (ext.references_so) p.target = await T.find_order(customerId, ext.references_so);
      if (ext.intent === 'invoice_dispute' && p.target) p.evidence = `ERP shows ${p.target.so_number}: ${p.target.lines.map((l) => `${l.sku} ordered ${l.qty_ordered}, shipped ${l.qty_shipped}`).join('; ')}.`;
      approver = ['return_request', 'invoice_dispute'].includes(ext.intent) ? 'credit' : 'ops';
    }

    // credit for anything that adds value
    const addValue = p.kind === 'order' ? p.total : p.kind === 'change' ? money((p.ops || []).reduce((s, o) => s + o.delta_value, 0)) : 0;
    if (['order', 'change'].includes(p.kind)) {
      const cr = await T.get_credit(customerId);
      const after = money(cr.open_balance + cr.open_orders_value + addValue);
      p.credit = { ...cr, order_value: addValue, exposure_after: after, headroom_after: money(cr.credit_limit - after) };
      const ok = cr.status === 'ACTIVE' && after <= cr.credit_limit;
      check('K01', 'Credit: not on hold and within limit after this order', ok, `${cr.status}; ${fmt(after)} of ${fmt(cr.credit_limit)}`);
      if (!ok) { approver = 'credit'; flag('CREDIT_BLOCK', cr.status !== 'ACTIVE' ? `Customer is on ${cr.status}.` : `Exposure after this order ${fmt(after)} is ${fmt(after - cr.credit_limit)} over the ${fmt(cr.credit_limit)} limit.`, 'bad'); }
    }
    const related = (await db.query('select c.email_id from cases c join emails e using (email_id) where c.customer_id=$1 and e.received_at < $2 order by e.received_at', [customerId, email.received_at])).rows.map((r) => r.email_id);
    if (related.length) p.related = related;
    const sec = flags.some((f) => f.code === 'SECURITY_INJECTION');
    if (sec) approver = 'admin';
    check('X01', 'No instructions aimed at the system', !sec);
    check('I01', 'Request is a new order', ext.intent === 'new_order', ext.intent);
    check('U01', 'Sender identity verified', !flags.some((f) => f.code === 'UNVERIFIED_SENDER'));
    // The model's questions are suggestions for the reviewer; only questions the code raised decide the lane.
    if (ext.model_questions?.length) p.agent_questions = ext.model_questions.slice(0, 4);
    check('Q01', 'Nothing to ask the customer', p.questions.length === 0, p.questions.join(' | '));
    if (read?.reading) {
      // Two independent readers: an order is written without a person only when both read the same lines.
      // Resolve both readings to catalog SKUs the same way (typo within one edit, unambiguous words), minus skipped items.
      const resolve = (l) => {
        if (l.sku) { const k = String(l.sku).toUpperCase(); if (matcher.products.some((q) => q.sku === k)) return k; const near = matcher.nearestSkus(k); return near.length === 1 ? near[0] : k; }
        const m = l.description ? matcher.match(l.description) : null;
        return m?.sku && !m.ambiguous ? m.sku : null;
      };
      const skipped = (k) => [...(ext.exclusions || []), ...(rules.exclusions || [])].some((x) => productTokens(x).some((w) => HEADS.includes(w) && productTokens(matcher.products.find((q) => q.sku === k)?.name || '').includes(w)));
      const site = (l) => (shipTos.find((x) => x.ship_to_id === l.ship_to_id) || pickShipTo(shipTos, l.label || l.ship_to_hint || email.body))?.ship_to_id;
      const sig = (x) => JSON.stringify(x.lines.map((l) => [resolve(l), Number(l.qty), site(l)]).filter(([k]) => k && !skipped(k)).sort());
      const agree = rules.intent === ext.intent && sig(rules) === sig(ext);
      check('M01', 'Model and rules reader read the same request', agree, agree ? 'same intent, items, quantities and delivery sites' : `rules: ${rules.intent} ${sig(rules)}; model: ${ext.intent} ${sig(ext)}`);
    }
    if (lane !== 'no_action') {
      const green = p.kind === 'order' && checks.every((c) => c.pass) && p.orders.length > 0;
      // When the model was configured but failed, one reader is not enough to write without a person.
      if (green) lane = autoCommit && !(read && !read.reading) ? 'auto_committed' : 'needs_review';
      else if (p.questions.length && p.kind !== 'route' && !flags.some((f) => f.severity === 'bad')) lane = 'waiting_on_customer';
    }
    if (p.questions.length) p.reply_draft = draftReply(email, p);
    else if (p.agent_questions?.length && lane === 'needs_review') p.reply_draft = draftReply(email, { ...p, questions: p.agent_questions });
  } else {
    p.kind = 'route';
    p.summary = 'The sender is not a customer. Hand over to sales.';
    p.reply_draft = `Hi ${(email.from_name || '').split(' ')[0] || 'there'},\n\nThanks for getting in touch. A member of our sales team will contact you today to open an account and explain payment terms.\n\nHarbor Point Supply orders team`;
  }

  p.summary = p.summary || summarise(ext.intent, customer, p);
  if (read) p.agent = { model: read.model, used: Boolean(read.reading), next_action: read.reading?.next_action || null, reasoning: read.reading?.reasoning || null, usage: read.usage, error: read.error || null };
  const ticket = ticketFields({ lane, flags, intent: ext.intent, total: p.total, requestedDate, received_at: email.received_at });
  await db.query(
    `insert into cases (email_id, ticket_no, intent, label, customer_id, lane, status, erp_status, priority, sla_due_at, approver_role, summary, flags, checks, proposal, trace, model)
     values ($1,$2,$3,$4,$5,$6,$7,'none',$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16)
     on conflict (email_id) do update set intent=excluded.intent, label=excluded.label, customer_id=excluded.customer_id, lane=excluded.lane, status=excluded.status, priority=excluded.priority, sla_due_at=excluded.sla_due_at, approver_role=excluded.approver_role, summary=excluded.summary, flags=excluded.flags, checks=excluded.checks, proposal=excluded.proposal, trace=excluded.trace, model=excluded.model, row_version=cases.row_version+1, updated_at=now()`,
    [email.email_id, email.ticket_no, ext.intent, LABELS[ext.intent] || 'Other', customerId, lane, lane === 'no_action' ? 'closed' : 'new', ticket.priority, ticket.sla_due_at, approver, p.summary, JSON.stringify(flags), JSON.stringify(checks), JSON.stringify(p), JSON.stringify(trace), model]
  );
  if (read) await audit(db, 'agent', 'agent', email.email_id, read.reading ? 'model_read' : 'model_fallback', { model: read.model, tools: read.trace.filter((x) => x.by === 'model' && !['model_turn', 'model_error'].includes(x.tool)).map((x) => x.tool), next_action: read.reading?.next_action, ...read.usage, error: read.error || undefined });
  await audit(db, 'agent', 'agent', email.email_id, 'ticket_created', { lane, intent: ext.intent, priority: ticket.priority, model, flags: flags.map((f) => f.code) });
  if (lane === 'auto_committed') {
    try { await commitProposal(db, email.email_id, { actor: 'agent', actorType: 'agent', role: 'agent' }); }
    catch (e) {
      // Stock or credit changed between the checks and the commit: nothing was written, a person takes over.
      lane = 'needs_review';
      flags.push({ code: 'COMMIT_REFUSED', text: `The ERP refused the order at commit time: ${e.message}`, severity: 'bad' });
      await db.query("update cases set lane='needs_review', flags=$2::jsonb, row_version=row_version+1 where email_id=$1", [email.email_id, JSON.stringify(flags)]);
      await audit(db, 'agent', 'agent', email.email_id, 'commit_refused', { errors: e.audit?.errors || [e.message] });
    }
  }
  return { lane, intent: ext.intent };
}

function ticketFields({ lane, flags, intent, total, requestedDate, received_at }) {
  const codes = flags.map((f) => f.code);
  let priority = 'normal';
  if (lane === 'no_action' || intent === 'quote_request') priority = 'low';
  if (codes.some((c) => ['CREDIT_BLOCK', 'PRICE_DISPUTE', 'STOCK_SHORT', 'UNVERIFIED_SENDER', 'PO_REVISION'].includes(c)) || intent === 'complaint' || (total || 0) >= 1500) priority = 'high';
  if (codes.includes('SECURITY_INJECTION') || (requestedDate && requestedDate <= '2026-11-03' && lane !== 'no_action')) priority = 'urgent';
  if (lane === 'auto_committed') priority = 'normal';
  const due = new Date(new Date(received_at).getTime() + SLA_HOURS[priority] * 3600e3).toISOString();
  return { priority, sla_due_at: due };
}

function pickShipTo(shipTos, text) {
  const t = String(text || '').toLowerCase();
  let best = null, score = 0;
  for (const s of shipTos) {
    const ws = `${s.name} ${s.address}`.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !['harbor', 'port', 'street', 'drive', 'metro', 'fitness', 'hotel', 'harborview', 'center', 'centers', 'main', 'road'].includes(w));
    const sc = ws.filter((w) => t.includes(w)).length + (/dock b/.test(t) && /dock b/i.test(s.address) ? 3 : 0);
    if (sc > score) { score = sc; best = s; }
  }
  return best || shipTos.find((s) => s.is_default) || shipTos[0];
}

function draftReply(email, p) {
  const name = (email.from_name || '').split(' ')[0] || 'there';
  if (p.language === 'es') return `Hola ${name},\n\nGracias por su pedido. Antes de registrarlo necesitamos confirmar:\n${p.questions.map((q) => `- ${q}`).join('\n')}\n\nResponda a este correo y lo procesamos enseguida.\n\nEquipo de pedidos de Harbor Point Supply`;
  return `Hi ${name},\n\nThanks for your email. Before we book this we need to check:\n${p.questions.map((q) => `- ${q}`).join('\n')}\n\nReply here and we will process it straight away.\n\nHarbor Point Supply orders team`;
}

function summarise(intent, customer, p) {
  const n = p.orders.reduce((s, o) => s + o.lines.length, 0);
  return `${customer?.name || 'Unknown sender'}: ${intent.replace(/_/g, ' ')}${n ? `, ${n} line${n > 1 ? 's' : ''} in ${p.orders.length} order${p.orders.length > 1 ? 's' : ''}, ${fmt(p.total)} USD` : ''}.`;
}

export async function audit(q, actor, actorType, emailId, action, detail) {
  await q.query('insert into audit_events (actor, actor_type, email_id, action, detail) values ($1,$2,$3,$4,$5::jsonb)', [actor, actorType, emailId, action, JSON.stringify(detail || {})]);
}

// Prices, stock and credit for a reviewer's edited order, without writing anything.
export async function previewOrders(q, customerId, orders) {
  const shipTos = (await q.query('select ship_to_id, name from ship_to_addresses where customer_id=$1', [customerId])).rows;
  const errors = [];
  const out = [];
  for (const o of orders || []) {
    const st = shipTos.find((x) => x.ship_to_id === o.ship_to_id);
    if (!st) errors.push(`Delivery address ${o.ship_to_id || '(none)'} does not belong to this customer.`);
    const lines = [];
    for (const l of o.lines || []) {
      const sku = String(l.sku || '').toUpperCase().trim();
      const qty = Number(l.qty);
      const prod = sku ? await productBySku(q, sku) : null;
      if (!prod) { errors.push(`${sku || 'A line'} is not in the catalog.`); continue; }
      if (!Number.isInteger(qty) || qty <= 0) { errors.push(`${sku}: the quantity must be a whole number above 0.`); continue; }
      const price = await priceFor(q, customerId, sku);
      if (prod.status !== 'ACTIVE') errors.push(`${sku} is discontinued and cannot be sold.`);
      if (qty > prod.available) errors.push(`${sku}: ${qty} asked, ${prod.available} available.`);
      lines.push({ sku, name: prod.name, qty, sell_uom: prod.sell_uom, pack: prod.pack, unit_price: price.unit_price, price_source: price.source, line_value: money(qty * price.unit_price), available: prod.available, stock_ok: qty <= prod.available, status: prod.status, replaced_by: prod.replaced_by || null });
    }
    out.push({ ship_to_id: o.ship_to_id, ship_to_name: st?.name || o.ship_to_id, lines, value: money(lines.reduce((a, x) => a + x.line_value, 0)) });
  }
  const total = money(out.reduce((a, o) => a + o.value, 0));
  const cr = await creditPosition(q, customerId);
  const after = money(cr.open_balance + cr.open_orders_value + total);
  return { orders: out, total, credit: { ...cr, order_value: total, exposure_after: after, headroom_after: money(cr.credit_limit - after) }, errors };
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- the only write path into the ERP ----------
export async function commitProposal(db, emailId, { actor, actorType = 'human', role, orders: edited, reason, creditOverride = false, expectedVersion } = {}) {
  return db.tx(async (t) => {
    const c = (await t.query('select * from cases where email_id=$1 for update', [emailId])).rows[0];
    if (!c) throw httpErr(404, 'Ticket not found.');
    if (c.erp_status === 'committed') return { ok: true, already: true, so_numbers: c.proposal.so_numbers };
    if (expectedVersion && Number(expectedVersion) !== c.row_version) throw httpErr(409, 'Someone changed this ticket after you opened it. Reload to see the current version.');
    if (!c.customer_id) throw httpErr(422, 'There is no customer on this ticket, so there is nothing to write to the ERP.');
    const sec = c.flags.some((f) => f.code === 'SECURITY_INJECTION');
    if (sec && actorType === 'human' && role !== 'admin') throw httpErr(403, 'This ticket has a security flag. Only an Admin can approve it.');
    const p = c.proposal;
    const errors = [];
    let added = 0;
    const cust = (await t.query('select status from customers where customer_id=$1 for update', [c.customer_id])).rows[0];
    const stockRow = async (sku) => (await t.query('select p.status, p.list_price, i.available from products p join inventory i using (sku) where sku=$1 for update of i', [sku])).rows[0];
    // Every stock row this commit writes is locked first, in SKU order, so two commits that share SKUs wait
    // for each other instead of locking them in opposite order and deadlocking.
    const lockStock = (skus) => t.query('select sku from inventory where sku = any($1::text[]) order by sku for update', [skus]);
    const unitPrice = async (sku) => (await priceFor(t, c.customer_id, sku)).unit_price;
    let result = {};

    if (p.kind === 'cancel') {
      const so = (await t.query('select status from sales_orders where so_number=$1 for update', [p.target?.so_number])).rows[0];
      if (!so) throw httpErr(422, 'The order to cancel was not found.');
      if (so.status !== 'OPEN') throw httpErr(422, `${p.target.so_number} is ${so.status} and cannot be cancelled.`);
      const lines = (await t.query('select sku, qty_ordered, qty_shipped from sales_order_lines where so_number=$1', [p.target.so_number])).rows;
      await lockStock(lines.map((l) => l.sku));
      for (const l of lines) await t.query('update inventory set allocated=allocated-$2, available=available+$2 where sku=$1', [l.sku, l.qty_ordered - l.qty_shipped]);
      await t.query("update sales_orders set status='CANCELLED' where so_number=$1", [p.target.so_number]);
      result = { cancelled: p.target.so_number };
    } else if (p.kind === 'change') {
      const so = (await t.query('select status from sales_orders where so_number=$1 for update', [p.target?.so_number])).rows[0];
      if (!so || so.status === 'SHIPPED' || so.status === 'CANCELLED') throw httpErr(422, `${p.target?.so_number || 'Order'} cannot be edited (${so?.status || 'not found'}).`);
      await lockStock((p.ops || []).map((op) => op.sku));
      for (const op of p.ops || []) {
        const s = await stockRow(op.sku);
        if (s.status !== 'ACTIVE') { errors.push(`${op.sku} is discontinued`); continue; }
        if (op.op === 'set_qty') {
          const line = (await t.query('select line_no, qty_ordered, qty_shipped, unit_price from sales_order_lines where so_number=$1 and sku=$2', [p.target.so_number, op.sku])).rows[0];
          if (op.to < line.qty_shipped) { errors.push(`${op.sku}: cannot go below the ${line.qty_shipped} already shipped`); continue; }
          const delta = op.to - line.qty_ordered;
          if (delta > Number(s.available)) { errors.push(`${op.sku}: needs ${delta} more, ${s.available} available`); continue; }
          added += delta * Number(line.unit_price);
          await t.query('update sales_order_lines set qty_ordered=$3 where so_number=$1 and line_no=$2', [p.target.so_number, line.line_no, op.to]);
          await t.query('update inventory set allocated=allocated+$2, available=available-$2 where sku=$1', [op.sku, delta]);
        } else {
          if (so.status === 'PARTIALLY_SHIPPED') { errors.push('Lines cannot be added to a partially shipped order'); continue; }
          if (op.qty > Number(s.available)) { errors.push(`${op.sku}: ${op.qty} asked, ${s.available} available`); continue; }
          const up = await unitPrice(op.sku);
          const n = Number((await t.query('select coalesce(max(line_no),0) as n from sales_order_lines where so_number=$1', [p.target.so_number])).rows[0].n) + 1;
          added += op.qty * up;
          await t.query('insert into sales_order_lines values ($1,$2,$3,$4,0,$5)', [p.target.so_number, n, op.sku, op.qty, up]);
          await t.query('update inventory set allocated=allocated+$2, available=available-$2 where sku=$1', [op.sku, op.qty]);
        }
      }
      result = { changed: p.target.so_number };
    } else if (p.kind === 'order') {
      const orders = (edited || p.orders || []).map((o) => ({ ...o, lines: (o.lines || []).filter((l) => Number(l.qty) > 0) })).filter((o) => o.lines.length);
      if (!orders.length) throw httpErr(422, 'There are no lines with a quantity to write.');
      if (edited) {
        const own = new Set((await t.query('select ship_to_id from ship_to_addresses where customer_id=$1', [c.customer_id])).rows.map((r) => r.ship_to_id));
        for (const o of orders) if (!own.has(o.ship_to_id)) errors.push(`Delivery address ${o.ship_to_id} does not belong to this customer`);
      }
      const soNumbers = [];
      await lockStock(orders.flatMap((o) => o.lines.map((l) => l.sku)));
      const priced = [];
      for (const o of orders) {
        const lines = [];
        for (const l of o.lines) {
          const qty = Number(l.qty);
          if (!Number.isInteger(qty) || qty <= 0) { errors.push(`${l.sku}: quantity must be a whole number of ${l.sell_uom === 'EA' ? 'units' : 'cases'}`); continue; }
          const s = await stockRow(l.sku);
          if (!s) { errors.push(`${l.sku} does not exist`); continue; }
          if (s.status !== 'ACTIVE') { errors.push(`${l.sku} is discontinued and cannot be sold`); continue; }
          if (qty > Number(s.available)) { errors.push(`${l.sku}: ${qty} asked, ${s.available} available now`); continue; }
          const up = await unitPrice(l.sku);
          added += up * qty;
          lines.push({ sku: l.sku, qty, up });
        }
        priced.push({ ship_to_id: o.ship_to_id, lines });
      }
      if (!errors.length) {
        for (const o of priced) {
          const so = (await t.query("select 'SO-' || nextval('so_number_seq') as so")).rows[0].so; // a sequence: approvals at the same moment never share a number
          await t.query("insert into sales_orders values ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8)", [so, c.customer_id, o.ship_to_id, p.customer_po || '', BUSINESS_DATE, p.requested_date || null, emailId, actor]);
          let n = 1;
          for (const l of o.lines) {
            await t.query('insert into sales_order_lines values ($1,$2,$3,$4,0,$5)', [so, n++, l.sku, l.qty, l.up]);
            await t.query('update inventory set allocated=allocated+$2, available=available-$2 where sku=$1', [l.sku, l.qty]);
          }
          soNumbers.push(so);
        }
        result = { so_numbers: soNumbers };
      }
    } else {
      throw httpErr(422, 'This ticket has nothing to write to the ERP. Reply or route it instead.');
    }

    if (['order', 'change'].includes(p.kind)) {
      const cr = await creditPosition(t, c.customer_id);
      // The new or changed lines are already written inside this transaction, so open_orders_value includes them.
      const after = cr.open_balance + cr.open_orders_value;
      const breach = cust.status !== 'ACTIVE' || after > cr.credit_limit;
      if (breach && !(creditOverride && ['credit', 'admin'].includes(role) && reason)) errors.push(`Credit: ${cust.status}, exposure after ${fmt(after)} against a ${fmt(cr.credit_limit)} limit. Credit and AR can release it with a reason.`);
      result.credit_released = breach && !errors.length;
    }
    if (errors.length) {
      // Throwing rolls back every write above; the rejection itself is logged outside the transaction.
      const e = httpErr(422, errors.join('. '));
      e.audit = { actor, actorType, emailId, errors };
      throw e;
    }
    const proposal = { ...p, ...result, committed_by: actor, committed_reason: reason || null };
    await t.query("update cases set erp_status='committed', status='resolved', proposal=$2::jsonb, row_version=row_version+1, updated_at=now() where email_id=$1", [emailId, JSON.stringify(proposal)]);
    await audit(t, actor, actorType, emailId, actorType === 'agent' ? 'auto_committed' : 'approved_and_committed', { ...result, value: money(added), reason: reason || null, edited: Boolean(edited) });
    return { ok: true, ...result };
  });
}
