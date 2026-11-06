import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

const TABLES = ['sessions', 'users', 'audit_events', 'outbox', 'comments', 'cases', 'emails', 'sales_order_lines', 'sales_orders', 'incoming_supply', 'inventory', 'customer_prices', 'products', 'ship_to_addresses', 'customer_contacts', 'customers'];
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

export async function seed(q, dataDir, password) {
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
  const emails = fs.readFileSync(path.join(dataDir, 'emails.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.received_at.localeCompare(b.received_at));
  let n = 1001;
  for (const e of emails) await q.query('insert into emails values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [e.email_id, `HP-${n++}`, e.received_at, e.from_name, e.from_email, e.subject, e.body, JSON.stringify(e.attachments || [])]);
  for (const u of DEMO_USERS) await q.query('insert into users (username, display_name, role, password_hash) values ($1,$2,$3,$4)', [u.username, u.display_name, u.role, await hashPassword(password)]);
  await q.query("insert into audit_events (actor, actor_type, action, detail) values ('system','system','seeded',$1::jsonb)", [JSON.stringify({ emails: emails.length })]);
  return { emails: emails.length };
}
