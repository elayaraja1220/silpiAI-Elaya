# Deploying SILPI AI (the SaaS billing and AI side)

This is for putting `frontend-2` on a real server for real customers. It covers what the code does and does not do for you. Read "What this is not" before taking real money.

## 1. What you need

- **Node.js 22.5 or newer** (the database uses Node's built-in SQLite). Node 24 is what it was developed on.
- **One server, one running copy.** The database is a single SQLite file, and the request limits and the provider circuit breaker live in the server's memory. Two copies would each count alone and would fight over the file. Scale up the one server, not out.
- **A disk that survives restarts** for `storage/` (the database), and a **second place** for backups.
- **HTTPS in front of it.** A reverse proxy or host that terminates TLS (nginx, Caddy, a platform router). The proxy must pass `X-Forwarded-For` and `X-Forwarded-Proto`.
- A Chrome or Edge on the machine you run `npm run e2e` from (not needed on the server).

## 2. Build and run

```
cd frontend-2
npm ci
npm run build
NODE_ENV=production npm start        # listens on port 3000; use PORT=... to change
```

`NODE_ENV=production` matters: it switches on HSTS, turns the automatic renewal timer on, and makes the development "start without payment" shortcut impossible whatever the source says.

## 3. Settings (environment)

Put these in the server's environment (or `frontend-2/.env.local` on that machine). **Never** commit them and never put them in `NEXT_PUBLIC_*` names (a test fails if you do).

| Setting | Needed | What it does |
|---|---|---|
| `SILPI_ADMIN_TOKEN` | **Yes** | A random secret of 32+ characters. Opens the administrator pages, signs administrator sessions, and is the emergency way in. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SILPI_DB_PATH` | Recommended | Full path of the database file, on the persistent disk. Default: `frontend-2/storage/silpi.db`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | For real AI | Each switches that provider on. Without any, only the free demo model works. Optional `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL` point to a proxy. |
| `SILPI_AUTO_BILLING` | No | `1` forces the renewal/expiry timer on, `0` forces it off. Default: on in production, off elsewhere. |
| `SILPI_BILLING_INTERVAL_MINUTES` | No | How often it runs, 5 to 1440. Default 60. |
| `NEXT_PUBLIC_APP_NAME`, `SILPI_AGENT_DIR`, `SILPI_OUTPUT_DIR`, `SILPI_WORKSPACE_DIR` | As before | Belong to the agency and project-generation side. |

## 4. HTTPS and the proxy

Example for nginx (adjust names and certificates):

```
server {
  listen 443 ssl;
  server_name app.example.com;
  # ssl_certificate / ssl_certificate_key ...
  client_max_body_size 50m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;      # overwrite, do not append: clients must not be able to forge it
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;                              # AI answers can take a while
  }
}
```

`X-Forwarded-For` is used to key the request limits for open addresses (sign-in, webhooks). If the proxy lets a client choose it, that client can dodge those limits.

## 5. First run, in order

1. Start the server and open `/ai/admin`. Sign in with the token.
2. **Security & launch** tab: create a named **Admin** account for yourself and a **Viewer** account for anyone who only needs to look. From then on sign in with your account and keep the token for emergencies.
3. **Tax & currency** tab: fill in **who invoices come from** (legal name, address, tax number). Add **tax rules** only after checking with an accountant. Enter **exchange rates** for the currencies you sell in (used for reports only).
4. **AI** tab: set a provider key in the environment and restart, then **add a model** with the provider's exact model name and its prices copied from the provider's own price page, then switch it on. Make **one small real request** with each provider you rely on: the adapters have never been called against the real services.
5. **Customers & plans** and **Payments** tabs: check the plan prices and credit packs.
6. **Security & launch** tab again: work down the checklist until nothing says "fix before launch".
7. Run `npm run backup` once and confirm the copy opens.

## 6. Payments

No online payment provider is connected. Customers are told to pay and quote the invoice or order number; you **record the payment** in the Payments tab (by that number), and only then do their plan or credits start. When you add a Stripe or Razorpay adapter (see `src/server/payments/provider.ts`), its notices arrive at `POST https://your-site/api/webhooks/<provider-id>` and are accepted only with a valid signature.

## 7. Backups

The database is **one file** holding every wallet, invoice, payment and the audit log. Losing it loses all of them.

- `npm run backup` makes a consistent copy while the site is running (SQLite's `VACUUM INTO`), checks it, and puts it in `backups/` beside the database. Schedule it (cron / Task Scheduler), **then copy the result to another machine or storage**. A backup on the same disk does not survive the disk.
- The server also copies the database automatically before applying an upgrade that changes it (when it holds agency data).
- To restore: stop the server, replace the database file with the copy (delete any `-wal` and `-shm` files beside it), start the server. Anything recorded after the backup is lost, so keep a note of payments you recorded since.

## 8. Upgrading

Pull the new code, `npm ci`, `npm run build`, restart. Database changes are applied automatically at start, in order, once each, with a backup first. Take your own backup before an upgrade anyway.

## 9. Keeping an eye on it

- **Security & launch** tab: the checklist. Check it after every change of settings.
- **Finance** tab: the "books balance" banner and the health figures should be green. Duplicate payments to refund and failed notices show there.
- **Audit log** tab: who changed what.
- The server's log (stdout) shows provider and billing errors, prefixed `SILPI`.
- Renewals and credit expiry run hourly by themselves in production. You can also run them by hand: `POST /api/admin/billing/process` with the administrator token.

## 10. Tests you can run

- `npm test`: the unit and integration suite (about a thousand tests, a minute or two). No network, no keys.
- `npm run e2e`: opens a real browser against a throw-away copy of the server (its own port 3113, its own temporary database) and walks through a customer ordering credits, an administrator recording the payment, and a viewer being refused. About three minutes the first time.

## 11. What this is not

Be honest with yourself before taking real money:

- **Not reviewed by a lawyer or accountant.** Tax rules, invoice wording and layout, refund terms, and data-protection duties (privacy policy, where customer data is stored) are yours to settle. The invoice is titled plain "Invoice" because its layout has not been checked against any country's rules.
- **Not load tested.** One SQLite file and one process is fine for a small business and is not built for thousands of requests a second.
- **Request limits are in memory.** They stop scripts and mistakes, not a determined attack. Add limits at the proxy or CDN.
- **No Content-Security-Policy.** Other protective headers are sent. A CSP needs a nonce setup for Next.js and is future work.
- **Passwords:** customer and administrator passwords are stored as scrypt hashes. There is no password reset by email, no two-factor sign-in, and no lockout beyond the attempt limits.
- **Administrator accounts** have two roles. There is no finer permission model.
- **The audit log** cannot be changed through the application, but someone with the database file can change it.
- **Prompts and answers** are not stored by the AI gateway, but they are sent to the AI provider you choose, under that provider's terms. Customer-supplied text is passed to the models as written; nothing screens it for attempts to manipulate the model. The models are given no tools, and generated file names are checked, so such an attempt can only change the text a customer gets back.
- **Streaming** AI answers, **task-based routing rules**, and **automatic exchange rates** are not built.
