# Architecture

Lucidio Studio is a local-first generation workspace with a React frontend and a TypeScript/Express backend. The frontend owns workspace composition and IndexedDB persistence. The backend owns provider configuration, request validation, generation jobs, media storage, and presigned media access.

## System Overview

```text
Browser
  React UI
  IndexedDB workspace state
  API client
    |
    | /api through Vite proxy in development
    v
Express backend
  model catalog + provider config
  request validation
  in-memory job store
  BytePlus ModelArk adapters
  BytePlus TOS storage adapter
    |
    v
BytePlus ModelArk and TOS-compatible object storage
```

The browser never calls model providers directly. It only receives job state, stored media metadata, and short-lived presigned URLs.

## Runtime Modes

Development:

- `npm run dev` starts the server with `tsx watch server/index.ts` and the Vite dev server.
- Vite serves the React app on port `5188`.
- The backend listens on port `3001`.
- Vite proxies `/api` to `http://localhost:3001`.

Production preview:

- `npm run build` writes the client build to `dist/` and the server build to `dist-server/`.
- `npm run preview` runs `dist-server/index.js`.
- In production mode, the Express app serves static files from `dist/` and falls back to `index.html` for app routes.

## Frontend Architecture

`src/App.tsx` is intentionally a lightweight layout shell. It composes `Header`, `Sidebar`, `WorkspaceView`, and `StudioOverlays` from grouped props returned by `src/app/useStudio.ts`.

The app orchestration is layered below it:

- `src/app/useStudio.ts`: composes reducers, selectors, side-effect hooks, and view props.
- `src/app/useStudioBootstrap.ts`: IndexedDB hydration, model-catalog cache refresh, state autosave, and catalog refresh interval.
- `src/app/useGenerationJobs.ts`: generation request assembly, job polling, resumed-job polling, and reference compatibility checks.
- `src/app/useMediaUrls.ts`: media presign cache and download side effects.
- `src/app/WorkspaceView.tsx`: workspace layout for project header and scenes.
- `src/app/StudioOverlays.tsx`: project delete dialog and preview modal composition.

Most rendered surfaces are split into components:

- `Header`: brand, project tabs, project menu, and project creation.
- `Sidebar`: model/mode selection, prompt, references, advanced controls, seed, and generate action.
- `WorkspaceHeader`: active project title and inline rename.
- `SceneBlock`: scene header, scene actions, drag/reorder, and generation grid.
- `GenerationCard`: per-generation media preview, status, metadata, preferred/reference/download/delete actions.
- `PreviewModal`: larger media preview and generation actions.
- `ProjectDeleteDialog`: project deletion confirmation.

The components are mostly controlled by props. Durable mutations are dispatched through `src/state/studioReducer.ts`; transient UI mutations are dispatched through `src/state/uiReducer.ts`.

## Frontend State

The durable state shape is `AppState` in `src/types.ts`:

- `projects`
- `scenes`
- `generations`
- `activeProjectId`
- `activeSceneId`
- `refIds`
- `referenceSelections`
- `ctl` generation controls
- `seq` ID counter
- `version`

`src/lib/idb.ts` stores state in IndexedDB:

- database: `lucidio-studio`
- object store: `kv`
- state key: `app-state`
- model catalog cache key: `model-catalog`

`src/lib/data.ts` provides defaults and persisted-state normalization. `normalizeStoredState()` repairs missing optional fields and normalizes stored media roles for older state.

Durable state transitions live in `src/state/studioReducer.ts`. Derived state lives in `src/state/studioSelectors.ts`, including active project/scene lookup, generation indexes, selected references, and preview navigation.

Transient UI state stays in `src/state/uiReducer.ts` and is intentionally not written to IndexedDB:

- hydrated flag
- inline edit drafts
- delete confirmations
- project dropdown coordinates
- preview modal ID
- drag state
- API status string
- cached preview URLs

## Model Catalog Flow

The backend loads `server/model-catalog.yaml` through `server/modelCatalog.ts`.

At startup/hydration, the frontend:

1. loads any cached model catalog from IndexedDB.
2. uses the cache immediately when available.
3. calls `GET /api/models` to refresh.
4. stores the refreshed catalog in IndexedDB.
5. normalizes active controls with `src/lib/modelCatalog.ts`.

The backend `GET /api/models` response filters catalog entries to models with configured, non-placeholder endpoint IDs. This keeps unavailable provider models out of the UI.

`src/lib/modelCatalog.ts` maps catalog capabilities to UI behavior:

- selected model and mode normalization.
- ratio and resolution defaults.
- duration/fps clamping.
- camera/audio availability.
- seed/guidance support.
- advanced provider parameters.

## Generation Flow

1. The user selects a mode/model, enters a prompt, optionally selects references, and clicks generate.
2. `src/app/useGenerationJobs.ts` snapshots current controls and validates reference compatibility against the selected model.
3. The frontend posts to `POST /api/generate`.
4. `server/app.ts` loads provider config and model catalog.
5. `server/generationValidation.ts` validates the request and normalizes provider parameters.
6. `server/jobs.ts` creates an in-memory job record.
7. The API returns `202` with the job ID.
8. `src/app/useGenerationJobs.ts` builds the queued generation snapshot, then `src/state/studioReducer.ts` inserts it into the active scene.
9. The backend runs the provider job in the background.
10. The frontend polls `GET /api/generate/:jobId/status`.
11. On completion, the job status includes stored media metadata.
12. The frontend patches the generation with `status`, `progress`, `error`, and `media`.

Images and videos share this route, but the backend dispatches to different provider adapters based on catalog modality.

## Media Flow

Generated media is never persisted as browser blobs or data URLs.

For image jobs:

1. ModelArk returns image bytes.
2. The backend creates an object key with `server/mediaKeys.ts`.
3. `BytePlusTosStorageAdapter.putObject()` uploads the image.
4. The job result includes a primary stored media asset.

For video jobs:

1. ModelArk creates and completes a provider task.
2. The adapter downloads the MP4 and returned last-frame thumbnail.
3. The backend uploads the MP4 as primary media.
4. The backend uploads the thumbnail as a related image asset.
5. The job result includes primary video metadata, thumbnail metadata, and provider task metadata.

Preview and download:

1. The frontend calls `POST /api/media/presign`.
2. The backend validates object key shape, content type, purpose, and asset role.
3. The storage adapter returns a short-lived signed GET URL.
4. The frontend caches preview URLs until shortly before expiry. Download URLs are requested on demand.

## Backend Architecture

`server/index.ts` is the listen entrypoint. `server/app.ts` builds the Express app and accepts dependency overrides for tests.

Main backend responsibilities:

- logging API POSTs and errors.
- returning configured model catalogs.
- accepting generation jobs.
- cancelling active jobs.
- exposing job status and server-sent status events.
- creating presigned media URLs.
- serving the compiled frontend in production.

Validation and provider boundaries are deliberately separate:

- `server/contracts.ts`: API contract types.
- `server/modelCatalog.ts`: catalog parsing and structural validation.
- `server/providerConfig.ts`: provider config parsing and validation.
- `server/generationValidation.ts`: request validation, model capability checks, provider param normalization, and reference validation.
- `server/mediaKeys.ts`: object-key and content-type rules.
- `server/provider/*`: ModelArk adapter interfaces and BytePlus implementations.
- `server/storage/*`: object storage interface, BytePlus TOS implementation, and request signing.

## Job Store And Cancellation

`JobStore` is in-memory and process-local. It records:

- job ID.
- status.
- progress.
- error.
- result media.
- timestamps.
- cancellation flag.

Cancellation behavior:

- `POST /api/generate/:jobId/cancel` marks the job cancelled locally.
- active video jobs get an `AbortController` signal.
- if a BytePlus provider task ID is known, the backend best-effort calls provider cancellation.
- uploads that are cancelled mid-video flow are cleaned up when possible.

Limitations:

- jobs are not durable across server restarts.
- cancellation state is not durable.
- completed object-storage media remains in the bucket unless explicitly deleted by cleanup code during failed/cancelled flows.

## API Surface

Current routes:

- `GET /api/models`: configured model catalog for the frontend.
- `POST /api/auth/login`: no-op local login response.
- `POST /api/auth/logout`: no-op local logout response.
- `POST /api/generate`: validate, enqueue, and start image/video generation.
- `POST /api/generate/:jobId/cancel`: cancel local and active provider work where possible.
- `GET /api/generate/:jobId/status`: current job snapshot.
- `GET /api/generate/:jobId/events`: server-sent status events.
- `POST /api/media/presign`: signed preview/download URL for stored generated media.
- `GET /api/download/:generationId`: retired legacy endpoint that returns `410`.

## Provider Architecture

The current real provider path is BytePlus:

- Model catalog: `server/model-catalog.yaml`
- Provider config: `server/provider-config.example.yaml` and ignored local override `server/provider-config.local.yaml`
- Image adapter: `server/provider/byteplusImageAdapter.ts`
- Video adapter: `server/provider/byteplusVideoAdapter.ts`
- Storage adapter: `server/storage/byteplusTosStorage.ts`

Provider details and setup live in [provider/byteplus.md](provider/byteplus.md).

The frontend is intentionally provider-neutral at the request boundary. It sends Lucidio controls and selected reference metadata; the backend maps those to provider parameters.

## Extension Points

Adding UI controls:

- update `GenerationControls` and `Generation` in `src/types.ts`.
- add defaults in `src/lib/data.ts`.
- render controls in `src/components/Sidebar.tsx` or a new narrow component.
- normalize model-dependent behavior in `src/lib/modelCatalog.ts`.
- validate and map the field in `server/generationValidation.ts`.

Adding models:

- update `server/model-catalog.yaml`.
- add local endpoint IDs in `server/provider-config.local.yaml`.
- update `server/provider-config.example.yaml` only for example placeholders.
- adjust validation only if a model introduces new parameter semantics.

Adding a provider:

- add provider adapter interfaces or implementations under `server/provider/`.
- add storage support under `server/storage/` if media storage changes.
- extend `server/providerConfig.ts` and config examples.
- decide how the catalog represents provider/family/modality.
- keep browser calls routed through `src/lib/api.ts`.

Adding persisted state:

- update `src/types.ts`.
- update defaults and normalization in `src/lib/data.ts`.
- consider whether old IndexedDB state needs migration or compatibility normalization.

## Testing And Verification

Backend tests live in `server/__tests__/generation.test.ts` and cover:

- provider config behavior.
- request validation.
- media key validation.
- adapter error handling.
- image and video generation routes.
- presign validation.
- cancellation and cleanup behavior.

Recommended verification:

```bash
npm run test:client
npm run test:server
npm run typecheck
npm run build
```

For docs-only changes, a link/path sanity check is usually enough.

## Current Constraints

Lucidio is not yet a multi-user production service.

Current non-goals:

- upload/reference-file workflows.
- persistent server-side job storage.
- server-side media manifest/database.
- sync across browsers or devices.
- real auth, billing, or account management.
- non-BytePlus providers.
- public object URLs.

The object keys stored in IndexedDB are capability references for a local-first shell, not an ownership or authorization model.
