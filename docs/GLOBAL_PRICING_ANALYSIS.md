# Global country-based pricing: repository analysis and plan

Written before any change, as the brief asked. No code was changed for this document.

## 1. What exists today

**Fixed price (`pricing.ts`, `proposals.ts`).** Hours come from the rate card (`hours` per project type, page, section, feature, design), multiplied by complexity and technology factors, times one hourly price. Three packages (Basic, Standard, Premium) are cut from one requirement. GST (`gstFor`): same state CGST+SGST, other state IGST, "Outside India" zero-rated. The price is deterministic on purpose: the same document must give the same estimate.

**Hourly (`hourly.ts`, `hourly-engagement-form.tsx`).** The team types a role, a rate, estimated hours and a range (%); the high end is the cap the client approves. `rate x hours` plus GST. Totals are held in rupees. Nothing derives the rate from a market.

**AI analysis (`analyze.ts`, `silpi-agent`).** The AI reads the client's documents and fills the *requirement form* (pages, modules, technology, budget). It does **not** estimate hours. Three readings are compared and only what most agree on is kept. Hours then come from the rate card, not from the AI.

**Currency.** Built last week: `money.ts` (amounts held in rupees, shown in the quotation's currency), `RateCard.countryPricing` (an hourly price per currency, typed by you), `live-rates.ts` (market exchange rate, cached six hours, labelled "approximate" when unreachable), `quoteMoney()`. Client has a `currency`. Quotations for clients abroad already work for **fixed price**; the **hourly** mode does not use the country price yet.

**Country detection.** `geo.ts` reads the host's country header, then time zone, then language, and only knows three currencies. It is used on the public pricing pages, not on quotations. A quotation's country is "State = Outside India" plus a currency; there is no country field.

**Approval and versions.** A client answers through the share link (`respondAsClient`): approve a package, or ask for changes. The quotation is locked once approved. Every re-quote makes a new numbered quotation (`SQ-2026-0001...`) and a version digest compares versions (`estimate-ledger.ts`). There is no separate approval record table and no per-line role.

**Database.** `leads`, `quotations` (JSON `data`), `stage_history`, `payments`, `work_log`, `settings` (rate card as JSON), plus the SaaS tables. The agency side uses the older additive schema, the SaaS side versioned migrations (now at 17). New tables should be migrations 18 onward.

**Admin.** The agency's pricing screen (`/pricing`) has no sign-in of its own (localhost-open by design). The SaaS admin (`/ai/admin`) has accounts, roles and an audit log.

**Tests.** 1,116, including 18 for country pricing and 9 for market rates.

## 2. The brief against what exists

| Brief item | State |
|---|---|
| Fixed and hourly modes, GST, INR conversion, budget, approval | Exist |
| Currency conversion with live, cached, fallback rates | Exists; **admin override** exists in a different form (a per-country manual figure) |
| Country-based hourly price | Partly: one manual price per currency, fixed mode only |
| Country detection by profile, billing country, IP, manual | Not built for quotations |
| Market rate database by country, role, level, min/median/max, source, dates | **Not built** |
| Roles and experience levels | Only a free-text role on hourly |
| Employee, freelancer and agency benchmarks and billing multipliers | Not built |
| AI hours by task and role | Not built (see decision 2) |
| Approval records and versions | Partly (client response, numbered quotations); no formal record |
| Pricing audit log, permissions | The SaaS audit log exists; the agency pricing screen has none |
| Financial separation A to E | Partly: team costs and profit exist in `cost-*`; AI cost lives in the SaaS gateway |

## 3. Things in the brief I need you to decide or that I will not do

1. **Market rates cannot be invented.** The brief says to use reliable sources and never invent rates. I cannot look up, verify or keep current salary and billing data for dozens of countries, roles and levels from here, and a table I wrote from memory would be exactly the invention you ruled out. **Proposal:** build the whole database, screens and engine with **no rates preloaded**, make **source, effective date and who entered it mandatory**, and refuse to price a country, role and level that has no verified row (it falls back to the manual country price, or to rupees). You or a researcher fill the table, from the BLS for the USA and national statistics for others, and every figure carries its source. I can add an **import from a spreadsheet (CSV)** so a researcher can load many rows at once.
2. **The only numbers in the brief are India's illustrative salaries** (Rs 6 lakh, 15 lakh, 30 lakh over 2,080 hours: about Rs 288, 721 and 1,442 an hour). I will load those as editable assumptions **labelled "illustrative, not a market rate"**, as the brief itself says, and never use them silently.
3. **AI hours versus a deterministic table.** The brief wants the AI to estimate hours per task and role. Today the same document always gives the same price because hours come from your rate card. An AI estimate would vary between runs and between readings. **Proposal:** keep the rate card as the canonical hours (stable, explainable, comparable with the hours actually logged); give each line a **role and level** so it is priced with the country's rate for that role; let the AI **suggest** a per-task hours split that the team reviews but that does not set the price on its own. If you want the AI's hours to drive the price, that is a different product with different promises, and I would add a "reviewed by a person" step.
4. **Employee wages are not billing rates.** I agree with the brief: three separate benchmark kinds (employee, freelancer, agency), one chosen per quotation mode in settings, with an admin multiplier, overhead and margin. For fixed price I will keep the existing hours-times-rate maths; for hourly the rate = chosen benchmark x multiplier.
5. **Tax.** Country tax for quotations will be admin-configured rules, as built for the SaaS invoices: nothing preloaded except the existing Indian GST; no tax is assumed for any other country; reverse charge and exemptions are not handled. Needs an accountant.
6. **Detection.** IP country is a guess (a VPN, a company network, a missing header). It will only pre-select the country; the person confirms it, and a billing country overrides it. Time zone and language are not used for a quotation.
7. **Prices change what people agree to.** Once a quotation is approved, its rate, hours, cap and tax are frozen in an approval record; any change creates a new version that needs approval again.

## 4. Proposed build, in order (each step ends with tests, `tsc` and a check of existing screens)

1. **Data model** (migration 18): `countries`, `currencies`, `developer_roles`, `experience_levels`, `country_market_rates` (country, role, level, benchmark kind, currency, min/median/max, source, effective date, entered by, enabled; history kept, never edited in place), `pricing_configurations` (which benchmark powers each mode; multipliers, overhead, margin, risk allowance), `pricing_audit_logs` (reuse `audit_logs` with a `pricing.` prefix instead of a second table). Reuse `exchange_rates` and `live-rates`. No rates seeded except India's labelled illustrative salaries.
2. **Rate engine** (pure, tested): rate for (country, role, level, benchmark) with min/median/max, billing multiplier, currency, decimal-safe (whole minor units, no floating point), refusal when no verified row.
3. **Country on the client:** a real `country` field, detection that pre-selects, manual override, flag, currency. Keep `state = Outside India` and the existing currency prices working.
4. **Hourly mode:** role, level and country choose the rate; show min/median/max, estimated hours range, quotation range, cap; approval of rate, hours, cap, scope, tax.
5. **Fixed mode:** each priced line gets a role and level; price = hours x that role's country rate, plus the risk allowance and margin, shown as a transparent breakdown. Existing rupee quotations stay exactly as they are until a country is chosen.
6. **Approval records and versions:** `quotation_approvals` (who, when, what was agreed: rate, hours, cap, tax, scope, version), immutability after approval, revised quotation on any scope change.
7. **Admin screens:** countries, roles, levels, rates with history and sources, benchmarks per mode, multipliers and margins, tax rules, exchange rates, enable/disable per benchmark; permissions and audit.
8. **AI hours suggestion** (if decision 3 allows), kept apart from the price.
9. **Financial separation:** a report that keeps A (human-equivalent value), B (customer price), C (AI cost), D (infrastructure cost), E (margin) in separate columns and never derives one from another. C and D start as figures you enter; C can later read the SaaS gateway's real provider cost.
10. **Tests and a production build** at every step; documentation.

## 5. Risks

- The agency quotation code is mature and many screens write amounts. The currency work last week touched about thirty files; this work touches pricing rules rather than formatting, so it is riskier. Rupee quotations will be compared before and after on a set of fixed examples.
- A wrong or stale rate table silently misprices clients. Hence mandatory sources and dates, a visible "rate as of" on every quotation, a warning when a row is older than a limit you set, and no pricing without a verified row.
- Pricing screens on the agency side are open on localhost. Rate and multiplier changes belong behind the administrator accounts that now exist.

## Built so far (steps 1–4)

- Data model (migration 18): countries, currencies, developer roles, experience levels, append-only `country_market_rates` (source and start date mandatory), `pricing_configurations`.
- Rate engine (`market-rates.ts`): exact whole-number arithmetic, newest-started row, any-role fallback only, stale/illustrative/bills-at-cost flags; no rate means "type one by hand", never a guess.
- Country (`countries.ts`): chosen country beats profile, billing and IP guess; the guess only pre-fills.
- Hourly mode: country, role and level choose the market rate on the server; override is recorded; quotation shows the market note.
- Admin: "Global pricing" tab (settings, rates with sources, add form, CSV import, lists) and the fixed-price wizard's client country.
- Checked: type-check, 1156 tests, mutation checks on the engine, the append-only trigger and the server enrichment (all caught), production build.
- Not yet checked in a real browser: sign-in is not configured (`SILPI_ADMIN_TOKEN` missing in `.env.local`), so `/api/business/*` and `/api/admin/*` answer 503 locally.

## Step 5: fixed price from the market rate

- A fixed quotation may name a role, level and country (`Requirement.fixedBasis`). The server (`enrichFixed`) looks up the verified rate with the administrator's fixed-price benchmark (agency by default) and writes the figure and the risk allowance into the requirement; the browser's figures are ignored.
- `buildQuote` then prices every hour at billed median × (1 + risk allowance) in the quotation's currency. No verified rate, no role/level, or a rate in another currency: the rate card price is used (a currency mismatch at save time is refused with the way to fix it). Rupee quotations without a basis are unchanged.
- The quotation shows one sentence naming the benchmark, source, date and risk allowance (`fixedBasisNote`); a saved quotation never moves when a newer rate is added.
- Wizard: "Hourly price based on" (Rate card / Market rate) with role and level, and a preview of the rate.

## Step 6: approval records and quotation versions

- Migration 19: `quotation_versions` (every quotation issued is version 1, 2, 3..., with the reason and a SHA-256 fingerprint of the stored JSON) and `quotation_approvals` (who approved, by which channel, when, the frozen terms and the fingerprint). Both are append-only (triggers). Old quotations are backfilled; an approval that happened before records existed is recorded as "unknown (approved before approval records)", never with an invented approver.
- The terms frozen: mode, currency and exchange rate, price, discount, tax mode/rate/amount, hours, the hourly price, the hourly range and spending cap, the scope (pages, modules, left out), the market source and date, the validity.
- Immutability: the database refuses to update or delete a quotation that has an approval. The team cannot re-price an approved quotation (it was already locked); reopening and re-pricing makes a NEW version, shown as "not approved yet" with the agreed terms it changes (`termChanges`), and approving it adds a second record while the first stays.
- `verifyApproval` recomputes the fingerprint, so tampering that bypassed the database would show as "not intact".
- A project with an approved quotation can no longer be deleted (mark it lost instead).
- Screen: "Versions and approvals" card on the project summary; read-only API `GET /api/business/leads/:id/approvals`.

## Step 7: administrator screens, permissions and history

- Already in place from earlier steps: countries, roles and levels (switch on/off, add a role), market rates with sources and history, benchmark per mode, multipliers, overhead, margin, risk allowance, staleness limit, CSV import, tax rules and exchange rates (in the "Tax & currency" tab), administrator accounts with admin and viewer roles.
- New: every change to settings, a rate switch or a list switch must say why (5+ characters, enforced by the route, kept in the audit log with the person). Adding a rate or role needs no reason: the mandatory source is the justification.
- New: "Who changed what" on the Global pricing tab (`GET /api/admin/pricing/history`): pricing events from the audit log, newest first, with who, when and why.
- New: rates download as CSV (`GET /api/admin/pricing/rates/export`, optionally for one country) in the layout the import reads; a cell that starts like a spreadsheet formula is prefixed so it opens as text.
- Permissions: a viewer can look, read the history and download the CSV; every change is refused (403) on the server, and the screen greys the forms and says so.
- Not built on purpose: adding a country that is not in the fixed list of 38 (quotation parsing validates against that list), editing an existing rate (history is kept), a second audit table (the existing append-only one is used with a `pricing.` prefix).
