// End to end: load the ERP and inbox into embedded Postgres, run the agent over all 40 emails (rules only,
// no model), then check the safety rules and the write path. Prints a lane table against the golden labels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.LLM_BASE_URL;

const { getDb } = await import('../src/db.js');
const { runPipeline } = await import('../src/app.js');
const { commitProposal } = await import('../src/agent.js');

const db = await getDb();
await runPipeline(db);
const rows = (await db.query('select email_id, lane, status, erp_status, flags, proposal from cases order by email_id')).rows;
const c = Object.fromEntries(rows.map((r) => [r.email_id, { ...r, codes: r.flags.map((f) => f.code) }]));
const golden = Object.fromEntries(JSON.parse(fs.readFileSync('data/golden_labels.json', 'utf8')).emails.map((g) => [g.email_id, g]));
let agree = 0;
const diffs = [];
for (const r of rows) { if (golden[r.email_id]?.expected_lane === r.lane) agree++; else diffs.push(`${r.email_id}: ${r.lane} (labelled ${golden[r.email_id]?.expected_lane})`); }
console.log(`lane agreement with golden labels: ${agree}/40`);
console.log(diffs.join('\n'));

// 1. The green lane: exactly the four clean, SKU-quoted orders commit on their own
const auto = rows.filter((r) => r.lane === 'auto_committed').map((r) => r.email_id).sort();
assert.deepEqual(auto, ['E001', 'E003', 'E015', 'E038']);
for (const id of auto) assert.equal(c[id].erp_status, 'committed');
// 2. Nothing risky commits
for (const r of rows) if (!auto.includes(r.email_id)) assert.equal(r.erp_status, 'none', `${r.email_id} must not be in the ERP`);
// 3. Specific traps
assert.ok(c.E012.codes.includes('SECURITY_INJECTION'));
assert.ok(c.E016.codes.includes('DUPLICATE')); assert.equal(c.E016.lane, 'no_action');
assert.ok(c.E006.codes.includes('CREDIT_BLOCK'));
assert.ok(c.E007.codes.includes('CREDIT_BLOCK'));
assert.ok(c.E019.codes.includes('DISCONTINUED'));
assert.ok(c.E021.codes.includes('SKU_CORRECTED'));
assert.equal(c.E021.proposal.orders[0].lines[0].sku, 'HPS-1305');
assert.ok(c.E024.codes.includes('PRICE_DISPUTE'));
assert.ok(c.E025.codes.includes('PRICE_DISPUTE'));
assert.ok(c.E013.codes.includes('UNVERIFIED_SENDER'));
assert.ok(c.E014.codes.includes('UNKNOWN_SENDER'));
assert.ok(c.E026.codes.includes('UNIT_UNCLEAR'));
assert.ok(c.E008.codes.includes('STOCK_SHORT'));
assert.ok(c.E032.codes.includes('DATE_IN_PAST'));
assert.ok(c.E023.codes.includes('MISSING_ATTACHMENT'));
assert.equal(c.E029.lane, 'no_action'); assert.equal(c.E028.lane, 'no_action');
assert.equal(c.E005.proposal.orders.length, 3, 'E005 splits into three ship-to orders');
assert.equal(c.E004.proposal.kind, 'change');
assert.equal(c.E017.proposal.kind, 'cancel');
assert.equal(c.E017.proposal.target.so_number, 'SO-24055');
// 4. Stock moved for committed orders: E001 took 4 cutlery kits
assert.equal(Number((await db.query("select available from inventory where sku='HPS-1408'")).rows[0].available), 26);
// 5. Idempotent commit, and the write path refuses what it must
assert.equal((await commitProposal(db, 'E001', { actor: 't', role: 'ops' })).already, true);
await assert.rejects(() => commitProposal(db, 'E019', { actor: 't', role: 'ops' }), /discontinued/);
await assert.rejects(() => commitProposal(db, 'E006', { actor: 't', role: 'ops' }), /Credit/);
const rel = await commitProposal(db, 'E006', { actor: 't', role: 'credit', creditOverride: true, reason: 'Paid by card on the phone' });
assert.ok(rel.credit_released);
// 6. Cancellation releases stock, change edits an OPEN order
const before = Number((await db.query("select available from inventory where sku='HPS-1201'")).rows[0].available);
await commitProposal(db, 'E017', { actor: 't', role: 'ops' });
assert.equal(Number((await db.query("select available from inventory where sku='HPS-1201'")).rows[0].available), before + 20);
assert.equal((await db.query("select status from sales_orders where so_number='SO-24055'")).rows[0].status, 'CANCELLED');
await commitProposal(db, 'E004', { actor: 't', role: 'ops' });
assert.equal(Number((await db.query("select qty_ordered from sales_order_lines where so_number='SO-24051' and sku='HPS-1103'")).rows[0].qty_ordered), 25);
console.log('smoke test passed');
await db.close();
