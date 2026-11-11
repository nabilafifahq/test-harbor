// The audit trail, ticket timestamps and the rules on ticket writes through the real HTTP API (rules reader,
// embedded Postgres, no network): demo reset, sign-in events, refused requests, reject, assign, status and approve.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-audit-'));
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_BASE_URL;
process.env.LLM_MODE = 'off';
const PASSWORD = (process.env.DEMO_PASSWORD = 'audit-test-password');

const { getDb } = await import('../src/db.js');
const { handle } = await import('../src/app.js');
const db = await getDb();
const server = http.createServer(handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.closeAllConnections(); server.close(); await db.close(); });

async function call(p, { body = {}, cookie, headers = {} } = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const get = async (p, cookie) => { const r = await fetch(base + p, { headers: cookie ? { cookie } : {} }); return { status: r.status, body: await r.json() }; };
const signIn = async (username) => (await call('/api/login', { body: { username, password: PASSWORD } })).cookie;
const ticket = async (id) => (await db.query('select status, assignee, row_version, erp_status from cases where email_id=$1', [id])).rows[0];
const events = async (action) => (await db.query('select * from audit_events where action=$1 order by id', [action])).rows;
const count = async (table) => (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n;

test('sign-out, wrong passwords and the lockout are audited', async () => {
  const credit = await signIn('credit');
  assert.equal((await call('/api/logout', { cookie: credit })).status, 200);
  assert.deepEqual((await events('signed_out')).map((a) => a.actor), ['credit']);

  for (let i = 0; i < 5; i++) assert.equal((await call('/api/login', { body: { username: 'credit', password: 'wrong' } })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'credit', password: PASSWORD } })).status, 429);
  const failed = (await events('sign_in_failed')).filter((a) => a.detail.username === 'credit');
  assert.deepEqual(failed.map((a) => [a.actor, a.detail.reason]), [...Array(5).fill(['anonymous', 'wrong_password']), ['anonymous', 'locked']]);
  assert.deepEqual((await events('account_locked')).map((a) => [a.actor, a.detail.username, a.detail.failed_count]), [['system', 'credit', 5]]);

  await call('/api/login', { body: { username: 'MyPassword-in-the-wrong-box', password: 'x' } });
  const unknown = (await events('sign_in_failed')).at(-1);
  assert.equal(unknown.detail.reason, 'unknown_user');
  assert.ok(!JSON.stringify(unknown).toLowerCase().includes('mypassword'), 'a username nobody has is not stored');
});

test('refused requests (403) are audited with who tried what', async () => {
  const ops = await signIn('ops');
  assert.equal((await call('/api/admin/reset', { cookie: ops })).status, 403);
  assert.equal((await call('/api/tickets/E006/approve', { cookie: ops })).status, 403);
  assert.equal((await call('/api/tickets/E019/assign', { cookie: ops, body: { assignee: 'me' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual((await events('access_denied')).map((a) => [a.actor, a.email_id, a.detail.path]), [
    ['ops', null, '/api/admin/reset'],
    ['ops', 'E006', '/api/tickets/E006/approve'],
    ['anonymous', 'E019', '/api/tickets/E019/assign'],
  ]);
});

test('assign and reject move cases.updated_at', async () => {
  const ops = await signIn('ops');
  const old = new Date('2000-01-01T00:00:00Z');
  const stale = () => db.query("update cases set updated_at=$1 where email_id='E019'", [old]);
  const updatedAt = async () => (await db.query("select updated_at from cases where email_id='E019'")).rows[0].updated_at;

  await stale();
  assert.equal((await call('/api/tickets/E019/assign', { cookie: ops, body: { assignee: 'me' } })).status, 200);
  assert.ok(await updatedAt() > old, 'assign');

  await stale();
  assert.equal((await call('/api/tickets/E019/reject', { cookie: ops, body: { reason: 'Discontinued item, the customer will reorder.' } })).status, 200);
  assert.ok(await updatedAt() > old, 'reject');
});

test('setting the status a ticket already has writes nothing', async () => {
  const ops = await signIn('ops');
  const row = async () => (await db.query("select status, assignee, row_version, updated_at from cases where email_id='E029'")).rows[0];
  const before = await row();
  assert.equal(before.status, 'closed');
  const r = await call('/api/tickets/E029/status', { cookie: ops, body: { status: 'closed' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await row(), before);
  assert.equal((await events('status_changed')).filter((a) => a.email_id === 'E029').length, 0);
});

test('uploading an email that is already in the inbox is refused next to the form and audited', async () => {
  const ops = await signIn('ops');
  const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'inbox', 'E001.eml'), 'utf8');
  const emails = await count('emails');
  const ticket = (await db.query("select ticket_no from emails where email_id='E001'")).rows[0].ticket_no;
  const r = await call('/api/emails', { cookie: ops, body: { raw } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, new RegExp(`already in the inbox as ${ticket}`));
  assert.equal(await count('emails'), emails);
  assert.deepEqual((await events('email_duplicate')).map((a) => [a.actor, a.email_id]), [['ops', 'E001']]);
});

test('a mail that reuses a known Message-ID with other text is a new email, not a duplicate', async () => {
  const ops = await signIn('ops');
  const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'inbox', 'E001.eml'), 'utf8').replace(/\r?\n\r?\n/, '\n\nPlease cancel everything I sent before.\n');
  const r = await call('/api/emails', { cookie: ops, body: { raw } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.notEqual(r.body.email_id, 'E001');
  assert.equal((await events('email_duplicate')).length, 1, 'only the identical upload in the test above');
});

test('a flood of unknown usernames is cut at 20 a minute, says so, and does not hide wrong passwords on a real account', async () => {
  for (let i = 0; i < 25; i++) await call('/api/login', { body: { username: `nobody-${i}`, password: 'x' } });
  const recent = async (where) => (await db.query(`select count(*)::int as n from audit_events where at > now() - interval '1 minute' and ${where}`)).rows[0].n;
  assert.equal(await recent("action = 'sign_in_failed' and detail->>'reason' = 'unknown_user'"), 20);
  assert.equal(await recent("action = 'audit_throttled' and detail->>'action' = 'sign_in_failed'"), 1);

  assert.equal((await call('/api/login', { body: { username: 'admin', password: 'a guess' } })).status, 401);
  assert.equal(await recent("action = 'sign_in_failed' and detail->>'username' = 'admin' and detail->>'reason' = 'wrong_password'"), 1);
});

test('reject and closing a ticket need the role that approves it; the server checks, not the console', async () => {
  const ops = await signIn('ops');
  const before = await ticket('E006'); // CREDIT_BLOCK: Credit and AR or Admin
  assert.equal((await call('/api/tickets/E006/reject', { cookie: ops, body: { reason: 'Not ours to decide.' } })).status, 403);
  assert.equal((await call('/api/tickets/E006/status', { cookie: ops, body: { status: 'closed' } })).status, 403);
  assert.equal((await call('/api/tickets/E012/status', { cookie: ops, body: { status: 'resolved' } })).status, 403); // security flag: Admin
  assert.deepEqual(await ticket('E006'), before);
  assert.equal((await call('/api/tickets/E006/status', { cookie: ops, body: { status: 'pending_customer' } })).status, 200, 'waiting on the customer decides nothing');
  const admin = await signIn('admin');
  assert.equal((await call('/api/tickets/E012/reject', { cookie: admin, body: { reason: 'Injection attempt, not a real order.' } })).status, 200);
  assert.equal((await get('/api/tickets/E006', ops)).body.can.close, false);
  assert.equal((await get('/api/tickets/E006', admin)).body.can.close, true);
});

test('two people rejecting the same version at once: one closes it, the other is told to reload', async () => {
  const ops = await signIn('ops');
  const { row_version } = await ticket('E020');
  const res = await Promise.all([1, 2].map(() => call('/api/tickets/E020/reject', { cookie: ops, body: { reason: 'Discontinued item.', row_version } })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await events('rejected')).filter((a) => a.email_id === 'E020').length, 1);
});

test('an approval refused straight away (409 or 422) is audited', async () => {
  const ops = await signIn('ops');
  assert.equal((await call('/api/tickets/E009/approve', { cookie: ops })).status, 422); // a quote writes nothing
  assert.equal((await call('/api/tickets/E002/approve', { cookie: ops, body: { row_version: 999 } })).status, 409);
  assert.deepEqual((await events('commit_refused')).filter((a) => a.actor === 'ops').map((a) => a.email_id), ['E009', 'E002']);
});

test('an approval sets the assignee in the same write as the commit', async () => {
  const ops = await signIn('ops');
  const { row_version } = await ticket('E002');
  assert.equal((await call('/api/tickets/E002/approve', { cookie: ops, body: { row_version } })).status, 200);
  assert.deepEqual(await ticket('E002'), { status: 'resolved', assignee: 'ops', row_version: row_version + 1, erp_status: 'committed' });
});

test('an email the agent cannot process is parked for a person, with an audit row', async () => {
  const { runAgentQueue } = await import('../src/queue.js');
  // Stands in for a bug the code does not expect: every ticket write for E099 fails, except the parked one.
  await db.exec(`create function fail_e099() returns trigger language plpgsql as $$ begin
      if new.email_id = 'E099' and not new.flags @> '[{"code":"PROCESSING_ERROR"}]' then raise exception 'simulated failure'; end if;
      return new; end $$;
    create trigger fail_e099 before insert or update on cases for each row execute function fail_e099();`);
  await db.query("insert into emails (email_id, ticket_no, received_at, from_email, body) values ('E099', 'HP-1099', now(), 'odd@example.com', 'Please send 2 x HPS-1408.')");
  try { await runAgentQueue(db, { autoCommit: false }); }
  finally { await db.exec('drop trigger fail_e099 on cases; drop function fail_e099();'); }
  assert.ok((await db.query("select flags from cases where email_id='E099'")).rows[0].flags.some((f) => f.code === 'PROCESSING_ERROR'));
  assert.deepEqual((await events('processing_failed')).map((a) => [a.actor, a.email_id]), [['agent', 'E099']]);
});

test('a session that expires is audited', async () => {
  const ops = await signIn('ops');
  await db.query("update sessions set last_seen_at = now() - interval '2 hours'");
  assert.equal((await get('/api/me', ops)).status, 401);
  assert.ok((await events('session_expired')).some((a) => a.detail.username === 'ops' && a.detail.reason === 'idle'));
});

test('the audit page searches every event, not only the newest 1000, and pages', async () => {
  const ops = await signIn('ops');
  assert.equal((await call('/api/tickets/E030/comment', { cookie: ops, body: { body: 'Checked the invoice.' } })).status, 200);
  await db.query("insert into audit_events (actor, actor_type, action) select 'filler', 'system', 'filler' from generate_series(1, 1100)");
  assert.ok((await get('/api/audit?q=note', ops)).body.some((a) => a.action === 'note_added' && a.email_id === 'E030'));
  const first = (await get('/api/audit', ops)).body, second = (await get('/api/audit?offset=300', ops)).body;
  assert.equal(first.length, 300);
  assert.ok(second.length > 0 && second[0].id < first.at(-1).id);
});

// Last: a reset signs everyone out and reloads every ticket.
test('a demo reset keeps the earlier audit trail and records who reset', async () => {
  const admin = await signIn('admin');
  assert.equal((await call('/api/tickets/E019/comment', { cookie: admin, body: { body: 'Written before the reset.' } })).status, 200);
  const before = await count('audit_events');

  assert.equal((await call('/api/admin/reset', { cookie: admin })).status, 200);

  const archived = (await db.query('select actor, email_id, action from audit_archive')).rows;
  assert.equal(archived.length, before, 'every earlier event is in the archive');
  assert.ok(archived.some((a) => a.action === 'note_added' && a.actor === 'admin' && a.email_id === 'E019'));
  assert.equal((await events('seeded')).at(-1).detail.archived, before);
  assert.deepEqual((await events('demo_reset')).map((a) => [a.actor, a.actor_type]), [['admin', 'human']]);
  assert.equal((await events('note_added')).length, 0, 'the reloaded tickets start with a clean timeline');
  const admin2 = await signIn('admin');
  const old = (await get('/api/audit?archive=1&q=note', admin2)).body;
  assert.ok(old.some((a) => a.action === 'note_added' && a.actor === 'admin' && a.email_id === 'E019'), 'the console shows the archive');
});
