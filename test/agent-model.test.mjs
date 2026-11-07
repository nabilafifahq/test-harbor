// The model agent's plumbing and safety with a scripted model in place of the real one (no network):
// the tool loop, draft validation, the readers-agree check, fallback, the queue and the audit rows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-model-'));
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.LLM_MODE;
process.env.LLM_API_KEY = 'test-only';

const { getDb } = await import('../src/db.js');
const { runPipeline } = await import('../src/app.js');
const { runAgentQueue } = await import('../src/queue.js');
const { extract } = await import('../src/extract.js');
const { validateDraft } = await import('../src/model-agent.js');
const db = await getDb();

// A scripted model: turn 1 looks up the sender, turn 2 submits what the rules reader would read.
// `tweak(emailId, draft)` lets a test make it read something else, or throw to simulate an outage.
function scriptedModel(tweak = () => {}) {
  return async (model, messages) => {
    const text = messages[0].content;
    const from = text.match(/From: .*<([^>]+)>/)[1];
    const body = text.split('\n\n').slice(1).join('\n\n').replace(/\n<\/email>$/, '');
    const id = text.match(/Received: (\S+)/) && emails.find((e) => e.from_email === from && body.includes(e.body.slice(0, 40)))?.email_id;
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    if (messages.length === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_sender', arguments: JSON.stringify({ email: from }) } }] }, usage, ms: 5 };
    const r = extract(emails.find((e) => e.email_id === id));
    const draft = {
      intent: r.intent, next_action: r.intent === 'new_order' ? 'create_order' : 'escalate_to_person', customer_id: null,
      lines: r.lines.map((l) => ({ sku: l.sku || null, qty: l.qty ?? null, unit_as_written: l.unit_text || null, text: l.description || l.sku || '', customer_stated_price: l.customer_stated_price ?? null })),
      customer_po: r.customer_po, order_ref: r.references_so, requested_date_text: r.requested_date_text, questions: [], suspicious_instructions: false, language: r.language, reasoning: 'Scripted.',
    };
    tweak(id, draft);
    return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'submit_draft', arguments: JSON.stringify(draft) } }] }, usage, ms: 5 };
  };
}

let emails;
async function fresh(chatFn) {
  await runPipeline(db);
  emails = (await db.query('select * from emails')).rows;
  let s;
  for (let i = 0; i < 10; i++) { s = await runAgentQueue(db, { chatFn, budgetMs: 60000 }); if (!s.pending) break; }
  return s;
}
const cases = async () => Object.fromEntries((await db.query('select * from cases')).rows.map((r) => [r.email_id, { ...r, codes: r.flags.map((f) => f.code), check: Object.fromEntries(r.checks.map((c) => [c.code, c.pass])) }]));

test('draft validation rejects made-up shapes', () => {
  assert.ok(validateDraft({ intent: 'buy', next_action: 'create_order', lines: [], reasoning: 'x' }).length);
  assert.ok(validateDraft({ intent: 'new_order', next_action: 'create_order', lines: [{ sku: 'gloves', qty: 2 }], reasoning: 'x' }).length);
  assert.ok(validateDraft({ intent: 'new_order', next_action: 'create_order', lines: [{ sku: 'HPS-1408', qty: 2.5 }], reasoning: 'x' }).length);
  assert.equal(validateDraft({ intent: 'new_order', next_action: 'create_order', lines: [{ sku: 'HPS-1408', qty: 4 }], reasoning: 'x' }).length, 0);
});

test('queue reads all 40 with the model; only clean orders both readers agree on are written', async () => {
  const s = await fresh(scriptedModel());
  assert.equal(s.pending, 0); assert.equal(s.read_by_model, 40);
  const c = await cases();
  const auto = Object.values(c).filter((x) => x.lane === 'auto_committed').map((x) => x.email_id).sort();
  for (const id of auto) assert.ok(['E001', 'E003', 'E015', 'E038'].includes(id), `${id} must not commit on its own`);
  assert.ok(auto.includes('E001'));
  assert.equal(c.E001.check.M01, true);
  assert.ok(c.E012.codes.includes('SECURITY_INJECTION'), 'the code catches the injection even when the model misses it');
  assert.ok(c.E001.proposal.agent.usage.prompt_tokens > 0);
  assert.ok(c.E001.trace.some((t) => t.by === 'model' && t.tool === 'find_contact'));
  const audit = (await db.query("select count(*)::int as n from audit_events where action='model_read'")).rows[0].n;
  assert.equal(audit, 40);
});

test('a model that misreads a quantity stops the auto-commit', async () => {
  await fresh(scriptedModel((id, d) => { if (id === 'E001') d.lines[0].qty += 1; }));
  const c = await cases();
  assert.equal(c.E001.check.M01, false);
  assert.notEqual(c.E001.lane, 'auto_committed');
  assert.equal(c.E001.erp_status, 'none');
});

test('when the model fails, the rules reader takes over and a person approves', async () => {
  await fresh(scriptedModel((id) => { if (id === 'E003') throw new Error('HTTP 503'); }));
  const c = await cases();
  assert.ok(c.E003.codes.includes('MODEL_FALLBACK'));
  assert.equal(c.E003.lane, 'needs_review');
  assert.equal(c.E003.erp_status, 'none');
});
