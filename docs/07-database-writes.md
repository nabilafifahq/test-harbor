# Database writes per action

| Document control | |
|---|---|
| Document ID | HP-O2C-DBW-001 |
| Version | 1.0, 11 November 2026 |
| Owner | Nabila |
| Status | Draft for review |
| Method | `scripts/db-writes.mjs`: snapshot every table, run one action through the HTTP API, snapshot again, compare by primary key |
| Standards | ISO/IEC/IEEE 42010:2022 (data view of HP-O2C-ARC-001) |

Every user action on the 40 emails, and every step the agent takes on its own, with the tables and columns it writes. Run against a local copy with the same code and `src/schema.sql` as production on Neon, using the recorded DeepSeek readings (`MODE=replay`), the local test model for new mail (`MODE=model`), and an unreachable model (`MODE=dead`). SO numbers in the examples come from the local run; on Neon they continue from the highest existing number.

## 1. Table groups

| Group | Tables | Written after seed? |
|---|---|---|
| ERP | `sales_orders`, `sales_order_lines`, `inventory` | Yes, only by `commitProposal` |
| ERP master | `customers`, `customer_contacts`, `ship_to_addresses`, `products`, `customer_prices`, `incoming_supply` | No. Credit exposure is computed from open orders, so `open_balance` is never changed |
| Tickets | `emails`, `agent_reads`, `cases`, `comments`, `outbox` | Yes |
| Trail and sign-in | `audit_events`, `users`, `sessions`, `app_meta` | Yes |

## 2. System and agent writes

| Event | Writes |
|---|---|
| First request after a deploy | Every ERP table from the snapshot, `emails` (40), `users` (3), `app_meta` seed key, audit `seeded` |
| The model reads an email | `agent_reads`: status, attempts, model, reading, trace, usage, started_at, finished_at. Audit `model_read` |
| The ticket is created | `cases`: lane, status (`new`, or `closed` for no-action), priority, sla_due_at, approver_role, summary, flags, checks, proposal, trace, model. Audit `ticket_created` |
| Auto-commit (E001, E003, E015, E038) | `sales_orders` (created_by `agent`, status `OPEN`, source_email), `sales_order_lines`, `inventory` (allocated up, available down), `cases` (erp_status `committed`, status `resolved`). Audit `auto_committed` |
| Queue empty | Audit `queue_drained` |
| Model unreachable | `agent_reads` status `failed` with the error. Audit `model_fallback`. No auto-commit: the four clean orders wait for review |
| New email from the console form | `emails` (E041 onwards), audit `email_received` with the user as actor, then the rows above, including auto-commit when every check passes |
| Webhook `POST /api/inbound` | The same, with actor `inbound` (system) |

## 3. By email use case

| Use case | Emails | Action (role) | Writes |
|---|---|---|---|
| Clean order | E001, E003, E015, E038 | None needed. Reject returns 409 and writes nothing | Written by the agent at seed |
| Order for review | E002; E005 (three sites, three orders); E010 and E036 (from history); E011 (Spanish); E013 (unverified sender); E021 (SKU corrected); E031, E034, E039, E040 | Approve and write to ERP (Operations) | `sales_orders` one per site (created_by the user), `sales_order_lines` one per line (unit price from `priceFor`), `inventory` per SKU, `cases` (erp_status `committed`, status `resolved`, proposal with SO numbers, assignee if empty, row_version, updated_at). Audit `approved_and_committed` |
| Credit block | E006, E007, E027 | Approve with credit release and a reason (Credit and AR). Operations gets 403 and nothing is written | As above; the reason is in the audit detail |
| Reviewer edit | E006 | Change a quantity, then approve (Credit and AR) | As above, plus audit `reviewer_edited` with removed and added lines |
| Price dispute | E024, E025 | Approve (Credit and AR) | As above; the price comes from the ERP |
| Injection attempt | E012 | Approve (Admin). Operations gets 403 | As above |
| Stock short or discontinued | E008, E020, E033 | Approve, refused with 422 | Audit `commit_refused` with the errors only. ERP and `cases` unchanged |
| Rejected draft | E019 | Reject with a reason (Operations) | `cases` (status `closed`, assignee). Audit `rejected` |
| Order change | E004 | Approve (Operations) | `sales_order_lines` on SO-24051: line 1 quantity 20 to 25, new line 4 for 5 soap refills. `inventory`, `cases`, audit. No new order |
| Cancellation | E017 | Approve (Operations) | `sales_orders` SO-24055 `OPEN` to `CANCELLED`, `inventory` allocated down and available up, `cases`, audit. Lines stay |
| Quote | E009 | Approve returns 422 and writes nothing. Reply (Operations) | `outbox` (to_email, subject "Re: ...", body, sent_by), `cases` status `pending_customer`. Audit `reply_queued` |
| Routed | E014 prospect (Operations), E018 return and E030 invoice (Credit and AR) | Reply | As for the quote |
| Ask the customer | E022, E023, E026, E032, E035, E037 | Reply with the drafted question (Operations) | `outbox`, `cases` `new` to `pending_customer`. Audit `reply_queued`. The customer's answer arrives as a new email and a new ticket |
| No action | E016 (PO sent again), E028 (out of office), E029 (spam) | None | `closed` since seed |

## 4. Actions on any ticket

| Action | Writes |
|---|---|
| Sign in | `sessions` (token_hash, username, created_at, last_seen_at), `users` failed_count to 0. Audit `signed_in` |
| Wrong password | `users.failed_count` up by one. No audit |
| Five wrong passwords | `users.locked_until` set. No audit |
| Open the queue, a ticket, stock, audit or results | `sessions.last_seen_at` only |
| Assign or unassign | `cases` (assignee, status `new` to `open`, row_version). Audit `assigned` or `unassigned` |
| Internal note | `comments` (author, body, kind `note`), `cases` status to `open` and assignee. Audit `note_added` |
| Set status by hand | `cases` (status, row_version, updated_at). Audit `status_changed` with from, to and note |
| Preview an edit; approve twice; reject a written ticket; any 403 | Nothing |
| Sign out | `sessions` row deleted. No audit |
| Reset the demo (Admin) | Back to the snapshot: added orders and lines deleted, `inventory` restored, added emails, `comments` and `outbox` emptied, `audit_events` emptied and reseeded, every session deleted, password hashes recomputed |

## 5. Gaps found

1. **Reset erases the audit trail** and leaves no row saying who reset. This conflicts with rule 5 in `CLAUDE.md`.
2. Sign out, wrong passwords, lockouts and 403 attempts write no audit row.
3. Reject and assign do not update `cases.updated_at`; approve, reply, note and status do.
4. Setting a closed ticket to closed still writes a `status_changed` row.

## 6. Run it again

```bash
node scripts/db-writes.mjs                     # MODE=replay: all user actions on the 40 emails
FAKE_DELAY_MS=20 node test/fake-model.mjs &    # local test model on port 3600
MODE=model node scripts/db-writes.mjs          # new mail, webhook and agent run
MODE=dead node scripts/db-writes.mjs           # what is written when the model is unreachable
```

Each run uses a fresh database in a temporary folder and prints every step with its HTTP status and the rows it changed.
