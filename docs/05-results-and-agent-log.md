# Results and agent log

Run: all 40 emails of 2 November, reader in deterministic mode (no model), against the 07:00 ERP snapshot. Same result in CI on every push. Expected routing comes from `data/golden_labels.json`, written by the architecture agent from the ERP before the build started.

## How the 40 emails were handled

| Lane | Emails | What happened |
|---|---|---|
| Written to the ERP with no person | 4 | E001, E003, E015, E038: 6,640.80 USD, every SKU and quantity written by the customer, contract prices applied for Pinecrest and Seaside |
| Needs a person | 27 | Draft ready. 2 credit blocks (Oak & Ember 216.00 over, Coastal Catering on hold), 2 price disputes, 2 discontinued items, 5 stock shortfalls, 1 injection attempt, 1 unverified sender, 1 new prospect, a change, a cancellation, a return, an invoice question, a complaint |
| Ask the customer | 6 | Question drafted: missing quantities (E022), missing attachment (E023), boxes not cases (E026), date already passed (E032), which gloves (E035), 5 bags or 5 cases (E037) |
| No action | 3 | Spam, an out-of-office reply, and the resent PO SSL-7781 (E016) |

Routing matches the labels on **40 of 40**. Orders written that should have waited: **0**. Clean orders held back: **0**. The traps all caught: the "50% discount, skip review" note in E012 was ignored and routed to Admin; HPS-1035 was read as HPS-1305 but held for a person; the Spanish order (E011) was read line by line; one email for three Metro Fitness sites became three orders.

## Where it gets things wrong

- **Intent labels match on 33 of 40.** One is naming (cancellation vs order_cancellation). Four are same-day add-ons (E026, E034, E035, E037) that we keep as separate tickets linked to the earlier one, where the labels call them additions. E014 is labelled a prospect; we route it to sales the same way but name it a new order. E027 is labelled a new order; we treat the complaint first and do not draft the clamshells it asks for.
- **No context across lines.** E024's "matching lids" is read alone, so it is ambiguous between two lids and the customer is asked, though a person would know it means the hot-cup lids.
- **"Next Tuesday"** on a Monday is read as tomorrow without a warning.
- **The rules reader is fitted to this inbox.** New phrasing lands in review rather than in the wrong order, which is safe but lowers the automation rate. That is what the optional model reader is for.
- **Reviewers can change quantities but not swap a SKU** in the console. A substitution goes back to the customer as a question.

## Where the coding agents went wrong, and the fix

1. **Auto-commit trusted the model's reading.** The first architecture let a model-extracted SKU and quantity flow straight into a commit. The reviewer flagged it as a blocker. Fix: a commit is allowed only if every SKU and quantity also appears literally in the email (check L01), and the model can add lines but never remove a SKU line the rules found.
2. **Same-day orders counted twice for credit.** The plan added today's commits on top of a live ERP read. Fix: credit is computed from the ERP after the writes, inside the commit transaction.
3. **A database plan that would have died on day 17.** An always-polling worker would have used up Neon's free compute hours. Caught by the reviewer from the vendor's pricing page; the final deploy wakes only on requests.
4. **One keystroke wrote to the ERP** in the first design, and the credit button showed the order total (616.00) as the overage instead of 216.00. Fix: approval always shows the consequence block first, and the overage is computed as exposure minus limit.
5. **"Our usual" picked up the agent's own order.** For E036, the history lookup found the order the agent had auto-committed for Bluefin an hour earlier and found nothing in common with older orders. Caught by reading the E036 output; fixed by limiting history to orders before the business day.
6. **Sizes read as quantities.** The first free-text reader took "33 gal" as 33 cases and "a large outdoor event" as one. Caught by printing the reader's output for all 40 emails before wiring it in; fixed with a size lookahead and a rule that a phrase must name a product noun.
7. **A change order counted its own value twice** in the credit check. Found on a read-through of the commit code before the E004 test existed; fixed by computing credit after the writes.
8. **Substitutions and price disputes were routed to "ask the customer"** instead of review, so a person might never see them. Fixed by sending anything with a severe flag to review; lane agreement went from 35 to 40 of 40.
9. **The security policy blocked the console's own styles.** Found in the browser console during the screenshot check; styles are now allowed inline while scripts stay locked to the site.
