# Lucidio - AI Video Generator

Lucidio Studio is a local-first React and Express workspace for AI image and video generation. The browser owns project composition and durable workspace state in IndexedDB; the server owns provider configuration, generation jobs, media storage, and presigned media access.

## Quick Start

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5188
- API backend: http://localhost:3001
- Vite proxies `/api/*` requests to the backend.

## Commands

```bash
npm run dev          # Run Vite and the Express API together
npm run dev:client   # Run only the Vite frontend
npm run dev:server   # Run only the Express API with tsx watch
npm run test:client  # Run frontend reducer/selector tests
npm run test:server  # Run backend/API tests
npm run typecheck    # Typecheck frontend and backend
npm run build        # Build client into dist/ and server into dist-server/
npm run preview      # Run the compiled server/static app
```

For code changes, run at least:

```bash
npm run typecheck
npm run build
```

For backend/API/provider changes, also run:

```bash
npm run test:server
```

## Project Structure

```text
src/
  App.tsx                    Lightweight top-level layout shell
  main.tsx                   React entrypoint
  styles.css                 Global studio styling
  types.ts                   Shared frontend domain types
  app/                       App composition hooks and layout-level views
  components/                Presentational UI components
  lib/
    api.ts                   Browser API client
    data.ts                  Defaults, state normalization, UI helpers
    generationMedia.ts       Media filename/status/cache helpers
    idb.ts                   IndexedDB persistence
    modelCatalog.ts          Frontend catalog/control normalization
    referenceIntents.ts      Reference intent derivation
  state/                     Pure reducers, selectors, and frontend state tests

server/
  index.ts                   Express listen entrypoint
  app.ts                     API routes, job flow, provider/storage wiring
  contracts.ts               API and media contracts
  generationValidation.ts    Request validation and provider param normalization
  jobs.ts                    In-memory generation job store
  mediaKeys.ts               Object key and content-type validation
  model-catalog.yaml         BytePlus model catalog
  modelCatalog.ts            Model catalog loader/validator
  providerConfig.ts          Provider config loader/validator
  provider/                  ModelArk image/video adapters
  storage/                   BytePlus TOS adapter and signing
  __tests__/                 Server/API regression tests

docs/
  architecture.md            System architecture and data-flow reference
  provider/byteplus.md       BytePlus setup and provider behavior
```

Ignored local/runtime paths include `node_modules/`, `dist/`, `dist-server/`, `local/`, `.omx/`, `.env*`, and `server/provider-config.local.yaml`.

## Documentation

- [Architecture](docs/architecture.md): frontend/backend boundaries, data flow, persistence, API surface, and extension points.
- [BytePlus provider](docs/provider/byteplus.md): ModelArk/TOS setup, environment variables, model endpoint mapping, media storage, references, and provider non-goals.

## State And Persistence

Durable workspace state is stored in browser IndexedDB database `lucidio-studio`:

- projects
- scenes
- generations
- active project and scene IDs
- selected reference generation IDs
- generation controls
- cached model catalog

Transient UI state is not persisted: modals, inline edit drafts, dropdown state, drag state, temporary API status, and preview URLs.

If IndexedDB is empty, `buildDefaultState()` creates one `Untitled project`, one `Scene 1`, no generations, no references, an empty prompt, and a random seed display.

## API And Provider Boundary

The browser calls `src/lib/api.ts`; provider calls stay server-side.

Main backend routes:

- `GET /api/models`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/generate`
- `POST /api/generate/:jobId/cancel`
- `GET /api/generate/:jobId/status`
- `GET /api/generate/:jobId/events`
- `POST /api/media/presign`
- `GET /api/download/:generationId` returns `410` for the retired legacy download path.

Generation jobs are in memory. Completed media is stored in object storage, but active job status and cancellation state do not survive a server restart.

## How To Do Common Tasks

### Add Or Change UI

- Keep small UI changes in the existing component.
- Extract to `src/components/` when a section grows or needs a narrow reusable prop surface.
- Keep durable domain fields in `src/types.ts`; keep temporary UI-only flags in `src/state/uiReducer.ts` or focused app hooks.
- Keep styling in `src/styles.css` unless a future component extraction clearly justifies another organization.

### Add A Generation Control

1. Add the durable control field to `GenerationControls` in `src/types.ts`.
2. Add its default in `src/lib/data.ts`.
3. Render and update it in the relevant component, usually `src/components/Sidebar.tsx`.
4. Normalize it against model capabilities in `src/lib/modelCatalog.ts` if it depends on the selected model.
5. Accept and validate it in `server/generationValidation.ts`.
6. Include it in `Generation` snapshots if completed generations must retain the value.

### Add Or Update BytePlus Models

1. Update `server/model-catalog.yaml`.
2. Keep `sourceDocs` and `updated` accurate.
3. Add endpoint IDs to `server/provider-config.local.yaml` for local use.
4. Update `server/provider-config.example.yaml` only for non-secret example mappings.
5. Run `npm run test:server` and `npm run typecheck`.

Models with missing or placeholder endpoint IDs are hidden from `GET /api/models`.

### Configure Real Provider Use

Copy the example provider config:

```bash
cp server/provider-config.example.yaml server/provider-config.local.yaml
```

Set the environment variables referenced by that config, then run `npm run dev`. Full setup details are in [docs/provider/byteplus.md](docs/provider/byteplus.md).

### Work With Generated Media

- Do not store provider credentials or public object URLs in the browser.
- Store object metadata only.
- Use `POST /api/media/presign` for preview, playback, and download URLs.
- Validate new media key shapes in `server/mediaKeys.ts`.

### Add Backend API Behavior

- Add request/response contracts in `server/contracts.ts`.
- Add route handling in `server/app.ts`.
- Put validation close to existing validation modules before provider/storage calls.
- Add or update tests in `server/__tests__/generation.test.ts`.

## Current Non-goals

Lucidio does not currently include upload/reference-file workflows, sync, persistent server-side job storage, real auth, billing, account management, or non-BytePlus providers.

## License

Lucidio is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
