import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { parseEml } from './eml.js';

const TABLES = ['sessions', 'users', 'agent_reads', 'audit_events', 'outbox', 'comments', 'cases', 'emails', 'sales_order_lines', 'sales_orders', 'incoming_supply', 'inventory', 'customer_prices', 'products', 'ship_to_addresses', 'customer_contacts', 'customers'];
export const DEMO_USERS = [
  { username: 'ops', display_name: 'Jo Park', role: 'ops' },
  { username: 'credit', display_name: 'Rina Hartono', role: 'credit' },
  { username: 'admin', display_name: 'Alex Morgan', role: 'admin' },
];

export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

async function load(q, dir, file, table, cols, conv = {}) {
  for (const r of parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'))) {
    await q.query(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => (conv[c] ? conv[c](r[c]) : r[c] === '' ? null : r[c])));
  }
}

// The inbox is the folder of raw .eml files; the JSON-lines export is only used when that folder is missing.
export function readInbox(dataDir) {
  const dir = path.join(dataDir, 'inbox');
  if (fs.existsSync(dir)) {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).map((f) => ({ email_id: path.basename(f, '.eml'), ...parseEml(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  }
  return fs.readFileSync(path.join(dataDir, 'emails.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function seed(q, dataDir, password) {
  // A reseed replaces the demo data, never the audit trail: earlier events move to audit_archive, which is not dropped.
  await q.exec('create table if not exists audit_archive (id bigint, at timestamptz, actor text, actor_type text, email_id text, action text, detail jsonb, archived_at timestamptz not null default now())');
  // Copy and drop in one transaction, so a crash between them cannot copy the same rows twice.
  const archived = (await q.query("select to_regclass('audit_events') is not null as present")).rows[0].present
    ? await q.tx(async (t) => {
      const n = (await t.query('with moved as (insert into audit_archive (id, at, actor, actor_type, email_id, action, detail) select id, at, actor, actor_type, email_id, action, detail from audit_events returning 1) select count(*)::int as n from moved')).rows[0].n;
      await t.query('drop table audit_events cascade');
      return n;
    })
    : 0;
  await q.exec(TABLES.map((t) => `drop table if exists ${t} cascade;`).join('\n'));
  await q.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const d = path.join(dataDir, 'erp');
  await load(q, d, 'customers.csv', 'customers', ['customer_id', 'name', 'payment_terms', 'credit_limit', 'open_balance', 'status']);
  await load(q, d, 'customer_contacts.csv', 'customer_contacts', ['customer_id', 'name', 'email', 'role']);
  await load(q, d, 'ship_to_addresses.csv', 'ship_to_addresses', ['ship_to_id', 'customer_id', 'name', 'address', 'is_default'], { is_default: (v) => v === '1' });
  await load(q, d, 'products.csv', 'products', ['sku', 'name', 'category', 'sell_uom', 'pack', 'list_price', 'status', 'replaced_by']);
  await load(q, d, 'customer_prices.csv', 'customer_prices', ['customer_id', 'sku', 'unit_price', 'valid_from', 'valid_to']);
  await load(q, d, 'inventory.csv', 'inventory', ['sku', 'on_hand', 'allocated', 'available']);
  await load(q, d, 'incoming_supply.csv', 'incoming_supply', ['supplier_po', 'sku', 'qty', 'expected_date']);
  await load(q, d, 'sales_orders.csv', 'sales_orders', ['so_number', 'customer_id', 'ship_to_id', 'customer_po', 'order_date', 'requested_date', 'status']);
  await load(q, d, 'sales_order_lines.csv', 'sales_order_lines', ['so_number', 'line_no', 'sku', 'qty_ordered', 'qty_shipped', 'unit_price']);
  const emails = readInbox(dataDir).sort((a, b) => a.received_at.localeCompare(b.received_at));
  let n = 1001;
  for (const e of emails) await q.query('insert into emails values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)', [e.email_id, `HP-${n++}`, e.received_at, e.from_name, e.from_email, e.subject, e.body, JSON.stringify(e.attachments || []), e.message_id || null]);
  await q.query("select setval('email_seq', count(*) + 1, false) from emails");
  await q.query("select setval('so_number_seq', coalesce(max(substr(so_number, 4)::int), 0) + 1, false) from sales_orders");
  for (const u of DEMO_USERS) await q.query('insert into users (username, display_name, role, password_hash) values ($1,$2,$3,$4)', [u.username, u.display_name, u.role, await hashPassword(password)]);
  await q.query("insert into audit_events (actor, actor_type, action, detail) values ('system','system','seeded',$1::jsonb)", [JSON.stringify({ emails: emails.length, archived })]);
  return { emails: emails.length };
}
