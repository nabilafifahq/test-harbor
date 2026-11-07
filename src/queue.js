// Background processing of the inbox. Two phases:
// A. The model reads queued emails in parallel. Its tools are read-only, so the order does not matter.
// B. Plain code runs the checks and decides each lane strictly in arrival order, because duplicates,
//    stock and credit depend on what earlier emails did. Only one worker runs phase B at a time.
// A run stops before the function time limit; whatever is left is picked up by the next run.
import { processEmail, buildMatcher, audit } from './agent.js';
import { modelRead } from './model-agent.js';
import { llmConfigured, llmModel } from './llm.js';

const iso = (d) => new Date(d).toISOString();

export async function enqueue(db, emailIds = null) {
  if (!llmConfigured()) return;
  if (emailIds) for (const id of emailIds) await db.query("insert into agent_reads (email_id) values ($1) on conflict do nothing", [id]);
  else await db.query("insert into agent_reads (email_id) select email_id from emails on conflict do nothing");
}

export async function queueStatus(db) {
  const r = (await db.query(`select count(*)::int as total,
      count(c.email_id)::int as processed,
      count(*) filter (where r.status = 'done')::int as read_by_model,
      count(*) filter (where r.status = 'failed')::int as model_failed,
      count(*) filter (where r.status in ('pending','running'))::int as waiting_for_model
    from emails e left join agent_reads r using (email_id) left join cases c using (email_id)`)).rows[0];
  return { ...r, pending: r.total - r.processed, model: llmModel() };
}

async function lock(db, name, staleMs) {
  await db.exec('create table if not exists app_meta (k text primary key, v text, at timestamptz default now())');
  await db.query("delete from app_meta where k=$1 and at < now() - make_interval(secs => $2)", [`lock:${name}`, staleMs / 1000]);
  return (await db.query("insert into app_meta (k, v) values ($1,'held') on conflict (k) do nothing returning k", [`lock:${name}`])).rows.length > 0;
}
const unlock = (db, name) => db.query('delete from app_meta where k=$1', [`lock:${name}`]);

export async function runAgentQueue(db, { budgetMs = Number(process.env.AGENT_BUDGET_MS || 230000), concurrency = Number(process.env.AGENT_CONCURRENCY || 8), autoCommit = true, chatFn } = {}) {
  const deadline = Date.now() + budgetMs;
  const matcher = await buildMatcher(db);

  // Phase A: claim a wave of emails and let the model read them in parallel.
  const readWave = async () => {
    if (!llmConfigured() || deadline - Date.now() < Math.min(100000, budgetMs / 2)) return 0; // room for a slow email
    const claimed = (await db.query(`update agent_reads set status='running', started_at=now(), attempts=attempts+1
        where email_id in (select r.email_id from agent_reads r join emails e using (email_id)
          where r.status='pending' or (r.status='running' and r.started_at < now() - interval '5 minutes')
          order by e.received_at limit $1 for update skip locked)
        returning email_id, attempts`, [concurrency])).rows;
    await Promise.all(claimed.map(async ({ email_id, attempts }) => {
      const e = (await db.query('select * from emails where email_id=$1', [email_id])).rows[0];
      const r = await modelRead(db, { ...e, received_at: iso(e.received_at) }, matcher, { budgetMs: Math.min(120000, deadline - Date.now() - 5000), chatFn });
      // One retry for a failed read; after that the rules reader takes the email.
      const status = r.reading ? 'done' : attempts < 2 ? 'pending' : 'failed';
      await db.query('update agent_reads set status=$2, model=$3, reading=$4::jsonb, trace=$5::jsonb, usage=$6::jsonb, error=$7, finished_at=now() where email_id=$1',
        [email_id, status, r.model, JSON.stringify(r.reading || null), JSON.stringify(r.trace), JSON.stringify(r.usage), r.error || null]);
    }));
    return claimed.length;
  };

  // Phase B: checks and lanes for every email that is ready, in arrival order, by one worker at a time.
  const decide = async () => {
    if (!(await lock(db, 'process', 300000))) return 0;
    let n = 0;
    try {
      const todo = (await db.query(`select e.*, r.status as read_status, r.model as read_model, r.reading, r.trace as read_trace, r.usage as read_usage, r.error as read_error
          from emails e left join agent_reads r using (email_id) left join cases c using (email_id)
          where c.email_id is null order by e.received_at`)).rows;
      for (const e of todo) {
        if (Date.now() > deadline) break;
        if (['pending', 'running'].includes(e.read_status)) break; // keep arrival order: wait for this email's reading
        const read = e.read_status ? { model: e.read_model || llmModel(), reading: e.reading, trace: e.read_trace || [], usage: e.read_usage || {}, error: e.read_error || (e.reading ? null : 'no reading') } : null;
        const email = { ...e, received_at: iso(e.received_at) };
        try { await processEmail(db, email, { autoCommit, matcher, read }); }
        catch (err) {
          // One bad email must not block the queue: retry with the rules reader, then park it for a person.
          console.error('[agent] processing failed', e.email_id, err);
          try { await processEmail(db, email, { autoCommit: false, matcher }); }
          catch (err2) {
            await db.query(`insert into cases (email_id, ticket_no, intent, label, lane, status, priority, summary, flags) values ($1,$2,'other','Other','needs_review','new','high',$3,$4::jsonb) on conflict do nothing`,
              [e.email_id, e.ticket_no, 'The agent could not process this email. Read it and handle it by hand.', JSON.stringify([{ code: 'PROCESSING_ERROR', text: String(err2.message || err2).slice(0, 300), severity: 'bad' }])]);
          }
        }
        n++;
      }
    } finally { await unlock(db, 'process'); }
    return n;
  };

  // Tickets appear wave by wave instead of all at the end.
  let processed = 0;
  for (;;) {
    const read = await readWave();
    processed += await decide();
    if (!read) break;
  }
  const s = await queueStatus(db);
  if (processed && !s.pending) await audit(db, 'agent', 'agent', null, 'queue_drained', { total: s.total, read_by_model: s.read_by_model, model_failed: s.model_failed }).catch(() => {});
  return { ...s, processed_now: processed };
}
