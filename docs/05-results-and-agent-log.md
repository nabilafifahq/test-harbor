# Results and agent log

| Document | HP-O2C-RES-001, version 1.2, 9 November 2026 |
|---|---|

Run: all 40 emails of 2 November through the model agent (DeepSeek V4 Flash, `deepseek-ai/DeepSeek-V4-Flash-0731`, on DeepInfra), against the 07:00 ERP snapshot, scored against `data/golden_labels.json`, which the architecture agent wrote from the ERP before the build. The eval-model job in GitHub Actions runs it and saves every run on the `eval-results` branch (`runs/<time>-<run id>/`, with the model's raw readings and tool traces). The rules reader alone runs in CI on every push.

## How the 40 emails were handled

Three report runs, after the last fix; the three runs before them gave the same routing. The production deployment then read the same 40 emails live on 9 November (`/api/status`): 40 of 40 routed as labelled, intent 34 of 40, 0 unsafe, 0 missed, readers agree 30 of 37, 168 model calls, 0.0365 USD.

| Measure | Report runs | Rules reader alone |
|---|---|---|
| Routing matches the labels | 40 of 40 in each run | 40 of 40 |
| Orders written alone that should have waited | 0 in each run | 0 |
| Clean orders not written | 0 in each run | 0 |
| Intent matches the labels | 33 to 34 of 40 | 33 of 40 |
| Model finished its reading | 40 of 40, no fallback | not applicable |
| Model and rules reader read the same request | 30 of 37 | not applicable |
| Cost per run of 40 emails | 0.036 to 0.038 USD | 0 |
| Time per run, 8 emails in parallel | 135 to 156 seconds | a few seconds |

| Lane | Emails | What happened |
|---|---|---|
| Written to the ERP with no person | 4 | E001, E003, E015, E038: 6,640.80 USD. Both readers read the same SKUs, quantities and sites; every check passed |
| Needs a person | 27 | Draft ready, with the model's suggested next step and reasoning. Credit blocks, price disputes, discontinued items, stock shortfalls, the injection attempt, the unverified sender, the new prospect, the change, the cancellation, the return, the invoice question, the complaint |
| Ask the customer | 6 | Question drafted: missing quantities (E022), missing attachment (E023), boxes not cases (E026), date already passed (E032), which gloves (E035), bags or cases (E037) |
| No action | 3 | Spam, an out-of-office reply, and the resent PO SSL-7781 (E016) |

The traps all caught in every run: the "50% discount, skip review" note in E012 was ignored and routed to Admin; HPS-1035 was read as HPS-1305 and held for a person; the Spanish order (E011) was read line by line; one email for three Metro Fitness sites became three orders.

## Where it gets things wrong

- **The model varies from run to run** at temperature 0. Before the fixes below, one run read "x" as a unit, another added its own questions, another read an add-on as a change. Each variation moved one lane; none wrote an order, because the checks and the second reader caught it.
- **Intent 33 to 34 of 40.** Two naming differences (prospect, cancellation) and four same-day add-ons the labels call additions (E026, E034, E035, E037), which we keep as linked new orders. In one run E027 (a complaint that also orders clamshells) was read as a complaint where the label says new order; it lands in review either way.
- **The readers disagree on 7 emails**, each where the model reads more than the rules can: the lines of a change (E004), "the usual" rebuilt from history (E010, E036), "matching lids" (E024), items inside a return or a complaint (E018, E027), items with no quantity (E022). They wait for a person, so automation stays at the level of the rules reader for now. A second model in place of the rules reader would lift this.
- **"Next Tuesday"** on a Monday is read as tomorrow by the rules reader without a warning.

## Where the coding agents went wrong, and the fix

1. **Auto-commit trusted the model's reading.** The first architecture let a model-extracted SKU and quantity flow straight into a commit. The QA reviewer flagged it as a blocker. Fix: a commit is allowed only if every SKU and quantity also appears in the email itself (check L01).
2. **Same-day orders counted twice for credit.** Fix: credit is computed from the ERP after the writes, inside the commit transaction.
3. **A database plan that would have died on day 17.** An always-polling worker would have used up Neon's free compute hours. Caught by the reviewer from the vendor's pricing page; the deploy wakes only on requests, and the background queue does not poll while it is empty.
4. **One keystroke wrote to the ERP** in the first design, and the credit button showed 616.00 as the overage instead of 216.00. Fix: the consequence block comes first, and overage is exposure minus limit.
5. **"Our usual" picked up the agent's own order** (E036). Fix: history only counts orders before the business day.
6. **Sizes read as quantities** ("33 gal" as 33 cases). Caught by printing the reader's output for all 40 emails before wiring it in.
7. **Price disputes and substitutes routed to "ask the customer".** Fix: severe flags always go to review; the rules run went from 35 to 40 of 40.
8. **The part deciding each email was still the rules reader, with the model off.** Nabila caught it on re-reading the brief against the submission. Fix: the model agent with tool calling, the rules reader as cross-check and fallback, a background queue (tasks B13 to B18).
9. **The fallback let the rules reader write orders alone while the model was down.** Caught while writing the model-failure test. Fix: when the model fails, a person approves.
10. **The readers-agree check compared raw SKUs and ignored delivery sites.** Eval run 1 showed 10 of 37 agreeing; a screenshot of E005 with the fake model showed three sites collapsed into one while the check still passed. Fix: both readings are resolved the same way and sites are compared: 30 of 37.
11. **The model wrote "x" as the unit in "HPS-1408 x 4"**, and the clean E001 was held for a unit question (eval run 2). Fix: "x" and "qty" are not units.
12. **The model's own questions moved E021 and E027 to "ask the customer"** (eval runs 2 and 3). Fix: model questions are suggestions shown to the reviewer; only questions the code raises decide the lane.
13. **A package for one function** (`waitUntil` from `@vercel/functions`) pulled in 25 packages, AWS SDK included. Caught in the install output; replaced by the two lines it wraps.
