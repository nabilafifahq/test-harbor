// Runs the 40-email inbox through the model agent and scores it against data/golden_labels.json.
// Needs LLM_API_KEY (DeepInfra by default). Writes eval/<model>.json and a Markdown summary
// (also to the GitHub Actions job summary when it runs in CI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-eval-'));
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;
const { llmConfigured, llmModel } = await import('../src/llm.js');
if (!llmConfigured()) { console.error('Set LLM_API_KEY (or LLM_BASE_URL for a local model) first.'); process.exit(2); }

const { getDb } = await import('../src/db.js');
const { runPipeline, results } = await import('../src/app.js');
const { runAgentQueue } = await import('../src/queue.js');
const db = await getDb();
const t0 = Date.now();
await runPipeline(db);
let s;
for (let i = 0; i < 20; i++) { s = await runAgentQueue(db, { budgetMs: 600000 }); console.log(`run ${i + 1}: processed ${s.processed}/${s.total}, model read ${s.read_by_model}, model failed ${s.model_failed}`); if (!s.pending) break; }
const r = await results(db);
const cases = Object.fromEntries((await db.query('select email_id, lane, intent, flags, checks, proposal, model from cases')).rows.map((c) => [c.email_id, c]));
const reads = (await db.query('select email_id, status, usage, error from agent_reads')).rows;
const sum = (k) => reads.reduce((a, x) => a + (Number(x.usage?.[k]) || 0), 0);
const agreeM01 = Object.values(cases).filter((c) => c.checks.some((k) => k.code === 'M01' && k.pass)).length;
const withM01 = Object.values(cases).filter((c) => c.checks.some((k) => k.code === 'M01')).length;
const nextActions = {};
for (const c of Object.values(cases)) { const a = c.proposal.agent?.next_action || 'none'; nextActions[a] = (nextActions[a] || 0) + 1; }
const out = {
  model: llmModel(), run_at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
  lanes: r.lanes, lane_agreement: r.lane_agreement, intent_agreement: r.intent_agreement, scored: r.scored,
  unsafe_auto_commits: r.unsafe_auto_commits, missed_auto_commits: r.missed_auto_commits, orders_written: r.orders_written, value_written: r.value_written,
  model_read_ok: reads.filter((x) => x.status === 'done').length, model_failed: reads.filter((x) => x.status === 'failed').length,
  readers_agree: agreeM01, readers_compared: withM01, next_actions: nextActions,
  model_calls: sum('calls'), prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens'), cost_usd: Math.round(sum('cost_usd') * 10000) / 10000, model_seconds: Math.round(sum('ms') / 1000),
  per: r.per.map((p) => ({ email_id: p.email_id, lane: p.lane, expected_lane: p.expected_lane, intent: p.intent, expected_intent: p.expected_intent,
    flags: cases[p.email_id].flags.map((f) => f.code), next_action: cases[p.email_id].proposal.agent?.next_action || null,
    reasoning: cases[p.email_id].proposal.agent?.reasoning || null, error: reads.find((x) => x.email_id === p.email_id)?.error || null,
    failed_checks: cases[p.email_id].checks.filter((k) => !k.pass).map((k) => `${k.code}: ${k.detail}`.slice(0, 160)) })),
};
fs.mkdirSync('eval', { recursive: true });
const file = path.join('eval', `${out.model.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
const md = [
  `## Model eval: ${out.model}`,
  '',
  `| Measure | Value |`, `|---|---|`,
  `| Routing matches labels | ${out.lane_agreement}/${out.scored} |`, `| Intent matches labels | ${out.intent_agreement}/${out.scored} |`,
  `| Written alone that should have waited | ${out.unsafe_auto_commits} |`, `| Clean orders not written | ${out.missed_auto_commits} |`,
  `| Model finished its reading | ${out.model_read_ok}/40 (fell back ${out.model_failed}) |`, `| Model and rules read the same lines | ${out.readers_agree}/${out.readers_compared} |`,
  `| Model calls, tokens in / out | ${out.model_calls}, ${out.prompt_tokens} / ${out.completion_tokens} |`, `| Cost | ${out.cost_usd} USD |`, `| Wall time | ${out.seconds} s |`,
  '', '### Lane differences', '', '| Email | Got | Labelled | Flags | Failed checks | Model said |', '|---|---|---|---|---|---|',
  ...out.per.filter((p) => p.lane !== p.expected_lane).map((p) => `| ${p.email_id} | ${p.lane} | ${p.expected_lane} | ${p.flags.join(' ')} | ${p.failed_checks.join('<br>').replace(/\|/g, '/')} | ${(p.next_action || '')}: ${(p.reasoning || p.error || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '', '### Intent differences', '', ...out.per.filter((p) => p.intent !== p.expected_intent).map((p) => `- ${p.email_id}: ${p.intent} (labelled ${p.expected_intent})`),
].join('\n');
fs.writeFileSync(file.replace(/\.json$/, '.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);
process.exit(out.unsafe_auto_commits ? 1 : 0);
