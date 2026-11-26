# Client authentication, fixed price and SaaS flow: repository analysis

Written before any change, as the brief asked. Nothing below has been built yet.

## 1. What exists today

**Database.** SQLite (`node:sqlite`) with versioned one-way migrations (now at 20). The brief says MySQL; there is no MySQL anywhere in the project.

**Accounts that exist.**
- Organization members: `users` (scrypt password hash, 10+ characters), `memberships` (owner, admin, member, viewer), `organizations` (types include `individual`), server-side revocable `sessions` (cookie `silpi_session`, only the SHA-256 of the token is stored). `/api/auth/login`, `/logout`, `/me`. Rate limited, same-site checked, one message for every failure. **There is no sign-up, no password reset, no e-mail verification and no OAuth.**
- Administrators: either the `SILPI_ADMIN_TOKEN` or named accounts (admin or viewer) with the `silpi_admin` cookie; `requireAdmin`, audit log, write limits.

**E-mail.** Nothing can send e-mail (no SMTP, no provider). "Forgot password" and "verify your e-mail" need one.

**Pages.** `/` (Overview), `/clients`, `/clients/new`, `/clients/[id]`, `/projects`, `/existing`, `/activity`, `/pricing`, `/plans`, `/settings` share one dark shell (`AppShell`). These are the studio owner's screens: no page in that shell asks anyone to sign in. `/ai` (light theme, `AiShell`) holds the SaaS: chat, project builder, usage, billing, `/ai/sign-in`, `/ai/admin`. `/q/[token]` is the client's quotation page (secret link, no account).

**How APIs are protected.** `/api/business/*` and `/api/projects*` go through `middleware.ts`: open on a dev server opened as localhost, otherwise admin sign-in. `/api/workspace/*` needs a user session and takes the organization from the session. `/api/admin/*` needs the administrator.

**`/clients/new` today** is the full team wizard for a fixed-price quotation (it also shows internal costs and profitability to whoever uses it). The hourly option is inside it.

**Recurring income.** `RecurringIncomeCard` sits on the Overview page; its API (`/api/business/recurring-income`) is protected only by the middleware rule above, so on a dev server anyone on localhost sees it.

**Admin link.** `ai-shell.tsx` has an "Admin" item in the header and `landing.tsx` links "Administrator". The studio sidebar has no admin link but shows every internal screen (pricing, agent activity, recurring income).

## 2. Gaps against the brief

| Brief | Today |
|---|---|
| Get Your Quotation requires client login | No client login exists; the button opens the team wizard |
| Google, Facebook, e-mail sign-up and login, forgot password, terms | Only e-mail login for existing members |
| `/clients/new` chooser (Fixed Price or SaaS) | `/clients/new` is the wizard |
| Admin and client interfaces separated | One shell, open; the studio is the admin interface in all but name |
| Recurring income admin only | Visible on the Overview |
| Remove Admin link from the public header | In the `/ai` header and the landing page |
| Server-side RBAC, no cross-client access | Organization isolation exists for `/api/workspace/*`; the studio screens and `/api/business/*` are not role-checked on localhost |
| Client dashboard, projects, billing, profile, notifications | `/ai/billing` and `/ai/usage` exist; no client project list, profile or notifications |

## 3. The large decision inside the brief

Today the people who create quotations are the studio's team, and a "client" is a record on a lead. The brief turns clients into people who sign themselves up and ask for a quotation themselves. That means a **client-facing fixed-price flow**: the existing quotation engine, but the lead belongs to the client's own organization, the internal cost, profit and margin panels are hidden, and the client can only ever see their own projects. The existing team wizard must keep working for the studio.

## 4. Proposed plan

1. **Separation and protection:** a platform role (administrator versus client) checked on the server; the studio screens and `/api/business/*` require an administrator (an administrator sign-in page for the studio); recurring income moved behind an administrator-only tab and its API always requires the administrator; the Admin links removed from public headers.
2. **Client accounts:** sign-up and login with e-mail (reusing `users`, scrypt, sessions), automatic personal organization, validation, duplicate prevention, terms and privacy acceptance recorded, forgot password.
3. **Google and Facebook:** the OAuth code flow with a state value and PKCE, accounts matched by verified e-mail, no password stored for social sign-ups.
4. **`/clients/new` chooser** with the two cards; the existing wizard moves to a new URL for fixed price; "Get Your Quotation" and the CTAs send visitors through authentication; SaaS leads to `/ai` (subscription onboarding if needed).
5. **Client-facing fixed-price flow:** the lead is owned by the client's organization, internal costs hidden, quotation, approval and advance payment reuse the existing engine.
6. **Client dashboard and navigation:** Dashboard, My Projects, AI Workspace, Billing, Profile; a separate admin navigation; the admin dashboard files renamed to meaningful names without changing routes.
7. **Tests, lint, build, documentation, manual OAuth setup notes.**

## 5. Things that cannot be finished by me alone

- Google and Facebook sign-in need an OAuth app created by you in the Google Cloud console and the Facebook developer site (client id, secret, redirect addresses). I can write and test everything against a simulated provider, but not a real round trip.
- Forgot password and verification need an e-mail sender (SMTP or a provider key).
- Terms of Service and Privacy Policy text must be written or approved by you; I will add the pages and the acceptance record, not the legal wording.
- The sign-in security of a public site (HTTPS, a real domain, secure cookies) is the deployment's job.

## 6. Risks

- The studio screens are currently open on localhost; making them require an administrator changes how you use the app every day. The plan keeps a local-development convenience only if you choose it.
- Moving the wizard from `/clients/new` to another URL changes bookmarks and any link inside the app that points at it; every such link will be updated and tested.
- Client-facing fixed price must never leak internal costs, margins, market rates entered by the studio, the hour split, or the five figures. A test will scan the client responses for them.

## Decisions (answered)

Keep SQLite. E-mail through SMTP settings (the reset link is printed in the server console until SMTP is set). The studio needs an administrator sign-in always, even on localhost. Build steps 1 and 2 first.

## Step 1 built: separation and protection

- `middleware.ts` is the one guard. Every `/api/business/*` and `/api/projects*` request needs an administrator (cookie or token header) with no exception: the old rule that opened these APIs for localhost (`api-access.ts` and its test) was removed, because a header such as `X-Forwarded-For: 127.0.0.1` could spoof it. Every studio page (`/`, `/clients`, `/clients/*`, `/projects`, `/existing`, `/activity`, `/pricing`, `/plans`, `/settings`, `/recurring-income`) redirects to `/admin/sign-in?next=...` unless an administrator is signed in. The matcher is a plain literal on purpose (a computed one makes Next.js fall back to the edge runtime and the build fails); a test lists every page under `src/app/(app)` and fails if one is not covered.
- Not matched, by design: `/q/[token]` and `/api/client/[token]` (a client's own link), `/ai/*` and `/api/workspace/*` (customer accounts), `/api/auth/*`, `/api/admin/*`, the sign-in pages.
- `/admin/sign-in` (not linked anywhere public, not indexed) reuses the administrator sign-in form (account or token) and returns only to a path on this site (`safeNext`).
- Recurring income is no longer on the Overview: it has its own studio page `/recurring-income` (sidebar, Monitor) and its API checks the administrator again.
- The "Admin" tab in the customer header, the "Administrator" link on the public landing page and the "Workspace" link that sent customers to the studio are gone. Administrators reach the console from the studio sidebar ("SaaS administration") and the studio from the console ("Open the studio").
- Checked against a real production server: studio pages 307 to the sign-in page, business APIs 401 (also with spoofed local headers), 200 with the token, and `/q/...`, `/ai`, `/admin/sign-in` stay public.

## Step 2 built: client accounts with e-mail

- **Migration 21:** `users.terms_version` and `users.terms_accepted_at` (empty for accounts that existed before; they are not pretended to have accepted anything), and `password_resets` (only a SHA-256 of the link token is kept; one use; expires after 60 minutes).
- **Doors (all public by design, same-site only, rate limited per address and per e-mail):**
  - `POST /api/auth/signup` `{ name, email, password, acceptTerms: true }`: creates the user, a personal organization (`individual`) they own, records the terms version, and signs them in. Refuses a duplicate e-mail in any letter case.
  - `POST /api/auth/forgot` `{ email }`: always the same answer; a link is sent only to an active account; sending is not waited for, so the answer does not take longer for a real account; a newer request cancels the older link.
  - `POST /api/auth/reset` `{ token, password }`: one use; ends every session of the account; does not sign anyone in; two people using one link at once cannot both succeed.
  - Sign-in is the existing `POST /api/auth/login` (unchanged).
- **Rules (`lib/client-auth.ts`):** valid e-mail (no consecutive dots, size limits), name 2 to 80, password 10 to 200 characters, not one repeated character, not obvious, not containing the e-mail. Passwords are stored only as salted scrypt hashes (the existing `hashPassword`).
- **E-mail (`server/mailer.ts`, nodemailer):** SMTP settings from the environment (below). Until set, the message is printed in the server console and clearly marked as NOT sent.
- **Reset link address:** `SILPI_PUBLIC_URL` when set; otherwise the request's own address on a development server only. On a production server without `SILPI_PUBLIC_URL` no link is sent, because a visitor can write a Host header and must not decide where a reset link points.
- **Screens:** `/sign-in` (sign in, create account, forgot password, Terms and Privacy acceptance; Google and Facebook buttons are visible but switched off until step 3), `/reset-password`, `/terms` and `/privacy` (placeholders that say the text is still to be written; the version is recorded with each acceptance), `/login` now redirects to `/sign-in`. After signing in a client goes to the `next` destination (only a path on this site) or `CLIENT_HOME` (`/ai` for now; step 4 changes it to `/clients/new`).
- **Isolation:** a client's session opens no administrator door (business APIs 401, studio pages redirect, administrator session unauthenticated); two clients see only their own workspace.
- Checked on a real production server: sign-up, `/me`, duplicate, missing terms, cross-site refusal, identical forgot answers, mail printed with the public address, reset, old session ended, link reuse refused, old password refused, new password accepted.

### Environment variables for e-mail

`SILPI_SMTP_HOST`, `SILPI_SMTP_PORT` (587 by default; 465 connects encrypted from the start), `SILPI_SMTP_USER`, `SILPI_SMTP_PASSWORD`, `SILPI_SMTP_FROM` (for example `SILPI AI <no-reply@yourdomain.com>`), and `SILPI_PUBLIC_URL` (for example `https://app.yourdomain.com`). Put them in `frontend-2/.env.local`, never in `.env.example`.

### Known limits after step 2

- ESLint is not installed in this project (`next lint` has nothing to run); it was not run. Say so before relying on a "lint passed" claim anywhere.
- `npm audit` reports two vulnerabilities in `next`'s own copy of postcss that need a breaking Next.js upgrade; they existed before this work.
- E-mail verification (proving the address is the person's) is not built; social sign-in in step 3 brings addresses the provider has verified.
- Terms of Service and Privacy Policy text must be written by the studio.

## Step 3 built: Google and Facebook sign-in

**Flow.** `GET /api/auth/oauth/google|facebook/start?next=/path` sends the person to the provider. A random one-time state (32 bytes, only its SHA-256 stored, valid 10 minutes) is kept in the database and also in a short-lived `HttpOnly`, `SameSite=Lax` cookie of that browser (Lax, because the provider returns the person from another site). Google also gets PKCE (S256). `GET .../callback` checks the state against both, spends it at once (a replay fails), exchanges the code on the server with the secret, reads the profile once, and discards the token: no provider token is stored. The destination after sign-in comes from the stored record, not from the address, and is always a path on this site. Any failure lands on `/sign-in?error=<code>` with a short code; the screen shows only its own wording for known codes.

**Account policy (an e-mail address alone is never enough to enter an account).**
1. A known identity (the provider's own stable id) signs in its account.
2. A new identity whose address no account uses creates an account with no usable password (`oauth$none`), a personal workspace, and the terms version recorded. Google must vouch for the address (`email_verified` must be exactly `true`); Facebook cannot, so its identity is marked not vouched for and is removed if the address's owner later proves control by resetting the password.
3. A new identity whose address already belongs to an account is refused. It can only be connected by someone already signed in to that account (`start?link=1`, which needs a session; the identity is then attached to that account and nothing else changes). An identity already connected to another account cannot be taken over.
4. A disabled account cannot be entered, and two sign-ins at the same moment for one new person make one account.

**Tables (migration 22).** `auth_identities` (provider, the provider's id, address, vouched-for flag), `oauth_states`.

**What is shown.** `/api/auth/providers` answers only yes or no per method (and no on a production server with no `SILPI_PUBLIC_URL`). The sign-in screen links to the start door when a method works and shows it switched off when it does not.

**Checked on a real production server** (with dummy ids, no provider contacted): providers answer, Google redirect has the exact return address and PKCE and no secret in the address, the state cookie is HttpOnly and Lax, a forged callback lands on `/sign-in?error=state`, an unknown method is 404. The round trips against a stand-in for both providers are in `tests/social-sign-in.test.ts` (27 tests). A real Google or Facebook round trip has NOT been done: it needs your credentials.

### Setting up Google and Facebook (you must do this)

Add the addresses below to your own site address `SILPI_PUBLIC_URL` (for local tests, `http://localhost:3000`).

**Google** (console.cloud.google.com): create a project, open "APIs & Services", then "OAuth consent screen" (choose External, fill in the app name and your support e-mail, add the scopes `openid`, `email`, `profile`; while the app is in "Testing", add your own e-mail as a test user), then "Credentials", "Create credentials", "OAuth client ID", type "Web application". Under "Authorised redirect URIs" add exactly `http://localhost:3000/api/auth/oauth/google/callback` (and, for your real site, `https://your-domain/api/auth/oauth/google/callback`). Copy the client id and secret into `.env.local` as `SILPI_GOOGLE_CLIENT_ID` and `SILPI_GOOGLE_CLIENT_SECRET`. Publishing the app (leaving "Testing") may need Google's verification for a real audience.

**Facebook** (developers.facebook.com): "Create app", use case "Authenticate and request data from users with Facebook Login", add the "Facebook Login" product, "Settings". Under "Valid OAuth Redirect URIs" add exactly `http://localhost:3000/api/auth/oauth/facebook/callback` (and the real one). In "App settings, Basic" copy the App ID and App Secret into `.env.local` as `SILPI_FACEBOOK_APP_ID` and `SILPI_FACEBOOK_APP_SECRET`. While the app is in Development mode only you and the roles you add can sign in; going Live needs a privacy policy URL (your `/privacy` page, once its text is written) and may need Meta's review. The "email" permission works by default for Login but a person may refuse to share it, which the screen explains.

Restart the server after changing `.env.local`.

## Step 4 built: the client's way in and the two development models

- **Flow:** the public front page now has "Get your quotation" (header and footer) and its Sign in / Get started use the one client sign-in page. `/clients/new` needs a client sign-in (otherwise `/sign-in?next=%2Fclients%2Fnew`, and back afterwards); after any sign-in the default destination is `/clients/new` (`CLIENT_HOME`).
- **`/clients/new`:** the choice page, in its own client frame (`(client)` layout, `ClientShell`: New project, AI workspace, Billing, name, Sign out; no link to the studio or any administrator area, which a test checks). Two cards, as in the brief: Fixed Price Project ("Choose Fixed Price") and SILPI AI SaaS ("Start with SILPI AI"), with the full feature lists, side by side on wide screens and stacked on narrow ones.
- **The studio's own quotation form moved** from `/clients/new` to `/clients/quote` (the `(app)` page was moved, not rewritten; the studio sidebar, Overview and Clients links were updated). It is still behind the administrator guard. The middleware leaves only `/clients/new` and below to the client pages; `/clients/newer`, `/clients/quote`, `/clients/[id]` stay administrator-only.
- **SaaS:** `/clients/new/saas` records the choice and goes straight to the AI workspace (`/ai/builder`) when the organization has a running plan (the free plan counts); with none it goes to the plans (`/ai/billing?then=%2Fai%2Fbuilder`), and choosing a plan that is active at once (the free plan) carries on to the workspace. A paid plan starts when its payment is confirmed, as before. SaaS billing is untouched and stays separate from fixed price.
- **Fixed price:** `/clients/new/fixed-price` records the choice. **The client's requirement form is NOT connected yet** (see step 5): the page says so plainly ("not open for your account yet") and shows the journey. The studio's wizard cannot simply be opened to clients: it calls administrator-only APIs and shows internal costs and margins.
- **Migration 23:** `model_selections` (who, which workspace, `fixed_price` or `saas`, when; append-only).
- **Checked on a real production server:** signed-out `/clients/new` and the old `/login` redirect to sign-in with the destination kept; a new client sees the chooser with the exact heading and both buttons and no administrator words; SaaS goes to plans, then (after choosing Free) straight to `/ai/builder`; fixed price shows its page; the same client is sent to the administrator sign-in from `/clients`, `/clients/quote`, `/recurring-income` and `/`, and gets 401 from `/api/business/*`; an administrator opens `/clients/quote` and `/recurring-income` and is not given the client chooser.

## Step 5 built: the client's own fixed-price request

- **The form is the studio's own `RequirementWizard`**, not a copy. A `mode="client"` prop makes it talk to the client's doors, prefills the client's name and email, and leaves out what is the studio's business: the cost / profit / running-cost panel, the market-rate basis picker, the technology recommendations (the client chooses technology on their quotation page, as before) and the AI's cost and model. The studio's form (`mode="studio"`, the default) is unchanged; a test checks that the studio page passes nothing new.
- **Doors, all under `/api/workspace/fixed-price/` and all needing a client sign-in:** `rate-card` (the prices the form shows an estimate from, without the studio's UPI and bank details, contact details or discount limit: `lib/business/client-rate-card.ts`), `exchange-rates`, `analyze` (the same document reading, a few an hour per workspace because it uses the studio's AI, no forced re-read, and no model or cost in the answer: the shared handler is `lib/business/analyze-request.ts`, which `/api/business/analyze` also uses), and `leads` (`POST { client, requirement, tier }`).
- **What the client can and cannot decide.** The requirement, their details and their preferred package are theirs. Every price is worked out again on the server by the studio's engine from the real rate card, so a price, discount, market basis or hourly engagement in the request is ignored or refused; the workspace comes from the session, never from the request; at most 25 requests may be open at once and 12 may be made an hour. The answer is only `{ leadId, token, quotationNumber }`.
- **Ownership.** `createLead` takes an optional organization; a client's request belongs to the client's own workspace (`leads.org_id`). The studio still sees it in Clients & quotes, and the client sees only their own in `/api/workspace/leads`.
- **After the quotation** the client goes to `/q/<their link>`: the existing page where they compare the three packages, choose technology, approve or ask for changes and, once approved, see how to pay the advance. Approval, payments, tracking, demo and delivery are the existing workflow, unchanged.
- **A leak found and fixed while checking this on a real server:** the quotation link's answer carried the studio's UPI and bank details inside `quotation.business` before approval (the page did not show them, but the data was there). They are now removed until the quotation is approved, when the "how to pay" block shows them as designed. Quotation documents (PDF/Word) are unchanged.
- **Checked on a real production server:** the client form page opens; the client's rate card has no payment details and a discount limit of 0 while the studio's keeps both; the studio's rate card is 401 for a client; a request is created and answers only three fields; her quotation opens through her link with all three packages and no internal words; approving it shows her how to pay; the studio sees the request; another client's list is empty; a guessed link is 404.
- **Not covered by a real browser:** the wizard screens in client mode were not driven in a browser (no browser automation here); the server side and the source of the client branch are tested.
