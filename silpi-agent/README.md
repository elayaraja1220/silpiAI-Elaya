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
- **Live progress:** with `--json` every step is printed as one JSON line (NDJSON): `start`, `status`, `message`, `action`, `result`, `usage`, `done`, `error`.
- **Follow-up edits:** `edit` mode reopens an existing project with its original brief and stack (stored in `.silpi/meta.json`).
- **Documents:** PDFs, images, and text/Markdown/CSV/JSON files can be attached as requirements or design references.
- **Design URLs:** the agent tries to fetch a design reference URL with Claude's `web_fetch` tool. Pages behind a login, such as most Figma links, can't be fetched.
- **Long runs:** the API compacts older context server-side and caches the prompt between turns. If the main model declines a request, the API automatically retries it on a fallback model.

## Safety model
- Every file path is confined to the project folder. `..`, absolute paths, `node_modules`, `.git` and build-output folders are refused.
- `.env` and `.env.local` can't be written. Configuration goes in `.env.example`.
- `run_command` is an allowlist: npm install/ci/run/test, `npx tsc`, `npx prisma generate|validate|format`, composer, `php -l`, `python -m py_compile|compileall|pytest`, go, dotnet and mvn. There are no shell features, and dev servers are blocked because they never exit.
- Child processes don't receive `ANTHROPIC_API_KEY` or any other variable that looks like a credential.
- **Limitation:** `npm install` and `npm run <script>` run the package scripts that the generated project defines, which is how any Node project builds. Review generated projects before you deploy them, and run the agent only on a machine where that's acceptable.

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
```

Add `--json` to get NDJSON events instead of readable output.

The frontend uses `run --json`, which reads one task object from stdin:

```json
{ "mode": "create", "name": "shop-demo", "description": "...", "frontend": ["Next.js"], "backend": [], "database": [], "styling": ["Tailwind CSS"], "designUrl": "", "attachments": [{ "name": "brief.pdf", "mediaType": "application/pdf", "data": "<base64>" }] }
{ "mode": "edit", "name": "shop-demo", "instruction": "Add a dark mode toggle" }
```

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Required |
| `SILPI_MODEL` | `claude-opus-5-5` | |
| `SILPI_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. Higher means more thorough work and more tokens. |
| `SILPI_MAX_TURNS` | `150` | Hard stop for one run |
| `SILPI_OUTPUT_DIR` | `../generated-projects` | Relative to this folder |
| `SILPI_COMMAND_TIMEOUT_MS` / `SILPI_INSTALL_TIMEOUT_MS` | 10 / 15 min | |

## Cost
Each run makes many model calls: one per step, usually 30-100 for a new project. Prompt caching makes repeated context much cheaper, but a full project generation still costs real money. Each `usage` event reports the tokens used, and the frontend shows a running total. Lower `SILPI_EFFORT` to `medium` for cheaper runs.

## Development

```bash
npm run dev -- doctor   # run from source with tsx
npm test                # safety tests: path sandbox, command allowlist, file tools
npm run typecheck
```

| File | Purpose |
|---|---|
| `src/agent.ts` | The agent loop: Claude calls, tool execution, report and metadata |
| `src/tools.ts` | Tool definitions and implementations |
| `src/commands.ts` | Command allowlist and the process runner |
| `src/workspace.ts` | Path sandbox and file tree |
| `src/prompts.ts` | System prompt and task prompts |
| `src/task.ts` | Task input schema |
| `src/cli.ts` | CLI: `run`, `create`, `edit` and `doctor` |
