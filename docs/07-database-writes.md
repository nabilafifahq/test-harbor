# Database writes per action

| Document control | |
|---|---|
| Document ID | HP-O2C-DBW-001 |
| Version | 1.1, 11 November 2026 |
| Owner | Nabila |
| Status | Draft for review |
| Scope | Every statement in `src/` that writes to Postgres, grouped by the user or agent action that causes it |
| Method | Reading every write statement in `src/`, then `scripts/db-writes.mjs`: snapshot every table, run one action through the HTTP API, snapshot again, compare by primary key. `audit_archive` has no primary key, so the script does not track it; `test/audit.test.mjs` covers it |
| Database | Production: Neon Postgres through `DATABASE_URL` (Vercel integration). Local runs and tests: embedded PGlite with the same schema |
| Schema | `src/schema.sql`, except `audit_archive`, which `src/seed.js` creates |
| Standards | ISO/IEC/IEEE 42010:2022 (data view of HP-O2C-ARC-001) |

Every user action on the 40 emails, and every step the agent takes on its own, with the tables and columns it writes. The script runs against a local copy with the same code and `src/schema.sql` as production on Neon, using the recorded DeepSeek readings (`MODE=replay`), the local test model for new mail (`MODE=model`), and an unreachable model (`MODE=dead`). SO numbers in the examples come from the local run; on Neon they continue from the highest existing number.

Columns filled by a column default (`id`, `at`, `created_at`, `last_seen_at` and `updated_at` on insert, `row_version = 1`, `status = 'pending'` in `agent_reads`, `kind = 'note'` in `comments`) are marked "default".

## 1. Tables and their writers

| Table | Written by | Statements |
|---|---|---|
| `customers`, `customer_contacts`, `ship_to_addresses`, `products`, `customer_prices`, `incoming_supply` | Seed only | Insert from `data/erp/*.csv`. Credit limits, open balances, prices, contacts and products have no write path in the app |
| `sales_orders` | Seed, `commitProposal` | Insert (new order), update `status` (cancel) |
| `sales_order_lines` | Seed, `commitProposal` | Insert (new order, added line), update `qty_ordered` (change) |
| `inventory` | Seed, `commitProposal` | Update `allocated` and `available`. `on_hand` is never changed after the seed |
| `emails` | Seed, New email, inbound webhook | Insert only |
| `agent_reads` | Seed (replay), queue | Insert, update |
| `cases` | Agent decision, `commitProposal`, ticket actions, queue | Insert or upsert, update |
| `comments` | Add note | Insert only |
| `outbox` | Queue reply | Insert only |
| `audit_events` | `audit()` in `src/agent.js`, called from every path below | Insert only. No statement updates or deletes a row. A reseed drops the table after copying its rows to `audit_archive` |
| `audit_archive` | Seed | Insert only. Never dropped |
| `users` | Seed, sign-in | Insert at seed; update `failed_count`, `locked_until` |
| `sessions` | Sign-in, every signed-in request, sign-out | Insert, update `last_seen_at`, delete |
| `app_meta` | First request, Reset demo, queue | Seed claim row `seed:v4:<reader>`, process lock row `lock:process` |
| Sequences `email_seq`, `so_number_seq` | Seed, New email, `commitProposal` | `setval` at seed, `nextval` for each new email and each new sales order. Not dropped by a reseed |

## 2. User actions

"Any signed-in user" means the server checks a valid session and nothing else. Role checks come from `CAN` in `src/auth.js`.

A wrong password on a real account is always recorded; the lockout bounds it to a few a minute. Other rows with actor `anonymous` (unknown usernames, sign-in attempts on a locked account, 403s for a request without a session) cost the caller nothing, so each action keeps at most 20 a minute, counted per username where there is one. The 21st writes one `audit_throttled` row; further ones in that minute are not written. A flood of one kind therefore cannot hide another.

### 2.1 Sign-in and session

| Action | Endpoint | Writes | Audit row |
|---|---|---|---|
| Sign in | `POST /api/login` | `users.failed_count = 0`, `users.locked_until = null`. `sessions` insert: `token_hash` (SHA-256 of the cookie token), `username`, `created_at` and `last_seen_at` default | `signed_in`, actor the username |
| Sign in, wrong password | `POST /api/login` | `users.failed_count + 1`. From the fifth failure on, `users.locked_until = now() + 5 minutes`; the count goes back to 0 only on a successful sign-in, so each failure after a lock expires locks again | `sign_in_failed`, actor `anonymous`, detail `username`, `reason: wrong_password`, `failed_count`. Each time the lock is set, also `account_locked`, actor `system` |
| Sign in, locked account | `POST /api/login` | None | `sign_in_failed`, `reason: locked` |
| Sign in, unknown username | `POST /api/login` | None | `sign_in_failed`, `reason: unknown_user`. The typed username is not stored |
| Any signed-in request, page views included | Any | `sessions.last_seen_at = now()`. A session past 1 hour idle or 24 hours old is deleted instead | None |
| Sign out | `POST /api/logout` | `sessions` delete of this token | `signed_out`, actor the username |

### 2.2 Mail in

| Action | Endpoint | Who | Writes | Audit row |
|---|---|---|---|---|
| New email (form or `.eml` upload) | `POST /api/emails` | Any signed-in user | `nextval('email_seq')` gives the number: `email_id` `E` plus the number, `ticket_no` `HP-` plus 1000 and the number. `emails` insert: `email_id`, `ticket_no`, `received_at`, `from_name`, `from_email`, `subject`, `body`, `attachments`, `message_id` (from the `.eml`, empty for the form). With a model configured, `agent_reads` insert (`email_id`). Then the agent steps in section 3 | `email_received`, actor the username, `actor_type: human` |
| Upload of an email whose `Message-ID`, sender and text are already in `emails` | `POST /api/emails` | Any signed-in user | None. Refused with 409 and the ticket number the email already has. When two copies arrive at the same moment, the second has taken an email number that stays unused. A mail that reuses a `Message-ID` with another sender or other text is a new email, so a sender cannot hide someone else's mail by copying its ID | `email_duplicate` on the existing email, detail `message_id` |
| Inbound webhook | `POST /api/inbound` | Bearer `CRON_SECRET` | Same as New email. The same `Message-ID`, sender and text already in `emails` writes nothing and returns 202 with the existing `email_id` and `ticket_no`, so the provider stops retrying | `email_received`, actor `inbound`, `actor_type: system`; `email_duplicate` for a repeat |

### 2.3 Ticket actions

| Console control | Endpoint | Who | Writes | Audit row |
|---|---|---|---|---|
| Assign to me, Assign to another user, Unassign, bulk Assign | `POST /api/tickets/:id/assign` | Any signed-in user | `cases.assignee`, `cases.status` (`new` to `open`), `row_version + 1`, `updated_at` | `assigned` or `unassigned`, detail `to` |
| Status menu | `POST /api/tickets/:id/status` | Any signed-in user | `cases.status`, `assignee` when empty, `row_version + 1`, `updated_at`. The status the ticket already has writes nothing | `status_changed`, detail `from`, `to`, `note`. None when nothing changed |
| Add note | `POST /api/tickets/:id/comment` | Any signed-in user | `comments` insert: `email_id`, `author`, `body`; `kind` and `at` default. A `new` ticket also gets the status write above (`open`) | `note_added`, detail `length` |
| Queue reply | `POST /api/tickets/:id/reply` | Any signed-in user | `outbox` insert: `email_id`, `to_email`, `subject`, `body`, `sent_by`; `at` default. `cases.status` to `pending_customer` (`resolved` when already in the ERP), `assignee` when empty, `row_version + 1`, `updated_at` | `reply_queued`, detail `to`, `next_status` |
| Check prices, stock and credit | `POST /api/tickets/:id/preview` | Any signed-in user | None | None |
| Approve and write to ERP, Apply change in ERP, Cancel the order in ERP | `POST /api/tickets/:id/approve` | `CAN.approve`: Credit and AR or Admin for `CREDIT_BLOCK` and `PRICE_DISPUTE`, Admin only for `SECURITY_INJECTION`, anyone otherwise | `commitProposal` (section 4). Then `cases.assignee` when empty | `approved_and_committed` inside the commit transaction. `reviewer_edited` (detail `removed`, `added`) when the reviewer changed lines or addresses. `commit_refused` (detail `errors`) when the re-checks in section 4 refuse it |
| Reject | `POST /api/tickets/:id/reject` | Any signed-in user | `cases.status = 'closed'`, `assignee` when empty, `row_version + 1`, `updated_at` | `rejected`, detail `reason` |
| Reset demo to 07:00 | `POST /api/admin/reset` | Admin | `app_meta` delete of the `seed:%` rows, then the seed in section 6 | `demo_reset`, actor the Admin's username, written after the seed |
| Any request refused with 403 | Any | | None besides the audit row | `access_denied`, actor the username or `anonymous`, `email_id` when the path names a ticket, detail `method`, `path` (first 200 characters), `error` |

## 3. Agent and background steps

The model writes nothing itself. Its tools are read-only functions, and `src/model-agent.js` contains no SQL. The rules reader (`src/extract.js`) contains no SQL either. The queue stores the model's reading in `agent_reads`, and `processEmail` turns it into a ticket.

A run starts after new mail, after a seed, from Vercel Cron or a `CRON_SECRET` call to `/api/agent/run`, and from an open console once a minute while emails are waiting (`POST /api/agent/run`, any signed-in user). Starting a run writes nothing by itself.

| Step | Code | Writes | Audit row |
|---|---|---|---|
| Queue an email | `queue.js` `enqueue` | `agent_reads` insert: `email_id`; `status` default `pending` | None |
| Claim a wave for the model | `queue.js` `readWave` | `agent_reads.status = 'running'`, `started_at`, `attempts + 1` | None |
| Model reading finished | `queue.js` `readWave` | `agent_reads.status` (`done`, `pending` for one retry, or `failed`), `model`, `reading`, `trace`, `usage`, `error`, `finished_at` | Written at the next step |
| Process lock for lane decisions | `queue.js` `lock`, `unlock` | `app_meta` insert and delete of `lock:process`; a lock older than 5 minutes is deleted first | None |
| Decide the lane | `agent.js` `processEmail` | `cases` insert: `email_id`, `ticket_no`, `intent`, `label`, `customer_id`, `lane`, `status` (`new`, or `closed` for no action), `erp_status = 'none'`, `priority`, `sla_due_at`, `approver_role`, `summary`, `flags`, `checks`, `proposal`, `trace`, `model`. When the queue retries an email whose ticket was already inserted, the same columns except `email_id`, `ticket_no` and `erp_status` are updated, with `row_version + 1` and `updated_at` | `model_read` or `model_fallback` when the email has an `agent_reads` row (live model or replay); then `ticket_created` |
| Auto-commit | `commitProposal` with actor `agent` | Section 4 | `auto_committed` |
| Auto-commit refused at commit time | `agent.js` `processEmail` | `cases.lane = 'needs_review'`, `flags` with `COMMIT_REFUSED` added, `row_version + 1` | `commit_refused` |
| Email that fails processing twice | `queue.js` `decide` | `cases` insert: `email_id`, `ticket_no`, `intent = 'other'`, `label = 'Other'`, `lane = 'needs_review'`, `status = 'new'`, `priority = 'high'`, `summary`, `flags` with `PROCESSING_ERROR` | None (see section 8) |
| Queue empty after a run | `queue.js` `runAgentQueue` | None | `queue_drained` |

## 4. `commitProposal`, the only writer to ERP tables after the seed

One transaction. It locks the `cases` row, the `customers` row and, for a change or a cancellation, the `sales_orders` row. Before it reads or writes any stock it locks every `inventory` row the commit touches, in one statement ordered by SKU, so two commits that share SKUs wait for each other instead of deadlocking. A ticket already committed returns `already: true`. It refuses straight away a stale `row_version` (409), a security-flagged ticket for a non-Admin (403), and with 422 a ticket with no customer, a proposal that writes nothing, no line with a quantity, or an order to change or cancel that is missing or in a status that does not allow it. Otherwise it re-reads product status, price (`priceFor`), stock and credit, and refuses when a product is discontinued, stock is short, a quantity is not a whole number, a delivery address belongs to another customer, or credit fails without a release by Credit and AR.

| Proposal | ERP writes |
|---|---|
| New order | Per delivery site, `sales_orders` insert: `so_number` (`SO-` and `nextval('so_number_seq')`), `customer_id`, `ship_to_id`, `customer_po`, `order_date = BUSINESS_DATE`, `requested_date`, `status = 'OPEN'`, `source_email`, `created_by` (the actor). Per line, `sales_order_lines` insert: `so_number`, `line_no`, `sku`, `qty_ordered`, `qty_shipped = 0`, `unit_price` from `priceFor`; `inventory.allocated + qty`, `inventory.available - qty` |
| Change, new quantity | `sales_order_lines.qty_ordered`; `inventory.allocated` and `available` by the difference |
| Change, added line | `sales_order_lines` insert with the next `line_no` and `unit_price` from `priceFor`; `inventory` as for a new order |
| Cancel | Per line, `inventory.allocated` minus the unshipped quantity and `available` plus it; `sales_orders.status = 'CANCELLED'` |

On success, in the same transaction: `cases.erp_status = 'committed'`, `status = 'resolved'`, `proposal` (with `so_numbers`, `changed` or `cancelled`, `committed_by`, `committed_reason`), `row_version + 1`, `updated_at`, and the `auto_committed` or `approved_and_committed` audit row.

On any refusal every write above is rolled back, except the sequence: a number taken by `nextval` stays used. SO numbers are taken only after every line passed its checks, so only a credit refusal, which runs after the lines are written, leaves a gap in the SO numbers. When the re-checks refused it, the caller writes `commit_refused` with the reasons outside the transaction, so the attempt stays on record although nothing reached the ERP. The agent's own auto-commit writes `commit_refused` for every refusal.

`customers.open_balance` and `customers.credit_limit` are read for the credit check and never written. A second commit of a committed ticket writes nothing and returns `already: true`.

## 5. By email use case

| Use case | Emails | Action (role) | Writes |
|---|---|---|---|
| Clean order | E001, E003, E015, E038 | None needed. Reject returns 409 and writes nothing | Written by the agent at seed |
| Order for review | E002; E005 (three sites, three orders); E010 and E036 (from history); E011 (Spanish); E013 (unverified sender); E021 (SKU corrected); E031, E034, E039, E040 | Approve and write to ERP (Operations) | `sales_orders` one per site (created_by the user), `sales_order_lines` one per line (unit price from `priceFor`), `inventory` per SKU, `cases` (erp_status `committed`, status `resolved`, proposal with SO numbers, assignee if empty, row_version, updated_at). Audit `approved_and_committed` |
| Credit block | E006, E007, E027 | Approve with credit release and a reason (Credit and AR). Operations gets 403 | As above; the reason is in the audit detail. The 403 writes only the audit row `access_denied` |
| Reviewer edit | E006 | Change a quantity, then approve (Credit and AR) | As above, plus audit `reviewer_edited` with removed and added lines |
| Price dispute | E024, E025 | Approve (Credit and AR) | As above; the price comes from the ERP |
| Injection attempt | E012 | Approve (Admin). Operations gets 403 | As above. The 403 writes only `access_denied` |
| Stock short or discontinued | E008, E020, E033 | Approve, refused with 422 | Audit `commit_refused` with the errors only. ERP and `cases` unchanged |
| Rejected draft | E019 | Reject with a reason (Operations) | `cases` (status `closed`, assignee, row_version, updated_at). Audit `rejected` |
| Order change | E004 | Approve (Operations) | `sales_order_lines` on SO-24051: line 1 quantity 20 to 25, new line 4 for 5 soap refills. `inventory`, `cases`, audit. No new order |
| Cancellation | E017 | Approve (Operations) | `sales_orders` SO-24055 `OPEN` to `CANCELLED`, `inventory` allocated down and available up, `cases`, audit. Lines stay |
| Quote | E009 | Approve returns 422 and writes nothing. Reply (Operations) | `outbox` (to_email, subject "Re: ...", body, sent_by), `cases` status `pending_customer`. Audit `reply_queued` |
| Routed | E014 prospect (Operations), E018 return and E030 invoice (Credit and AR) | Reply | As for the quote |
| Ask the customer | E022, E023, E026, E032, E035, E037 | Reply with the drafted question (Operations) | `outbox`, `cases` `new` to `pending_customer`. Audit `reply_queued`. The customer's answer arrives as a new email and a new ticket |
| No action | E016 (PO sent again), E028 (out of office), E029 (spam) | None | `closed` since seed |

## 6. Seed and demo reset

The seed runs on the first request after a deploy, when the reader mode changes (rules, replay or model), when the seed version in `src/app.js` changes with the schema, and on Reset demo.

1. `app_meta` is created if missing. The instance that inserts the claim row `seed:v4:<reader>` with `v = 'running'` seeds; the others wait. A claim older than 2 minutes is deleted and claimed again.
2. `audit_archive` is created if missing. Every row of `audit_events` is copied into it: `id`, `at`, `actor`, `actor_type`, `email_id`, `action`, `detail`, plus `archived_at = now()`.
3. Every other table is dropped and recreated from `src/schema.sql`: the nine ERP tables, `emails`, `cases`, `comments`, `outbox`, `agent_reads`, `audit_events`, `users`, `sessions`. Everyone is signed out. The two sequences are created if missing and kept.
4. ERP tables are loaded from `data/erp/*.csv`, `emails` from `data/inbox/*.eml` with each file's `Message-ID`, `users` with an Argon2id hash of `DEMO_PASSWORD`. `email_seq` is set so the next email is the count of emails plus one; `so_number_seq` so the next order is the highest loaded SO number plus one.
5. `audit_events` gets `seeded`, actor `system`, detail `emails` and `archived` (rows copied in step 2).
6. Replay mode inserts one `agent_reads` row per recorded reading. Model mode queues every email in `agent_reads`. Rules mode runs every email through section 3 at once.
7. The claim row is set to `v = 'done'`.
8. Reset demo only: `demo_reset` with the Admin's username.

## 7. Audit actions

| `action` | `actor` | `actor_type` | `email_id` | `detail` |
|---|---|---|---|---|
| `seeded` | `system` | `system` | none | `emails`, `archived` |
| `demo_reset` | Admin's username | `human` | none | empty |
| `signed_in` | username | `human` | none | empty |
| `sign_in_failed` | `anonymous` | `human` | none | `reason` (`wrong_password`, `locked`, `unknown_user`); `username` except for `unknown_user`; `failed_count` for `wrong_password` |
| `account_locked` | `system` | `system` | none | `username`, `failed_count` |
| `audit_throttled` | `anonymous` | `human` | none | `action`, `username` when the cut rows had one, `per_minute` |
| `signed_out` | username | `human` | none | empty |
| `access_denied` | username or `anonymous` | `human` | ticket in the path, if any | `method`, `path`, `error` |
| `email_received` | username, or `inbound` | `human`, or `system` for the webhook | the new email | `email_id`, `ticket_no`, `from`, `source` (`form` or `eml`) |
| `email_duplicate` | username, or `inbound` | `human`, or `system` for the webhook | the email with the same `Message-ID`, sender and text | `message_id` |
| `model_read`, `model_fallback` | `agent` | `agent` | the email | `model`, `tools`, `next_action`, `calls`, `prompt_tokens`, `completion_tokens`, `ms`, `cost_usd`, `error` on a fallback |
| `ticket_created` | `agent` | `agent` | the email | `lane`, `intent`, `priority`, `model`, `flags` |
| `auto_committed` | `agent` | `agent` | the email | `so_numbers`, `changed` or `cancelled`; `credit_released`, `value`, `reason`, `edited` |
| `approved_and_committed` | username | `human` | the email | as `auto_committed` |
| `commit_refused` | `agent` or username | `agent` or `human` | the email | `errors` |
| `reviewer_edited` | username | `human` | the email | `removed`, `added` (`<ship-to> <SKU> x <qty>`) |
| `rejected` | username | `human` | the email | `reason` |
| `assigned`, `unassigned` | username | `human` | the email | `to` |
| `status_changed` | username | `human` | the email | `from`, `to`, `note` |
| `note_added` | username | `human` | the email | `length` |
| `reply_queued` | username | `human` | the email | `to`, `next_status` |
| `queue_drained` | `agent` | `agent` | none | `total`, `read_by_model`, `model_failed` |

## 8. Not recorded, and known gaps

Fixed since version 1.0 of this document: a reset erased the audit trail and did not say who reset; sign-out, wrong passwords, lockouts and 403s wrote no audit row; reject and assign did not move `cases.updated_at`; setting the status a ticket already had wrote a `status_changed` row; two emails or two approvals at the same moment could fail with a duplicate key, and two approvals sharing SKUs could deadlock; the same mail delivered twice made two tickets.

- Reject and the Status menu have no role check. Any signed-in user can close a ticket that waits for Credit and AR or for Admin, including a security-flagged one. The `rejected` or `status_changed` row records who did it.
- Reject accepts `row_version` from the console but does not compare it, so two people rejecting at once both succeed.
- A person's approval refused straight away with 409 or 422 (section 4) leaves no audit row. Only refusals from the re-checks write `commit_refused`; a 403 writes `access_denied`.
- An email parked with `PROCESSING_ERROR` gets a ticket and no audit row.
- A request without a session (401) and a session that expires write no audit row.
- Mail typed into the form has no `Message-ID`, so the same text typed twice makes two tickets. When the text names a customer PO, check D01 flags the second one (`DUPLICATE` and no action when the lines are the same).
- After an approval, `cases.assignee` is set by a second statement outside the commit transaction, without `row_version` or `updated_at`. The commit set `updated_at` a moment earlier.
- Auto-commit refused at commit time updates `cases` without `updated_at`. The ticket insert set it a moment earlier.
- The copy to `audit_archive` and the drop of `audit_events` are separate statements. If the process stops between them, the retry copies the same rows again: duplicates in the archive, nothing lost.
- Above 20 a minute of one anonymous action (per username where there is one), further rows are not recorded; one `audit_throttled` row marks the cut. Wrong passwords on real accounts are never cut. The console's audit page shows the latest 1000 rows, so a long flood pushes older events off that page; they stay in the table and on each ticket's own timeline.
- `audit_archive` has no screen in the console. Read it with SQL, for example `select * from audit_archive order by archived_at desc, id desc`.

## 9. Run it again

```bash
node scripts/db-writes.mjs                     # MODE=replay: all user actions on the 40 emails
FAKE_DELAY_MS=20 node test/fake-model.mjs &    # local test model on port 3600
MODE=model node scripts/db-writes.mjs          # new mail, webhook and agent run
MODE=dead node scripts/db-writes.mjs           # what is written when the model is unreachable
```

Each run uses a fresh database in a temporary folder and prints every step with its HTTP status and the rows it changed.

The races in section 8 need a Postgres server that runs requests side by side. `test/concurrency.test.mjs` sends eight new emails at once, the same mail twice at once through the webhook, two approvals at once, and two approvals that take the same two SKUs in opposite order. Against a database it may wipe:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/scratch node --test test/concurrency.test.mjs
```
