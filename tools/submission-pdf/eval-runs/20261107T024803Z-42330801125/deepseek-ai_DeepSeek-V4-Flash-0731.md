## Model eval: deepseek-ai/DeepSeek-V4-Flash-0731

| Measure | Value |
|---|---|
| Routing matches labels | 40/40 |
| Intent matches labels | 33/40 |
| Written alone that should have waited | 0 |
| Clean orders not written | 0 |
| Model finished its reading | 40/40 (fell back 0) |
| Model and rules read the same lines | 30/37 |
| Model calls, tokens in / out | 173, 468781 / 47800 |
| Cost | 0.0367 USD |
| Wall time | 137 s |

### Lane differences

| Email | Got | Labelled | Flags | Failed checks | Model said |
|---|---|---|---|---|---|

### Intent differences

- E014: new_customer_inquiry (labelled prospect_inquiry)
- E017: cancellation (labelled order_cancellation)
- E026: new_order (labelled order_addition)
- E027: complaint (labelled new_order)
- E034: new_order (labelled order_addition)
- E035: new_order (labelled order_addition)
- E037: new_order (labelled order_addition)