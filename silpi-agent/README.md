# SILPI Agent

An autonomous project builder powered by Claude. Give it a brief and a tech stack, and it plans the project, writes the code, installs dependencies, runs the build, reads the errors and fixes them until the project builds. It can then make follow-up changes to the same project.

The SILPI frontend (`../frontend-2`) runs this agent and shows its progress live.

## How it works

```text
brief + stack + documents
        │
        ▼
   Claude (claude-opus-5-5, adaptive thinking)
        │  tool calls                ▲ results (file contents, build errors)
        ▼                            │
   list / read / search / write / edit / delete files
   run_command (npm install, npm run build, tsc, lint, test, ...)
        │
        ▼
 ../generated-projects/<name>/   + SILPI-GENERATION.md + .silpi/meta.json
```

- **Self-correcting:** the agent must run the build and type check before it finishes. Every error goes back to Claude, which fixes it and rebuilds.
- **App start check:** when Claude says it is done, SILPI starts the app (`npm run start`, `preview` or `dev`) on a free port and checks that it answers HTTP. If it doesn't, the output goes back to Claude to fix (up to 2 times). A run whose app never starts is reported as failed, even if the build passed.
- **Cost budget:** every turn is priced at Anthropic list prices. At 80% of `SILPI_MAX_COST_USD` Claude is told to wrap up; at 100% the run stops.
- **Resume:** the conversation is saved to `.silpi/session.json` after every turn. A run stopped by the budget, the turn limit, a crash or an API error continues with `resume <name>` instead of starting over.
- **Queue:** at most `SILPI_MAX_CONCURRENT_RUNS` runs work at once, across all processes. Extra runs wait and report that they are queued.
- **Live progress:** with `--json` every step is printed as one JSON line (NDJSON): `start`, `status`, `message`, `action`, `result`, `usage`, `smoke`, `done`, `error`.
- **Follow-up edits:** `edit` mode reopens an existing project with its original brief and stack (stored in `.silpi/meta.json`).
- **Documents:** PDFs, images, and text/Markdown/CSV/JSON files can be attached as requirements or design references.
- **Design URLs:** the agent tries to fetch a design reference URL with Claude's `web_fetch` tool. Pages behind a login, such as most Figma links, can't be fetched.
- **Long runs:** the API compacts older context server-side and caches the prompt between turns. If the main model declines a request, the API automatically retries it on a fallback model.

## Safety model
- Every file path is confined to the project folder. `..`, absolute paths, `node_modules`, `.git` and build-output folders are refused.
- `.env` and `.env.local` can't be written. Configuration goes in `.env.example`.
- `run_command` is an allowlist: npm install/ci/run/test, `npx tsc`, `npx prisma generate|validate|format`, composer, `php -l`, `python -m py_compile|compileall|pytest`, go, dotnet and mvn. There are no shell features, and dev servers are blocked because they never exit.
- Child processes don't receive `ANTHROPIC_API_KEY` or any other variable that looks like a credential.
- **Script guard (local mode):** before `npm run <script>` runs, SILPI reads the script from `package.json`. It must call known build tools directly (next, vite, tsc, eslint, jest, vitest, prisma, `node <file>`, ...), optionally chained with `&&`. Shell syntax (`;`, `|`, `>`, backticks, `$(`) and other programs are refused.
- **Docker sandbox (`SILPI_SANDBOX=docker`):** every command and the app start check run in a throwaway container. The container sees only the project folder and has 4 GB of memory, 2 CPUs, no Linux capabilities and no privilege escalation. Network access stays on so `npm install` works. Dependencies installed in the container are Linux builds, so run `npm install` again before running a project directly on Windows.

### What local mode does not protect against
Building a project always runs code from that project: `next.config.js`, test files, and the install scripts of npm packages. The script guard stops obvious misuse, but in local mode that code runs with your user's permissions. **Use `SILPI_SANDBOX=docker` before letting anyone else send briefs to SILPI.** `doctor` warns when it isn't set.

## Setup

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# put your key in .env:  ANTHROPIC_API_KEY=sk-ant-...
npm run build
node dist/cli.js doctor
```

## Use from the terminal

```bash
node dist/cli.js create shop-demo -p "A bakery storefront with menu, cart and checkout" --frontend "Next.js" --styling "Tailwind CSS"
node dist/cli.js edit shop-demo -p "Add a dark mode toggle and an About page"
node dist/cli.js resume shop-demo   # continue a run that stopped early
```

Add `--json` to get NDJSON events instead of readable output.

The frontend uses `run --json`, which reads one task object from stdin:

```json
{ "mode": "create", "name": "shop-demo", "description": "...", "frontend": ["Next.js"], "backend": [], "database": [], "styling": ["Tailwind CSS"], "designUrl": "", "attachments": [{ "name": "brief.pdf", "mediaType": "application/pdf", "data": "<base64>" }] }
{ "mode": "edit", "name": "shop-demo", "instruction": "Add a dark mode toggle" }
{ "mode": "resume", "name": "shop-demo" }
```

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Required |
| `SILPI_MODEL` | `claude-opus-5-5` | |
| `SILPI_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. Higher means more thorough work and more tokens. |
| `SILPI_MAX_TURNS` | `150` | Hard stop for one run |
| `SILPI_MAX_COST_USD` | `20` | Hard stop for one run, in USD. Claude is warned at 80%. |
| `SILPI_OUTPUT_DIR` | `../generated-projects` | Relative to this folder |
| `SILPI_COMMAND_TIMEOUT_MS` / `SILPI_INSTALL_TIMEOUT_MS` | 10 / 15 min | |
| `SILPI_SMOKE_TIMEOUT_MS` | 2 min | How long the app start check waits for HTTP |
| `SILPI_SANDBOX` | `local` | `docker` runs all commands in a container |
| `SILPI_DOCKER_IMAGE` | `node:22-bookworm` | Image for docker mode |
| `SILPI_MAX_CONCURRENT_RUNS` | `2` | Runs at once; the rest queue |

## Cost
Each run makes many model calls: one per step, usually 30-100 for a new project. Prompt caching makes repeated context much cheaper, but a full project generation still costs real money. Each turn is priced from the token counts the API reports, using Anthropic's list prices in `src/pricing.ts`. Models not in that table are priced at the highest rate. Each `usage` event carries the turn's cost and the run total, `done` carries the total, and the frontend shows spend against the budget. The figure is an estimate: your Anthropic invoice is the source of truth. Lower `SILPI_EFFORT` to `medium` for cheaper runs.

## Development

```bash
npm run dev -- doctor   # run from source with tsx
npm test                # all tests (no API calls: the agent loop uses a fake model)
npm run typecheck
```

| File | Purpose |
|---|---|
| `src/agent.ts` | The agent loop: Claude calls, budget, session save/resume, app start check, report and metadata |
| `src/tools.ts` | Tool definitions and implementations |
| `src/commands.ts` | Command allowlist, script guard, Docker sandbox and the process runner |
| `src/smoke.ts` | App start check |
| `src/queue.ts` | Cross-process run queue |
| `src/pricing.ts` | Model prices for the cost budget |
| `src/workspace.ts` | Path sandbox and file tree |
| `src/prompts.ts` | System prompt and task prompts |
| `src/task.ts` | Task input schema |
| `src/cli.ts` | CLI: `run`, `create`, `edit`, `resume` and `doctor` |

| Test file | Covers |
|---|---|
| `src/safety.test.ts` | Path sandbox, command allowlist, file tools |
| `src/agent.test.ts` | Agent loop with a fake model: build + start-check repair, budget stop + resume, refusal |
| `src/runtime.test.ts` | Script guard, app start check against a real local server, queue, pricing |
