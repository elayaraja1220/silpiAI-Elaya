# SILPI AI Frontend

The web UI for **SILPI AI**, a local AI development studio. Describe the app you want, attach requirement documents, and choose a tech stack. The **SILPI agent**, powered by Claude, then plans, writes, builds and fixes a runnable project on your machine while you watch its progress live. You can then ask it for follow-up changes.

Built with Next.js 15 (App Router), React 19, TypeScript and Tailwind CSS.

## How it works

```text
Browser (this UI)
   │  POST /api/projects/generate        { name, description, stack, designUrl, attachments }
   │  POST /api/projects/:name/edit      { instruction, attachments }
   ▼
Next.js API route ──spawns──► node silpi-agent/dist/cli.js run --json   (task JSON on stdin)
   ▲                                   │  Claude agent loop: write files → npm install → build → fix errors → ...
   │  NDJSON progress events ◄─────────┘
   │                                   ▼
   │                         generated-projects/<name>/
   │  GET /api/projects  ◄──reads──────┘
Overview + My projects
```

Expected folder layout on the same machine:

```text
SilpiAgent/
  frontend-2/           # this project
  silpi-agent/          # the SILPI agent (Claude), see its README
  generated-projects/   # output, one sub-folder per project
```

## Requirements
- Node.js 20.9+
- The `silpi-agent` folder, built once, with an Anthropic API key in `silpi-agent/.env`

## Setup

```bash
# 1. The agent
cd ../silpi-agent
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY=sk-ant-...
npm run build

# 2. This frontend
cd ../frontend-2
npm install
cp .env.example .env.local  # set SILPI_AGENT_DIR to the silpi-agent folder
npm run dev
```

Open http://localhost:3000. The Overview page's **Agent status** card shows "Ready" when everything is set up.

### Environment variables (`.env.local`)

| Variable | Required | Description |
|---|---|---|
| `SILPI_AGENT_DIR` | Yes | Absolute path to the `silpi-agent` folder. Use forward slashes on Windows. |
| `SILPI_OUTPUT_DIR` | No | Where projects are written. Relative paths resolve from `SILPI_AGENT_DIR`. Default: `../generated-projects`. Keep it identical to the agent's setting. |
| `NEXT_PUBLIC_APP_NAME` | No | Display name. |

The Anthropic API key belongs in the **agent's** `.env`, never in this frontend.

## Screens

| Screen | Status |
|---|---|
| **Overview** | Live: project counts, recent projects and agent status (configured, built, API key present). |
| **Create project** | Live: sends the brief, stack, design URL and attached documents to the agent. A live log shows each file written, each command run and each error fixed, plus token usage. |
| **My projects** | Live: lists every generated project, with search, status filter and grid/list views. **Ask for changes** sends a follow-up request to the agent, with live progress. Projects that are still generating refresh automatically. |
| Existing projects | UI only: importing outside projects isn't connected yet. |
| Agent activity | UI only. |
| Settings | UI only. |

### Attachments
PDF, PNG, JPG, WEBP, GIF, TXT, MD, CSV and JSON files are accepted: up to 10 files, 5 MB each and 20 MB in total. They are sent to Claude as requirement and design references. Word, Excel and PowerPoint files aren't supported; export them to PDF first.

### How project details are detected
`GET /api/projects` reads each sub-folder of the output directory:
- **Description**: the first paragraph of `SILPI-GENERATION.md`, which is the agent's own summary.
- **Stack**: the stack chosen at creation (`.silpi/meta.json`), falling back to detection from `package.json` / `composer.json`.
- **Status**:
  - `Generating` while an agent process holds `.silpi/running.lock`.
  - `Needs attention` if the last run failed or its build check failed.
  - Otherwise `Ready`.

## API routes

| Route | Description |
|---|---|
| `POST /api/projects/generate` | Validates the input and starts a create run. The response streams NDJSON `AgentEvent`s. Returns `409` if the name is already taken. |
| `POST /api/projects/:name/edit` | Starts an edit run on an existing project and streams NDJSON events. |
| `GET /api/projects` | Lists projects and reports agent status. |

The event types (`start`, `status`, `message`, `action`, `result`, `usage`, `done`, `error`) are defined in `src/types/index.ts` and match `silpi-agent/src/events.ts`.

## Known limitations
- **Local only.** The API starts processes and writes folders on the machine running Next.js, so it can't be deployed as a public website as it is.
- **Generated code runs on your machine.** The agent runs `npm install` and the project's own build scripts. Review projects before deploying them.
- **Cost.** Each run makes many Claude API calls. The live panel shows the tokens used.
- **Closing the page doesn't cancel a run.** The project still finishes and appears in My projects.

## Folder structure
```text
src/
  app/api/projects/            # GET list
  app/api/projects/generate/   # POST create (streams)
  app/api/projects/[name]/edit # POST edit (streams)
  components/
    layout/                    # Application shell, navigation
    pages/                     # Feature-level page views
    ui/                        # Reusable UI, incl. agent-run-panel (live log)
  lib/                         # silpi-paths, silpi-runner, silpi-validate, use-agent-run, use-projects
  mockdata/                    # Technology registry for the stack picker
  types/                       # Shared TypeScript types
```

## Scripts
```bash
npm run dev     # development server
npm run build   # production build
npm start       # run the production build
```
