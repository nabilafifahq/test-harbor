// Requests that arrive at the same moment: new emails, and approvals that write to the ERP together.
// These races need a server that runs requests side by side. Embedded Postgres (PGlite) does one at a time, so there
// the email test only checks the numbering and the approval tests are skipped. With TEST_DATABASE_URL naming a
// database this test may wipe, all three run against real Postgres; CI does that with its Postgres 17 service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const PG = process.env.TEST_DATABASE_URL;
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_BASE_URL;
if (PG) process.env.DATABASE_URL = PG;
else process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-concurrency-'));
process.env.LLM_MODE = 'off';
process.env.CRON_SECRET = 'concurrency-test-cron';
const PASSWORD = (process.env.DEMO_PASSWORD = 'concurrency-test-password');
const needsPostgres = !PG && 'set TEST_DATABASE_URL: PGlite runs one transaction at a time, so this race cannot happen there';

const { getDb } = await import('../src/db.js');
const { handle } = await import('../src/app.js');
const { commitProposal } = await import('../src/agent.js');
const db = await getDb();
await db.exec('drop table if exists app_meta'); // a database left by an earlier run would count as seeded
const server = http.createServer(handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.closeAllConnections(); server.close(); await db.close(); });

async function call(p, { body = {}, cookie, headers = {} } = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const ops = (await call('/api/login', { body: { username: 'ops', password: PASSWORD } })).cookie; // the first request seeds

// Open order tickets of different customers, so the commits share no customer or order row.
async function openOrders(n) {
  const rows = (await db.query(`select distinct on (c.customer_id) c.email_id, c.customer_id, s.ship_to_id
      from cases c join ship_to_addresses s using (customer_id)
      where c.proposal->>'kind' = 'order' and c.erp_status = 'none'
      order by c.customer_id, c.email_id, s.ship_to_id`)).rows;
  assert.ok(rows.length >= n, `needs ${n} open order tickets for different customers, found ${rows.length}`);
  return rows.slice(0, n);
}
const twoSkus = async () => (await db.query("select sku from inventory join products using (sku) where status = 'ACTIVE' and available >= 10 order by sku limit 2")).rows.map((r) => r.sku);
const available = async (skus) => Promise.all(skus.map(async (sku) => Number((await db.query('select available from inventory where sku=$1', [sku])).rows[0].available)));
const approve = (ticket, skus) => commitProposal(db, ticket.email_id, {
  actor: 'admin', role: 'admin', creditOverride: true, reason: 'Concurrency test',
  orders: [{ ship_to_id: ticket.ship_to_id, lines: skus.map((sku) => ({ sku, qty: 1 })) }],
});
const bothCommitted = (results) => assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], results.map((r) => r.reason && `${r.reason.code || ''} ${r.reason.message}`).join(' | '));

test('emails that arrive at the same moment each get their own email ID and ticket', async () => {
  const post = (n) => call('/api/emails', { cookie: ops, body: { from_name: 'Sam', from_email: 'sam@example.com', subject: `Thank you ${n}`, body: `Thanks for the delivery this morning. (${n})` } });
  const res = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(post));
  assert.deepEqual(res.map((r) => r.status), Array(8).fill(202), JSON.stringify(res.map((r) => r.body)));
  assert.deepEqual(res.map((r) => r.body.email_id).sort(), ['E041', 'E042', 'E043', 'E044', 'E045', 'E046', 'E047', 'E048']);
  assert.deepEqual(res.map((r) => r.body.ticket_no).sort(), ['HP-1041', 'HP-1042', 'HP-1043', 'HP-1044', 'HP-1045', 'HP-1046', 'HP-1047', 'HP-1048']);
});

test('a mail provider that delivers the same mail twice at once gets one ticket back twice', async () => {
  const raw = 'Message-ID: <retry-1@mail.example>\r\nFrom: Sam <sam@example.com>\r\nSubject: Thanks\r\n\r\nThanks for the delivery this morning.\r\n';
  const deliver = () => call('/api/inbound', { body: { raw }, headers: { authorization: 'Bearer concurrency-test-cron' } });
  const [a, b] = await Promise.all([deliver(), deliver()]);
  assert.deepEqual([a.status, b.status], [202, 202], JSON.stringify([a.body, b.body]));
  assert.equal(a.body.email_id, b.body.email_id);
  assert.equal((await db.query("select count(*)::int as n from emails where message_id='<retry-1@mail.example>'")).rows[0].n, 1);
  assert.deepEqual((await db.query("select actor, email_id from audit_events where action='email_duplicate'")).rows, [{ actor: 'inbound', email_id: a.body.email_id }]);
});

test('twenty wrong passwords at the same moment get five guesses, not twenty', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => call('/api/login', { body: { username: 'credit', password: 'a guess' } })));
  const by = (s) => res.filter((r) => r.status === s).length;
  assert.deepEqual([by(401), by(429)], [5, 15], 'only five attempts are checked before the lock');
  const rows = (await db.query("select count(*)::int as n from audit_events where action = 'sign_in_failed' and detail->>'username' = 'credit' and detail->>'reason' = 'wrong_password'")).rows[0].n;
  assert.equal(rows, 5);
});

test('two approvals at the same moment get different SO numbers', { skip: needsPostgres }, async () => {
  const [a, b] = await openOrders(2);
  const [x, y] = await twoSkus();
  const top = Number((await db.query('select max(substr(so_number, 4)::int) as m from sales_orders')).rows[0].m);
  const results = await Promise.allSettled([approve(a, [x]), approve(b, [y])]);
  bothCommitted(results);
  assert.deepEqual(results.flatMap((r) => r.value.so_numbers).sort(), [`SO-${top + 1}`, `SO-${top + 2}`]);
});

test('two approvals that take the same SKUs in opposite order both commit', { skip: needsPostgres }, async () => {
  const [a, b] = await openOrders(2);
  const [x, y] = await twoSkus();
  const before = await available([x, y]);
  const results = await Promise.allSettled([approve(a, [x, y]), approve(b, [y, x])]);
  bothCommitted(results);
  assert.deepEqual(await available([x, y]), before.map((v) => v - 2));
});
