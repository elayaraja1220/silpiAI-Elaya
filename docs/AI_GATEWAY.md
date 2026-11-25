# AI Gateway: analysis and design

The gateway is the single door between customer work and an AI provider. It turns provider cost into credits, so a customer can never spend more than they own and SILPI never pays for AI nobody paid for.

> **Source of the competitor notes.** They come from the products' public pricing and docs as I remember them, not from a fresh check. These companies change plans often. Re-check each point on its own pricing page before using it in a sales or pricing decision.

## 1. What the competitors charge for, and what we took

| Product | How usage is metered (as I understand it) | Good idea we kept | Weakness we avoided |
|---|---|---|---|
| **Lovable** | Message credits. A request costs more or less depending on its size; daily and monthly allowances. | One simple unit (credits) the customer understands. | Cost per message is hard to predict beforehand. We show the **most a request can hold before it is sent**. |
| **Bolt** | Token allowance. Tokens are used by chat and by the project files sent as context. | Real token metering is the honest basis for cost. | Raw tokens mean nothing to most customers. We meter tokens but **charge credits**. |
| **v0 (Vercel)** | Credits, with model tiers (a smaller and a larger model). | Named tiers instead of raw model names. | A single provider. We route by tier and **fall back inside the tier**. |
| **Replit Agent** | Effort-based charge per task, with spending limits and alerts. | A hard spending limit so a runaway agent cannot drain an account. | A charge decided after the work, so it can surprise. We **hold first and settle the real cost**. |
| **Devin** | Compute units for agent time, with a per-session limit. | A ceiling per job. | Time is a poor proxy for AI cost. We charge tokens. |
| **Cursor** | Included usage priced at provider cost, with an Auto mode that picks a model, then pay-as-you-go. | **Auto routing** and cost-based pricing. | Auto can pick an expensive model. Ours never picks the dearest tier on its own. |

### What the best combination looks like (and is built)
1. **Meter real tokens, charge simple credits** (Bolt's honesty with Lovable's simplicity).
2. **Hold before, settle after.** The worst case is held, only the real cost is charged, the rest returns (stronger than Replit or Lovable, which charge after the fact).
3. **Show the cost twice:** "holds up to X" before sending, "charged Y" on every answer.
4. **Tiers and Auto**, Auto never choosing the most expensive tier (v0 and Cursor, with a safety rule).
5. **Spending limits:** a daily cap per organization, a limit of 4 requests at once, and an answer-length ceiling per model (Replit and Devin).
6. **Failure costs nothing:** retried, then moved to another model of the same tier, then released.
7. **Provider-neutral:** a new provider is one adapter and one database row.

## 2. The flow of one request

```
validate -> choose models -> price the worst case
   -> one locked step: repeat? daily cap? too many running? then write the request row
   -> RESERVE credits (refused here if the wallet cannot cover it: the provider is never called)
   -> call the provider: retry a temporary failure, then try the next model of the same tier
   -> measure the REAL tokens -> compute the real cost
   -> SETTLE the real cost, return the rest of the hold
   -> write the usage row (sizes and money only)
failure at any step after the reserve -> RELEASE the hold, charge nothing
```

Everything uses the credit engine from the previous phase (`reserve`, `extend`, `settle`, `release`), so the append-only ledger, idempotency and the race protection come for free and are not re-implemented.

## 3. The maths (all whole numbers)

```
provider cost (micro-USD)  = ceil((input tokens x input price + output tokens x output price) / 1,000,000)
credit units charged       = ceil(provider cost x model markup x units-per-USD / (10,000 x 1,000,000))
1 credit = 1,000 units
```

- Prices are micro-USD per million tokens, stored per model in `ai_models`. Markup is basis points on the model. **Units per USD** is one setting (`ai_units_per_usd`, default 45,000 = 45 credits per dollar of provider cost).
- Rounding is always **up**, so a tiny request still costs at least one unit.
- The worst case uses a **pessimistic token estimate** (1 token per 3 characters; English is nearer 1 per 4). The difference returns at settlement.
- If the real prompt was larger than estimated, the gateway tries to hold the difference; if the wallet cannot, it charges only what was held and records the shortfall as `uncollected_units`. It never charges a wallet below zero.

### The numbers are proposals, not facts
The starting prices copy the agent's table in `silpi-agent/src/pricing.ts`. The conversion default (45 credits per USD) assumes about Rs 85 per USD and about 2x cover over a Pro credit (Rs 1,499 / 400 credits = Rs 3.75). **No customer has paid these figures.** Change them in the admin screen after checking the provider's price page and your own margins. The admin view shows, per organization, what you paid the providers against what customers were charged.

## 4. Safeguards

| Risk | Safeguard |
|---|---|
| Free AI after credits run out | Reserve is mandatory and checked before the provider is called. |
| Double charge on a retry or double click | Idempotency key per request; same key returns the first result, no second charge, no second provider call. |
| A failed or crashed request holding credits | Failure releases the hold; a sweeper releases holds of requests stuck longer than 10 minutes. |
| One organization draining another | The organization always comes from the session, never from the request body. Every query filters by it. |
| Runaway use | Daily cap per organization (checked in the same locked step that writes the request), 4 concurrent requests, answer-length ceiling, 4-minute total deadline. |
| Real model priced at zero by mistake | A non-demo model cannot be enabled with a zero price. |
| Provider key missing | The model is skipped before any credits are held. |
| Customer content leaking | Prompts and answers are **not stored**; only sizes, tokens and money. |
| Customers learning your margin | The customer API shows credit prices only, never the provider, its price or the markup. |

## 5. Using it

| Who | Endpoint |
|---|---|
| Member (`ai:use`: owner, admin, member) | `POST /api/workspace/ai/chat` with header `Idempotency-Key` |
| Member | `POST /api/workspace/ai/estimate`, `GET /api/workspace/ai/models` |
| Any member | `GET /api/workspace/ai/usage` |
| Administrator | `GET /api/admin/ai`, `PUT /api/admin/ai/models`, `PUT /api/admin/ai/settings`, `PUT /api/admin/ai/limits` |

Screens (light theme, a separate section that does not change any existing screen): `/ai` (playground), `/ai/usage`, `/ai/admin`.

**To get real answers:** set `ANTHROPIC_API_KEY` in the server environment. Without it only the free **Demo** model answers, and the real models say "provider not connected" without charging.

## 6. Not built yet (honest list)

- **Streaming** answers (they arrive all at once today). Streaming needs the settle step to run when the stream ends or is cut.
- **Prompt caching** discounts (the provider's cache-read prices are not modelled, so cached requests are priced as if uncached: the customer is slightly over-charged, never under).
- **Per-user caps** inside an organization (the cap is per organization).
- **Other providers** (OpenAI, Gemini): add an adapter in `src/server/ai/providers.ts` and rows in `ai_models`.
- **Agent orchestration** on top of the gateway (the next phase), and a **scheduler** for `/api/admin/billing/process`.
- The Anthropic adapter has been exercised only against a fake in tests. It has **not been called against the real API**.
