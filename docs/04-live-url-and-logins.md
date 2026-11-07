# Live URL and logins

| Item | Value |
|---|---|
| Console | https://harbor-point-order-desk.vercel.app |
| Health check | https://harbor-point-order-desk.vercel.app/api/health |
| Operations | username `ops` |
| Credit and AR | username `credit` |
| Admin | username `admin` |
| Password (all three) | sent with the submission |

| Item | Value |
|---|---|
| Hosting | Vercel, project `harbor-point-order-desk`, region Washington D.C. (iad1) |
| Database | Neon Postgres (Free), connected through the Vercel integration as `DATABASE_URL` |
| Deploys | Every push to `main` in `nabilafifahq/test-harbor` deploys to production; other branches deploy previews |
| Model | DeepSeek V4 Flash on DeepInfra when `LLM_API_KEY` is set in Vercel. Without it, the 40 inbox emails replay the recorded model run of 7 November (eval-model run 42330802762), labelled in the console, and new mail uses the rules reader |
| New mail | **New email** in the sidebar (type it or upload a `.eml`); the agent reads it in the background |

The data is the 07:00 ERP snapshot of 2 November 2026 and the 40 emails of that day. Admin can reset everything to that state from the account menu.
