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
