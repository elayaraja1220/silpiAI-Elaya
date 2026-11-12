# SILPI AI Frontend

A modern Next.js + TypeScript frontend starter for the SILPI AI software development workspace.

## Requirements
- Node.js 20.9+
- npm, pnpm, yarn or bun

## Run locally
```bash
npm install
cp .env.example .env.local
npm run dev
```
Open http://localhost:3000.

## Build
```bash
npm run build
npm start
```

## Folder structure
```text
src/
  app/                  # Next.js App Router routes and global styles
  components/
    layout/             # Application shell, navigation
    pages/              # Feature-level page views
    ui/                 # Reusable UI components
  lib/                  # Utilities and API client
  mockdata/             # Separate sample data and technology registry
  types/                # Shared TypeScript types
```

## Included screens
- Dashboard overview
- Create project form with searchable technology selectors and multi-file selection
- My projects with search, status filtering and grid/list views
- Existing project import UI for ZIP and browser folder selection
- Agent activity
- Workspace settings

## Important integration notes
This is a frontend starter with sample data. The UI does not yet call a real AI service, upload files to a backend, execute terminal commands, or generate projects. Connect these screens to your Node.js/TypeScript API using `src/lib/api.ts`. Store AI provider credentials on the backend only.

For full local folder access and safe process execution, build and install a trusted local workspace agent. Browser folder selection alone does not provide unrestricted filesystem or terminal access.
