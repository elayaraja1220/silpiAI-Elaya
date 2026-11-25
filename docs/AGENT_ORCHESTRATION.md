# Agent orchestration (the project builder)

Turns one written brief into a plan and a set of generated files, step by step. Every AI call goes through the [AI Gateway](AI_GATEWAY.md), so every step is held, metered and settled by the credit engine. Screens: `/ai/builder` (start, list) and `/ai/builder/:id` (one build), in the same light section as the gateway.

## The flow

```
brief -> PLAN (one AI call, charged)  -> customer sees the file list and "up to X credits"
      -> customer APPROVES a budget   -> one FILE step per planned file -> optional REVIEW -> done
```

- **Nothing beyond the plan is spent before approval.** The plan is the only step that runs first.
- **The budget is a ceiling the build will not pass.** Before each step the orchestrator asks the gateway for that step's worst-case hold. If `spent + hold` would pass the budget it stops ("needs approval") and spends nothing more; the customer raises the budget and it continues.
- **Each step is still held and settled on its own**, so the wallet can never go below zero. The budget is a cap the orchestrator enforces, not a separate reserved pot: if the customer spends credits elsewhere meanwhile, the build pauses ("not enough credits") instead of failing, and resumes after credits are added.

## Which model does which step (the margin lever)

| Quality | Plan | Simple file | Main-logic file | Review |
|---|---|---|---|---|
| Economy | balanced | fast | fast | fast |
| Standard | balanced | fast | balanced | balanced |
| High | balanced | balanced | balanced | best |
| Demo | free built-in demo model for everything (no AI, sample output) | | | |

## States

`planning` -> `awaiting_approval` -> `running` -> `completed`, with `paused` (reason: needs approval, not enough credits, daily limit, provider not connected, interrupted, error), `failed` and `cancelled` as other ends.

- **Resume** continues a paused build where it stopped. Finished steps are never run or paid for again.
- **Interrupted:** the build's state is in the database. If the server restarts mid-build it is shown as interrupted and can be resumed.
- **Cancel** stops after the step in progress. Steps that did not run are never charged.
- **A plan that cannot be read** (not JSON, unsafe paths, too many files) is retried once; then the build fails and **what the plan cost is refunded**, because that is the platform's failure.

## Safeguards

- **Paths from the AI are checked before use:** relative only, letters digits `. _ - /`, no `..`, no empty or dot segments, no duplicates, at most 12 files.
- **Tenancy:** every read and action takes the organization from the session; another organization's build is "not found".
- **At most 3 unfinished builds per organization;** one runner per build; the gateway's daily cap and concurrency limits still apply to every step.
- **Stored data:** unlike gateway chat (prompts and answers are not stored), a build's **brief and generated files are stored**, because they are the customer's product.

## API (all under `/api/workspace/jobs`, session required)

| Call | Who |
|---|---|
| `POST /` `{brief, title?, quality?, review?}` | `ai:use` (owner, admin, member) |
| `GET /`, `GET /:id`, `GET /:id/files`, `GET /:id/steps/:seq` | any member |
| `POST /:id/approve` `{budgetUnits?}`, `/:id/resume`, `/:id/cancel` | `ai:use` |

## Not built yet (honest list)

- **The generated files are text only.** Nothing is run, built or previewed. Running generated code safely needs the Docker isolation phase, which is still required before outside users.
- **Files are written one after another and each sees only the plan,** not the other files' contents. That keeps cost predictable but can leave files slightly inconsistent; a review step helps. Parallel steps and "show earlier files to later ones" are possible improvements.
- **Download is one file or one JSON bundle,** not a zip.
- **The runner lives in the server process.** It resumes after a restart only when someone presses Resume. A background worker with a scheduler would make it automatic.
- A step whose answer was charged but lost in a crash is asked again (and paid again); this is rare and recorded in the job's spent total.
- The real AI models have not been called against a live provider yet; the whole flow is tested with a fake provider and with the free demo mode.
