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

The data is the 07:00 ERP snapshot of 2 November 2026 and the 40 emails of that day. Admin can reset everything to that state from the account menu.
