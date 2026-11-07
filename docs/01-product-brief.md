# Product brief: Harbor Point Order Desk

| Document | HP-O2C-PB-001 |
|---|---|
| Version | 1.1, 7 November 2026 |
| Owner | Nabila |
| Status | Submitted |
| Standards | ISO/IEC 25010:2023 quality model for the success measures; OWASP Top 10:2025 and OWASP Top 10 for LLM Applications 2025 for the security controls |

## Who uses it

The order desk team at Harbor Point Supply: three to five people who spend the morning turning customer emails into ERP orders. Two other roles touch the work. Credit and AR decide on credit holds, price exceptions, returns and invoice disputes. An admin owns security flags and the system itself.

## The problem

Forty emails arrived on Monday 2 November between 07:02 and 11:18. Four of them are clean orders a person retypes without thinking. The other thirty-six each hide a reason to stop: a customer on credit hold, a discontinued glove, a SKU with two digits swapped, a price "Mike offered" on the phone, an order in Spanish, a forwarded PO sent twice, an email telling "the automated system" to give 50% off. Today a person finds these by reading carefully and checking four ERP screens. The typing is slow, and the checking is where the expensive mistakes happen.

## What we built

An order desk where every email becomes a ticket and an agent does the reading and the lookups.

1. **New mail is queued** and processed in the background: the morning inbox, a form in the console, or a mail provider's webhook. Nobody waits on a screen.
2. **A language model reads** each email (DeepSeek V4 Flash on DeepInfra) and works through ten read-only ERP tools: sender to customer, ship-to, catalog search, contract or list price, stock and incoming supply, credit, existing orders, order history. It submits a draft with the request type, the lines per delivery site, the questions it would ask, and a suggested next step with its reasoning.
3. **A second reader cross-checks it.** Deterministic rules read the same email. If the model fails, the rules reading is used and nothing is written without a person.
4. **Code decides the lane** with twelve checks. The model never decides whether something is safe.
5. **People decide the rest** in a console built like an email client: queue by priority and due time, search with operators, filters, a Work next button, and a ticket page that shows the email, the draft, the checks, the agent's steps, and what approval will change before anyone clicks.

## Where the line sits

**The agent acts alone** when a new order passes all twelve checks: it is a new order; the sender is a registered contact, verified, of an active account; every SKU and quantity was written by the customer (a price the customer states also fails this one); every product is active; stock covers every line; credit holds after the order; the PO is new; nothing needs asking; the email gives no instructions to the system; and the model and the rules reader read the same items, quantities and delivery sites. Four of the forty emails qualify. These are the orders where a person adds nothing but typing time.

**A person decides** everything with judgement in it: credit (Credit and AR role), prices that differ from ours, substitutes, unclear units, changes and cancellations of existing orders, returns, unknown senders, stock shortfalls, and injection attempts (Admin role).

**Nobody can do it from this app**: change prices or credit limits, edit shipped orders, delete records, or send email directly. Those tools do not exist, so a model cannot be talked into using them.

The commit is plain code. It runs in one database transaction, re-reads price, stock, status and credit at that moment, and refuses if anything changed since the draft.

## What we did not build

- A direct IMAP or Microsoft Graph mailbox. Mail arrives as `.eml` files, through the console, or through a webhook a mail provider can call; replies go to an outbox table.
- Reading PDF or spreadsheet attachments (E023 refers to a PO that never arrived; the agent asks for it).
- Merging same-day follow-ups into the earlier draft. They become linked tickets.
- Letting the model's own questions route a ticket to the customer. They are shown to the reviewer as suggestions; only questions the code raises move a ticket to Waiting.

## How we would measure it in production

| Measure | Target | Why |
|---|---|---|
| Wrong orders written without a person | 0 per month | The whole design rests on this |
| Share of emails written to the ERP with no human edit | Grows from today's 10% as the reader improves; each new lane starts in shadow mode | Value of the automation |
| Time from email to order written, median | Under 15 minutes for clean orders, under 2 hours for reviewed ones | Customer experience |
| Reviewer edits per approved draft | Falling week on week | Reader quality |
| Tickets past due time | Under 5% | Team load |
| Lane agreement on a weekly labelled sample of 50 emails | 95% or higher before any lane is switched on | Safe rollout |

## Assumptions

1. Credit exposure is open balance plus unshipped value of open orders plus the new order. The README rule names only the balance, but an order written an hour ago is real exposure too.
2. Stock is allocated when the order is written, first come first served by arrival time. Drafts do not hold stock; that keeps a stalled ticket from blocking a clean one.
3. "Thursday" and similar mean the coming day of this week (5 November). It is how the team reads them.
4. A date already in the past (E032, "Friday October 30") is asked about, never guessed.
5. A sender at a customer's domain who is not a registered contact (E013) is unverified until the registered contact confirms.
6. "Our usual" means the lines common to the customer's last two orders placed before today.
7. A resend with the same PO and the same lines is a duplicate; same PO with different lines is a revision for a person.
8. A case with the selling unit unclear ("6 boxes" of gloves sold by the case) is asked, never rounded.
9. Contract prices apply only inside their dates (E024's $70 expired on 30 September).
10. Auto-replies are never answered, to avoid mail loops.
11. Demo due times use a fixed clock of 12:00 on 2 November so priorities read correctly.
12. A same-day add-on that names no order (E026, "add these, sorry I forgot this morning") is a new order linked to the earlier ticket, not a change. Without a reference, changing an order would be a guess.
13. When the model and the rules reader disagree, a person decides. Two readers agreeing is the bar for writing without one.

## Hosting today and the path to production

The demo runs on Vercel with Postgres from the Vercel Neon integration. For real use we would move to a company `.com` domain with single sign-on, finer roles and approval limits, an OWASP ASVS level 2 baseline, and hosting on a VPS or Harbor Point's own hardware. The model can move to a local one (Ollama or llama.cpp) for data that must stay in-house, or a second API model can sit in the fallback chain before the rules reader, always behind the same checks and scored with the same eval first. Production also needs a direct mailbox connection feeding the existing queue, a dead-letter view, and a short guided onboarding for new reviewers.
