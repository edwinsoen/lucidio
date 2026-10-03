import express from 'express';
import path from 'node:path';
import sharp from 'sharp';
import { apiError, type PresignRequest, type ThumbnailRequest } from './contracts.js';
import { catalogErrorResponse, loadModelCatalog, type ModelCatalog, type ModelCatalogEntry, type ModelsResponse } from './modelCatalog.js';
import { BytePlusImageAdapter } from './provider/byteplusImageAdapter.js';
import { BytePlusVideoAdapter } from './provider/byteplusVideoAdapter.js';
import { GeminiImageAdapter } from './provider/geminiImageAdapter.js';
import { GeminiVeoAdapter } from './provider/geminiVeoAdapter.js';
import { GeminiOmniFlashAdapter } from './provider/geminiOmniFlashAdapter.js';
import type { ImageGenerationAdapter } from './provider/imageAdapter.js';
import { VideoProviderError, type VideoGenerationAdapter, type VideoReferenceInput } from './provider/videoAdapter.js';
import { endpointRefForModel, geminiConfigOrThrow, hasConfiguredModel, loadProviderConfig, ProviderConfigError, type ProviderConfig } from './providerConfig.js';
import { RequestValidationError, supportedReferenceIntentsForModel, validateGenerateRequest } from './generationValidation.js';
import { JobStore } from './jobs.js';
import { assertContentTypeMatchesKey, contentTypeForKey, createGenerationObjectKey, filenameForKey, isImageContentType, isVideoContentType, validateObjectKey } from './mediaKeys.js';
import { BytePlusTosStorageAdapter } from './storage/byteplusTosStorage.js';
import type { ObjectStorageAdapter } from './storage/storageAdapter.js';

const THUMBNAIL_MAX_EDGE_PX = 320;
const THUMBNAIL_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const THUMBNAIL_WEBP_QUALITY = 78;
type GenerationModality = 'image' | 'video';

export interface AppDependencies {
  catalog?: ModelCatalog;
  config?: ProviderConfig;
  imageAdapter?: ImageGenerationAdapter;
  videoAdapter?: VideoGenerationAdapter;
  storageAdapter?: ObjectStorageAdapter;
  jobStore?: JobStore;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  staticDir?: string;
  production?: boolean;
}


function isSupportedEndpoint(model: ModelCatalogEntry): boolean {
  if (model.provider === 'gemini') {
    if (model.modality === 'image') return model.endpoint === '/v1beta/interactions';
    return model.endpoint === '/v1beta/interactions' || model.endpoint.endsWith(':predictLongRunning');
  }
  return (model.modality === 'image' && model.endpoint === '/api/v3/images/generations') || (model.modality === 'video' && model.endpoint === '/api/v3/contents/generations/tasks');
}

function supportedModelsResponse(catalog: ModelCatalog, config: ProviderConfig): ModelsResponse {
  const models = catalog.models
    .filter((model) => isSupportedEndpoint(model) && hasConfiguredModel(config, model))
    .map((model) => model.modality === 'video' ? { ...model, capabilities: { ...model.capabilities, referenceIntents: supportedReferenceIntentsForModel(model) } } : model);
  return { ok: true, count: models.length, ...catalog, models };
}

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const jobs = deps.jobStore ?? new JobStore();
  const logger = deps.logger ?? console;
  const activeVideoJobs = new Map<string, { controller: AbortController; taskId?: string; cancelProvider?: (taskId: string) => Promise<void> }>();

  app.use('/api', (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const shouldLog = req.method === 'POST' || res.statusCode >= 400;
      if (shouldLog) logger.info(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  function catalog() { return deps.catalog ?? loadModelCatalog(); }
  function config() { return deps.config ?? loadProviderConfig(); }
  function storage() { return deps.storageAdapter ?? new BytePlusTosStorageAdapter(config().storage.byteplusTos); }
  function byteplusModelArk(cfg: ProviderConfig) {
    const byteplus = cfg.providers.byteplus;
    if (!byteplus) throw new ProviderConfigError('Missing BytePlus provider config', 'Configure providers.byteplus.modelArk in server/provider-config.local.yaml.');
    return byteplus.modelArk;
  }
  function imageAdapter(model: ModelCatalogEntry): ImageGenerationAdapter {
    if (deps.imageAdapter) return deps.imageAdapter;
    const cfg = config();
    return model.provider === 'gemini' ? new GeminiImageAdapter(geminiConfigOrThrow(cfg)) : new BytePlusImageAdapter(byteplusModelArk(cfg));
  }
  function videoAdapter(model: ModelCatalogEntry): VideoGenerationAdapter {
    if (deps.videoAdapter) return deps.videoAdapter;
    const cfg = config();
    if (model.provider === 'gemini') {
      const gemini = geminiConfigOrThrow(cfg);
      return model.family === 'omni-flash' ? new GeminiOmniFlashAdapter(gemini) : new GeminiVeoAdapter(gemini);
    }
    return new BytePlusVideoAdapter(byteplusModelArk(cfg));
  }

  app.get('/api/models', (_req, res) => {
    try {
      res.json(supportedModelsResponse(catalog(), config()));
    } catch (error) {
      if (error instanceof ProviderConfigError) return respondKnownError(res, error);
      res.status(500).json(catalogErrorResponse(error));
    }
  });

  app.post('/api/auth/login', (req, res) => {
    res.json({ ok: true, user: { initials: 'AN', name: req.body?.name || 'Anonymous' }, token: 'noop-local-token' });
  });

  app.post('/api/auth/logout', (_req, res) => { res.json({ ok: true }); });

  app.post('/api/generate', (req, res) => {
    try {
      const cfg = config();
      const currentCatalog = catalog();
      const validated = validateGenerateRequest(req.body, currentCatalog, cfg.storage.byteplusTos.keyPrefix);
      const endpointId = endpointRefForModel(cfg, validated.model);
      const job = jobs.create();
      logger.info(`[job:${job.id}] accepted model=${validated.model.id} modality=${validated.model.modality} references=${validated.references.length}`);
      res.status(202).json({ ok: true, jobId: job.id, status: job.status });
      let runner: Promise<void>;
      if (validated.model.modality === 'video') {
        const adapter = videoAdapter(validated.model);
        const controller = new AbortController();
        activeVideoJobs.set(job.id, { controller, cancelProvider: adapter.cancel?.bind(adapter) });
        runner = runVideoJob({
          jobs,
          jobId: job.id,
          validated,
          endpointId,
          storage: storage(),
          videoAdapter: adapter,
          keyPrefix: cfg.storage.byteplusTos.keyPrefix,
          logger,
          signal: controller.signal,
          onTaskCreated: (taskId) => {
            const active = activeVideoJobs.get(job.id);
            if (active) active.taskId = taskId;
          }
        }).finally(() => activeVideoJobs.delete(job.id));
      } else {
        runner = runImageJob({ jobs, jobId: job.id, validated, endpointId, storage: storage(), imageAdapter: imageAdapter(validated.model), keyPrefix: cfg.storage.byteplusTos.keyPrefix, logger });
      }
      void runner.catch((error) => {
        safeFailJob(jobs, job.id, validated.model.modality, error, logger);
      });
    } catch (error) {
      respondKnownError(res, error);
    }
  });

  app.post('/api/generate/:jobId/cancel', async (req, res) => {
    const job = jobs.cancel(req.params.jobId);
    const activeVideo = activeVideoJobs.get(job.id);
    if (activeVideo) {
      activeVideo.controller.abort();
      if (activeVideo.taskId && activeVideo.cancelProvider) void activeVideo.cancelProvider(activeVideo.taskId)
        .then(() => logger.info(`[job:${job.id}] provider-cancel task=${activeVideo.taskId}`))
        .catch((error) => logger.warn(`[job:${job.id}] provider-cancel-failed ${safeErrorMessage(error)}`));
    }
    res.json({ ok: true, jobId: job.id, status: job.status });
  });

  app.get('/api/generate/:jobId/status', (req, res) => {
    const response = jobs.response(req.params.jobId);
    if (!response) return res.status(404).json(apiError('Unknown job', `No generation job exists for ${req.params.jobId}.`, 'not_found'));
    res.json(response);
  });

  app.get('/api/generate/:jobId/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const send = () => {
      const response = jobs.response(req.params.jobId);
      res.write(`event: status\ndata: ${JSON.stringify(response ?? { ok: false, error: 'Unknown job' })}\n\n`);
      return !response || ['complete', 'failed', 'cancelled'].includes(response.status);
    };
    const unsubscribe = jobs.subscribe(req.params.jobId, () => {
      if (send()) {
        unsubscribe();
        res.end();
      }
    });
    req.on('close', unsubscribe);
    if (send()) {
      unsubscribe();
      res.end();
    }
  });

  app.post('/api/media/presign', async (req, res) => {
    try {
      const cfg = config();
      const body = req.body as Partial<PresignRequest>;
      if (body.purpose !== 'preview' && body.purpose !== 'download') throw new RequestValidationError('Invalid presign purpose', 'purpose must be preview or download.');
      if (typeof body.key !== 'string') throw new RequestValidationError('Invalid media key', 'key must be a string.');
      validateObjectKey(body.key, cfg.storage.byteplusTos.keyPrefix);
      const assetRole = body.assetRole ?? 'primary';
      if (assetRole !== 'primary' && assetRole !== 'thumbnail') throw new RequestValidationError('Invalid presign asset role', 'assetRole must be primary or thumbnail.');
      const keyContentType = contentTypeForKey(body.key, cfg.storage.byteplusTos.keyPrefix);
      if (body.contentType) assertContentTypeMatchesKey(body.key, body.contentType, cfg.storage.byteplusTos.keyPrefix);
      if (assetRole === 'thumbnail' && !isImageContentType(keyContentType)) throw new RequestValidationError('Invalid presign asset role', 'thumbnail assets must use an image content type.');
      if (assetRole === 'primary' && body.purpose === 'download' && !isImageContentType(keyContentType) && !isVideoContentType(keyContentType)) throw new RequestValidationError('Invalid media request', 'primary downloads must be image or video media.');
      const result = await storage().presignGet({ key: body.key, purpose: body.purpose, filename: body.filename, contentType: body.contentType, ttlSeconds: body.ttlSeconds, assetRole });
      res.json({ ok: true, ...result });
    } catch (error) {
      respondKnownError(res, error);
    }
  });

  app.post('/api/media/thumbnail', async (req, res) => {
    try {
      const cfg = config();
      const body = req.body as Partial<ThumbnailRequest>;
      if (typeof body.key !== 'string') throw new RequestValidationError('Invalid media key', 'key must be a string.');
      validateObjectKey(body.key, cfg.storage.byteplusTos.keyPrefix);
      const assetRole = body.assetRole ?? 'primary';
      if (assetRole !== 'primary' && assetRole !== 'thumbnail') throw new RequestValidationError('Invalid thumbnail asset role', 'assetRole must be primary or thumbnail.');
      const keyContentType = contentTypeForKey(body.key, cfg.storage.byteplusTos.keyPrefix);
      if (body.contentType) assertContentTypeMatchesKey(body.key, body.contentType, cfg.storage.byteplusTos.keyPrefix);
      if (!isImageContentType(keyContentType)) throw new RequestValidationError('Invalid thumbnail media', 'thumbnail requests must target image media.');
      const thumbnail = await renderThumbnail({ storage: storage(), key: body.key, contentType: body.contentType ?? keyContentType });
      res
        .status(200)
        .setHeader('Content-Type', 'image/webp')
        .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
        .setHeader('Content-Length', String(thumbnail.length))
        .send(thumbnail);
    } catch (error) {
      respondKnownError(res, error);
    }
  });

  app.get('/api/download/:generationId', (_req, res) => {
    res.status(410).json(apiError('Legacy download endpoint retired', 'Use POST /api/media/presign with a generation media object key.'));
  });

  const staticDir = deps.staticDir ?? path.resolve(process.cwd(), 'dist');
  app.use(express.static(staticDir));
  app.get(/.*/, (_req, res, next) => {
    if (!(deps.production ?? process.env.NODE_ENV === 'production')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  return app;
}

async function renderThumbnail(input: { storage: ObjectStorageAdapter; key: string; contentType: string }): Promise<Buffer> {
  const source = await input.storage.getObject({ key: input.key, contentType: input.contentType, maxBytes: THUMBNAIL_SOURCE_MAX_BYTES });
  if (!isImageContentType(source.contentType)) throw new RequestValidationError('Invalid thumbnail media', 'thumbnail requests must target image media.');
  try {
    return await sharp(source.body, { failOn: 'none' })
      .rotate()
      .resize({ width: THUMBNAIL_MAX_EDGE_PX, height: THUMBNAIL_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer();
  } catch (error) {
    throw new Error(`Thumbnail resize failed: ${safeErrorMessage(error)}`);
  }
}

async function runImageJob(input: {
  jobs: JobStore;
  jobId: string;
  validated: ReturnType<typeof validateGenerateRequest>;
  endpointId: string;
  storage: ObjectStorageAdapter;
  imageAdapter: ImageGenerationAdapter;
  keyPrefix: string;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
}) {
  const { jobs, jobId, validated } = input;
  if (jobs.get(jobId)?.cancelled) return;
  input.logger.info(`[job:${jobId}] provider-start model=${validated.model.id} size=${String(validated.providerParams.size ?? 'default')}`);
  jobs.patch(jobId, { status: 'running', progress: { label: generationProgressLabel('image', 'generating') } });
  const references = [];
  for (const reference of validated.references) {
    input.logger.info(`[job:${jobId}] presign-reference key=${reference.media.key}`);
    const signed = await input.storage.presignGet({ key: reference.media.key, purpose: 'preview', contentType: reference.media.contentType });
    references.push({ id: reference.id, url: signed.url });
  }
  const image = await input.imageAdapter.generate({ model: validated.model, endpointId: input.endpointId, prompt: validated.request.prompt, params: validated.providerParams, references });
  if (jobs.get(jobId)?.cancelled) return;
  input.logger.info(`[job:${jobId}] provider-complete bytes=${image.bytes.length} contentType=${image.contentType}`);
  jobs.patch(jobId, { status: 'uploading', progress: { label: generationProgressLabel('image', 'saving') } });
  const generationId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const key = createGenerationObjectKey(input.keyPrefix, jobId, generationId, image.contentType);
  input.logger.info(`[job:${jobId}] storage-put key=${key}`);
  const media = await input.storage.putObject({ key, body: image.bytes, contentType: image.contentType });
  if (jobs.get(jobId)?.cancelled) return;
  jobs.patch(jobId, { status: 'complete', progress: { label: 'Complete', percent: 100 }, result: { media: { ...media, kind: 'image', role: 'primary' }, usage: image.usage } });
  input.logger.info(`[job:${jobId}] complete key=${media.key} size=${media.size}`);
}

async function runVideoJob(input: {
  jobs: JobStore;
  jobId: string;
  validated: ReturnType<typeof validateGenerateRequest>;
  endpointId: string;
  storage: ObjectStorageAdapter;
  videoAdapter: VideoGenerationAdapter;
  keyPrefix: string;
  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  signal?: AbortSignal;
  onTaskCreated?: (taskId: string) => void;
}) {
  const { jobs, jobId, validated } = input;
  if (jobs.get(jobId)?.cancelled) return;
  input.logger.info(`[job:${jobId}] video-provider-start model=${validated.model.id}`);
  jobs.patch(jobId, { status: 'running', progress: { label: 'Creating task' } });
  const references: VideoReferenceInput[] = [];
  for (const reference of validated.references) {
    const asset = referenceAssetForProvider(reference);
    input.logger.info(`[job:${jobId}] presign-video-reference key=${asset.key} intent=${reference.intent ?? 'image_reference'}`);
    const signed = await input.storage.presignGet({ key: asset.key, purpose: 'preview', contentType: asset.contentType, assetRole: asset.role === 'thumbnail' ? 'thumbnail' : 'primary' });
    references.push({
      generationId: reference.id,
      intent: reference.intent ?? 'image_reference',
      url: signed.url,
      contentType: asset.contentType,
      kind: asset.kind ?? (asset.contentType.startsWith('video/') ? 'video' : 'image'),
      providerTask: reference.providerTask
    });
  }
  const video = await input.videoAdapter.generate({
    model: validated.model,
    endpointId: input.endpointId,
    prompt: validated.request.prompt,
    params: validated.providerParams,
    references,
    signal: input.signal,
    onTaskCreated: (taskId) => {
      input.onTaskCreated?.(taskId);
      if (!jobs.get(jobId)?.cancelled) jobs.patch(jobId, { status: 'running', progress: { label: generationProgressLabel('video', 'generating') } });
    }
  });
  if (jobs.get(jobId)?.cancelled) return;
  input.logger.info(`[job:${jobId}] video-provider-complete bytes=${video.video.bytes.length} thumbnailBytes=${video.thumbnail.bytes.length}`);
  jobs.patch(jobId, { status: 'uploading', progress: { label: generationProgressLabel('video', 'saving') } });
  const generationId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const videoKey = createGenerationObjectKey(input.keyPrefix, jobId, generationId, video.video.contentType);
  const thumbnailKey = createGenerationObjectKey(input.keyPrefix, jobId, `${generationId}_thumb`, video.thumbnail.contentType);
  let uploadedVideoKey: string | undefined;
  let uploadedThumbnailKey: string | undefined;
  try {
    input.logger.info(`[job:${jobId}] storage-put-video key=${videoKey}`);
    const primary = await input.storage.putObject({ key: videoKey, body: video.video.bytes, contentType: video.video.contentType });
    uploadedVideoKey = primary.key;
    if (jobs.get(jobId)?.cancelled) {
      await cleanupUploadedMedia(input.storage, input.logger, jobId, [uploadedVideoKey]);
      return;
    }
    input.logger.info(`[job:${jobId}] storage-put-thumbnail key=${thumbnailKey}`);
    const thumbnail = await input.storage.putObject({ key: thumbnailKey, body: video.thumbnail.bytes, contentType: video.thumbnail.contentType });
    uploadedThumbnailKey = thumbnail.key;
    if (jobs.get(jobId)?.cancelled) {
      await cleanupUploadedMedia(input.storage, input.logger, jobId, [uploadedThumbnailKey, uploadedVideoKey]);
      return;
    }
    jobs.patch(jobId, {
      status: 'complete',
      progress: { label: 'Complete', percent: 100 },
      result: {
        media: {
          ...primary,
          kind: 'video',
          role: 'primary',
          durationSeconds: video.video.durationSeconds,
          thumbnail: { ...thumbnail, kind: 'image', role: 'thumbnail' },
          providerTask: video.providerTask
        },
        usage: video.usage
      }
    });
    input.logger.info(`[job:${jobId}] complete videoKey=${primary.key} thumbnailKey=${thumbnail.key} size=${primary.size}`);
  } catch (error) {
    await cleanupUploadedMedia(input.storage, input.logger, jobId, [uploadedThumbnailKey, uploadedVideoKey]);
    throw error;
  }
}

async function cleanupUploadedMedia(storage: ObjectStorageAdapter, logger: Pick<Console, 'warn'>, jobId: string, keys: Array<string | undefined>): Promise<void> {
  for (const key of keys.filter((item): item is string => Boolean(item))) {
    if (storage.deleteObject) {
      try { await storage.deleteObject(key); } catch (cleanupError) { logger.warn(`[job:${jobId}] cleanup-failed key=${key} ${safeErrorMessage(cleanupError)}`); }
    } else {
      logger.warn(`[job:${jobId}] orphaned-upload key=${key}`);
    }
  }
}

function referenceAssetForProvider(reference: ReturnType<typeof validateGenerateRequest>['references'][number]) {
  if (reference.intent === 'source_video') return reference.media;
  if (reference.media.contentType.startsWith('image/')) return reference.media;
  if (reference.thumbnail?.contentType.startsWith('image/')) return { ...reference.thumbnail, role: 'thumbnail' as const };
  return reference.media;
}

function safeFailJob(jobs: JobStore, jobId: string, modality: GenerationModality, error: unknown, logger: Pick<Console, 'info' | 'warn' | 'error'> = console) {
  const existing = jobs.get(jobId);
  if (!existing || existing.cancelled || existing.status === 'cancelled') return;
  logger.error(`[job:${jobId}] failed ${safeErrorMessage(error)}`);
  const label = generationProgressLabel(modality, 'failed');
  jobs.patch(jobId, { status: 'failed', progress: { label }, error: publicFailureError(modality, error, label) });
}

function generationProgressLabel(modality: GenerationModality, phase: 'generating' | 'saving' | 'failed'): string {
  if (phase === 'failed') return `Failed to generate ${modality}`;
  return `${phase === 'generating' ? 'Generating' : 'Saving'} ${modality}`;
}

function respondKnownError(res: express.Response, error: unknown) {
  if (error instanceof RequestValidationError) return res.status(400).json(apiError(error.message, error.details, 'validation_error'));
  if (error instanceof ProviderConfigError) return res.status(500).json(apiError(error.message, error.details, 'provider_config_error'));
  if (error instanceof Error && (error.message === 'Invalid media key' || error.message === 'Unsupported image content type' || error.message === 'Unsupported media content type' || error.message === 'Media content type does not match object key')) return res.status(400).json(apiError('Invalid media request', error.message, 'validation_error'));
  res.status(500).json(apiError('Unexpected server error', safeErrorMessage(error)));
}

function publicFailureError(modality: GenerationModality, error: unknown, fallback: string): string {
  if (modality !== 'video' || !(error instanceof VideoProviderError)) return fallback;
  return sanitizePublicFailureDetail(error.publicMessage) || fallback;
}

function sanitizePublicFailureDetail(value: string): string {
  return value
    .trim()
    .replace(/^Error:\s*/i, '')
    .replace(/^BytePlus\s+video\s+task\s+failed:\s*/i, '')
    .replace(/\b(?:request|trace|task|job|log|event|session)[\s_-]*id\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\b(?:requestId|traceId|taskId|jobId|logId|eventId|sessionId)\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:.-]+$/g, '')
    .trim();
}

function safeErrorMessage(error: unknown): string {
  return describeError(error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/AWS4-HMAC-SHA256 Credential=\S+/gi, 'AWS4-HMAC-SHA256 Credential=[redacted]').slice(0, 800);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = 'cause' in error && error.cause ? `; cause: ${describeError(error.cause)}` : '';
  return `${error.name}: ${error.message}${cause}`;
}
