# AGENTS.md — Lucidio AI Video Generator

## Application Context

This repository implements **Lucidio Studio**, a local-first AI video/image generation workspace recreated from the original Claude Design handoff prototype under `local/`. The production implementation must not depend on `support.js`, `x-dc`, or the generated design runtime.

The product is currently an **API-ready local-first shell**:

- The UI is a React/TypeScript app that recreates the dark Lucidio Studio prototype.
- Durable workspace state is stored in **IndexedDB** in the browser.
- A TypeScript/Express backend exists and exposes no-op endpoints for future server-side generation wiring.
- There are no real model-provider calls, uploads, sync, auth, billing, or server-side media storage yet.

Use the spelling **Lucidio** in code, docs, UI, configuration examples, generated filenames, and storage/IndexedDB naming.

## Current Stack

- Frontend: Vite + React + TypeScript
- Backend: Node + Express + TypeScript
- Icons: `lucide-react`
- Persistence: browser IndexedDB via `src/lib/idb.ts`
- Styling: plain CSS in `src/styles.css`

Primary commands:

```bash
npm run dev        # Vite frontend + no-op API backend
npm run typecheck  # frontend + backend TS checks
npm run build      # production client and server builds
npm run preview    # run compiled backend/static app
```

## Directional Architecture

### Frontend

`src/App.tsx` currently owns most UI composition and app-state mutations. Keep future changes component-oriented, but avoid premature abstraction. If a section grows materially, extract it into `src/components/` with narrow props.

Main UI regions:

- `Header` — brand, project tabs, project dropdown menu, new-project action.
- `Sidebar` — output mode, model selection, prompt, references, ratio/resolution/video controls, seed, generate action.
- `WorkspaceHeader` — active project name + inline rename.
- `SceneBlock` — scene title, inline scene rename, scene delete confirmation, drag/reorder, generation grid.
- `GenerationCard` — media placeholder, prompt/meta, preferred/reference/download/delete actions.
- `PreviewModal` — larger media preview and parameters/actions.
- `ProjectDeleteDialog` — modal confirmation for project deletion.

### State and Persistence

Durable state shape lives in `src/types.ts` as `AppState` and is persisted in IndexedDB:

- projects
- scenes
- generations
- active project/scene IDs
- selected reference generation IDs
- generation controls/settings

Transient UI state must **not** be persisted:

- active modal/preview
- inline edit drafts
- delete confirmations
- open dropdown menus
- drag state
- temporary API status strings

When IndexedDB is empty, `buildDefaultState()` in `src/lib/data.ts` must initialize:

- one `Untitled project`
- one empty `Scene 1`
- no generations
- no references
- empty prompt
- unset seed shown as `random`

Deleting the last project is allowed. When there are no projects, the workspace should be blank and generation should be disabled until a new project is created.

### Backend/API Boundary

`server/index.ts` is intentionally a no-op backend. It should expose the expected future surface without real provider integration:

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/generate`
- `POST /api/generate/:jobId/cancel`
- `GET /api/generate/:jobId/status`
- `GET /api/generate/:jobId/events`
- `GET /api/download/:generationId`

Frontend API calls go through `src/lib/api.ts`. Do not call model providers from the browser. Future real generation should be server-side behind this boundary.

## Important UI Decisions So Far

- Generate is disabled when prompt is empty/whitespace or when no project/scene exists.
- Seed is a direct text input with numeric filtering, not a browser number input.
  - Empty seed displays centered `random`.
  - Clear `X` appears inline only when a seed exists.
- Project deletion is intentionally not casual:
  - no tab `X`
  - delete lives in the project tab dropdown menu
  - delete requires modal confirmation
  - deleting the final project leaves an empty workspace
- Project and scene names use inline edit controls.
- Scene header count/preferred metadata was removed.
- Workspace project summary metadata (`N scenes · N generations`) was removed.
- Lucide icons are used for edit/delete/download/favorite/close/status controls.
- Camera motion is represented with Lucide `Orbit`; audio uses `Volume2`/`VolumeX`.
- Camera/audio status icons have hover tooltips.

## Styling Guidance

The visual target is the original dark Lucidio Studio prototype:

- background: near-black `#0d0d10`
- panels: `#101015`, `#111116`, `#16161c`
- borders: `#23232b`, `#2c2c36`, `#34343f`
- accent: indigo/violet `#6366f1`, `#5457e6`, `#c9caf8`
- typography: Inter

Keep styling in `src/styles.css` unless a clear component extraction warrants scoped CSS organization. Preserve full-viewport studio behavior and avoid layout shifts in the header/sidebar/workspace.

## Guardrails / Non-goals

Do not add without explicit direction:

- real AI/model-provider calls
- upload/reference-file workflows
- sync
- persistent server-side storage
- real auth/billing/account system
- broad UI redesign away from the prototype language
- dependency-heavy state libraries unless clearly justified

Do not commit or depend on ignored local/runtime artifacts:

- `local/`
- `.omx/`
- `node_modules/`
- `dist/`
- `dist-server/`

## Verification Expectations

For code changes, run at minimum:

```bash
npm run typecheck
npm run build
```

Do not start `npm run dev` or any dev server for verification. Assume a dev server may already be running externally; use tests, typecheck, and build commands for automated validation instead.
