import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { supportedReferenceIntentsForModel, validateGenerateRequest } from '../generationValidation.js';
import { assertContentTypeMatchesKey, contentTypeForKey, createGenerationObjectKey, validateObjectKey } from '../mediaKeys.js';
import { loadModelCatalog } from '../modelCatalog.js';
import { ProviderConfigError, endpointIdForModel, hasConfiguredEndpointMapping, type ProviderConfig } from '../providerConfig.js';
import { BytePlusImageAdapter } from '../provider/byteplusImageAdapter.js';
import { BytePlusVideoAdapter } from '../provider/byteplusVideoAdapter.js';
import type { ImageGenerationAdapter } from '../provider/imageAdapter.js';
import { VideoProviderError, type VideoGenerationAdapter } from '../provider/videoAdapter.js';
import { BytePlusTosStorageAdapter } from '../storage/byteplusTosStorage.js';
import type { GetObjectInput, ObjectStorageAdapter, PresignGetInput, PutObjectInput } from '../storage/storageAdapter.js';

const catalog = loadModelCatalog();
const imageModel = catalog.models.find((model) => model.id === 'seedream-5-0-lite-260128')!;
const videoModel = catalog.models.find((model) => model.modality === 'video')!;
const testLogger = { info() {}, warn() {}, error() {} };

function testConfig(options: { includeVideo?: boolean; includeGemini?: boolean } = {}): ProviderConfig {
  const configuredModels = catalog.models.filter((model) => model.provider === 'byteplus' && (model.modality === 'image' || (options.includeVideo && model.modality === 'video')));
  return {
    providers: {
      byteplus: { modelArk: { baseUrl: 'https://example.test', apiKeyEnv: 'BYTEPLUS_MODELARK_API_KEY', modelEndpointIds: Object.fromEntries(configuredModels.map((model) => [model.id, `endpoint-${model.id}`])) } },
      ...(options.includeGemini ? { gemini: { baseUrl: 'https://gen.example.test', apiKeyEnv: 'TEST_GEMINI_API_KEY' } } : {})
    },
    storage: { provider: 'byteplus-tos', byteplusTos: { endpoint: 'https://tos.example.test', region: 'test-region', bucket: 'lucidio-test', accessKeyIdEnv: 'BYTEPLUS_TOS_ACCESS_KEY_ID', secretAccessKeyEnv: 'BYTEPLUS_TOS_SECRET_ACCESS_KEY', keyPrefix: 'generations', presignTtlSeconds: 900 } }
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'image',
    modelId: imageModel.id,
    prompt: 'A luminous studio product photo',
    ratio: imageModel.capabilities.aspectRatios?.[0] ?? '1:1',
    res: imageModel.capabilities.resolutions?.[0] ?? '2K',
    length: 5,
    fps: 24,
    camera: false,
    audio: false,
    guidance: 7,
    seed: '',
    params: {},
    references: [],
    projectId: 'p1',
    sceneId: 'sc1',
    ...overrides
  };
}

function videoPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'video',
    modelId: videoModel.id,
    prompt: 'A cinematic video of luminous glass moving through a studio',
    ratio: videoModel.capabilities.aspectRatios?.[0] ?? 'adaptive',
    res: videoModel.capabilities.resolutions?.[0] ?? '720p',
    length: 5,
    fps: videoModel.capabilities.frameRates?.[0] ?? 24,
    camera: false,
    audio: true,
    guidance: 7,
    seed: '',
    params: {},
    references: [],
    projectId: 'p1',
    sceneId: 'sc1',
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('provider config', () => {
  it('detects configured endpoint mappings without requiring every catalog model to be configured', () => {
    const cfg = testConfig();
    const imageModels = catalog.models.filter((model) => model.modality === 'image');
    const otherImageModels = imageModels.filter((model) => model.id !== imageModel.id);
    for (const model of otherImageModels) cfg.providers.byteplus!.modelArk.modelEndpointIds[model.id] = 'BYTEPLUS_ACCOUNT_ENDPOINT_ID_PLACEHOLDER';
    assert.equal(hasConfiguredEndpointMapping(cfg, imageModel.id), true);
    assert.equal(endpointIdForModel(cfg, imageModel.id), `endpoint-${imageModel.id}`);
    assert.equal(hasConfiguredEndpointMapping(cfg, otherImageModels[0]?.id ?? imageModel.id), otherImageModels.length === 0);
  });

  it('fails safely for missing endpoint mapping', () => {
    const cfg = testConfig();
    cfg.providers.byteplus!.modelArk.modelEndpointIds[imageModel.id] = 'BYTEPLUS_ACCOUNT_ENDPOINT_ID_PLACEHOLDER';
    assert.throws(() => endpointIdForModel(cfg, imageModel.id), ProviderConfigError);
  });
});

describe('request validation', () => {
  it('accepts a catalog-backed BytePlus image request', () => {
    const result = validateGenerateRequest(validPayload(), catalog);
    assert.equal(result.model.id, imageModel.id);
    assert.equal(result.providerParams.response_format, 'b64_json');
    assert.equal(result.providerParams.sequential_image_generation, 'disabled');
    assert.match(String(result.providerParams.size), /^\d+x\d+$/);
  });

  it('omits sequential_image_generation for BytePlus image models that do not declare it (e.g. Seedream 5.0 Pro)', () => {
    const seedream5Pro = catalog.models.find((model) => model.id === 'dola-seedream-5-0-pro-260628');
    assert(seedream5Pro, 'expected current Seedream 5.0 Pro to be present in the catalog');
    assert.equal(seedream5Pro!.parameters.some((param) => param.name === 'sequential_image_generation'), false);
    const result = validateGenerateRequest(validPayload({ modelId: seedream5Pro!.id, ratio: seedream5Pro!.capabilities.aspectRatios?.[0], res: seedream5Pro!.capabilities.resolutions?.[0] }), catalog);
    assert.equal('sequential_image_generation' in result.providerParams, false);
  });

  it('uses BytePlus Pro/Flash sizes and limits Flash to standard prompt optimization', () => {
    for (const id of ['dola-seedream-5-0-pro-260628', 'dola-seedream-5-0-flash-260915']) {
      const model = catalog.models.find((entry) => entry.id === id);
      assert(model, `expected ${id} to be present in the catalog`);
      assert.deepEqual(model.capabilities.resolutions, ['1K', '1.5K', '2K']);
      assert.equal(model.capabilities.maxReferenceImages, 10);
      const result = validateGenerateRequest(validPayload({ modelId: id, ratio: '16:9', res: '1.5K' }), catalog);
      assert.equal(result.providerParams.size, '2048x1152');
      assert.equal('sequential_image_generation' in result.providerParams, false);
    }
    const flash = catalog.models.find((entry) => entry.id === 'dola-seedream-5-0-flash-260915');
    assert.equal(flash?.parameters.some((param) => param.name === 'optimize_prompt_options.mode'), false);
    assert.throws(() => validateGenerateRequest(validPayload({ modelId: flash!.id, ratio: '1:1', res: '1K', params: { 'optimize_prompt_options.mode': 'fast' } }), catalog), /Unsupported parameter/);
  });

  it('maps Seedream 5 Lite 2K aspect-ratio sizes to BytePlus recommended dimensions', () => {
    const seedream5Lite = catalog.models.find((model) => model.id === 'seedream-5-0-lite-260128') ?? imageModel;
    const result = validateGenerateRequest(validPayload({ modelId: seedream5Lite.id, ratio: '4:3', res: '2K' }), catalog);
    const [width, height] = String(result.providerParams.size).split('x').map((part) => Number(part));
    assert.equal(result.providerParams.size, '2304x1728');
    assert.equal(Number.isFinite(width), true);
    assert.equal(Number.isFinite(height), true);
    assert(width * height >= 3_686_400);
    assert(Math.abs(width / height - 4 / 3) < 0.01);
  });

  it('rejects unsupported image params and malformed image references before provider calls', () => {
    assert.throws(() => validateGenerateRequest(validPayload({ params: { unsupported: true } }), catalog), /Unsupported parameter/);
    assert.throws(() => validateGenerateRequest(validPayload({ params: { response_format: 'url' } }), catalog), /Unsupported parameter/);
    assert.throws(() => validateGenerateRequest(validPayload({ params: { sequential_image_generation: 'auto' } }), catalog), /Sequential image generation/);
    assert.throws(() => validateGenerateRequest(validPayload({ params: { 'sequential_image_generation_options.max_images': 2 } }), catalog), /Multiple output images/);
    assert.throws(() => validateGenerateRequest(validPayload({ references: [{ id: 'g1' }] }), catalog), /Invalid request/);
    assert.throws(() => validateGenerateRequest(validPayload({ references: Array.from({ length: 99 }, (_, index) => ({ id: `g${index}`, media: { provider: 'byteplus-tos', key: 'generations/job_1/0123456789abcdef01234567-gen_1.png', contentType: 'image/png', size: 1, createdAt: new Date().toISOString() } })) }), catalog), /Too many references/);
  });

  it('accepts catalog-backed BytePlus video requests and forces last-frame thumbnails', () => {
    const result = validateGenerateRequest(videoPayload({ references: [], params: { resolution: '480p', ratio: '1:1', duration: 4, generate_audio: false } }), catalog);
    assert.equal(result.model.id, videoModel.id);
    assert.equal(result.providerParams.return_last_frame, true);
    assert.equal(result.providerParams.resolution, videoModel.capabilities.resolutions?.[0]);
    assert.equal(result.providerParams.ratio, videoModel.capabilities.aspectRatios?.[0]);
    assert.equal(result.providerParams.duration, 5);
    if (videoModel.parameters.some((param) => param.name === 'generate_audio')) assert.equal(result.providerParams.generate_audio, true);
    assert.deepEqual(supportedReferenceIntentsForModel(videoModel), ['image_reference', 'first_frame', 'last_frame', 'source_video']);
  });

  it('maps camera motion to inverse camera_fixed and enforces frames step rules', () => {
    const cameraModel = catalog.models.find((model) => model.id === 'seedance-1-5-pro-251215') ?? videoModel;
    const framesModel = catalog.models.find((model) => model.id === 'seedance-1-0-pro-250528') ?? videoModel;
    const cameraResult = validateGenerateRequest(videoPayload({
      modelId: cameraModel.id,
      ratio: cameraModel.capabilities.aspectRatios?.[0] ?? 'adaptive',
      res: cameraModel.capabilities.resolutions?.[0] ?? '720p',
      length: cameraModel.capabilities.durationSeconds?.minimum ?? 5,
      camera: true,
      params: { camera_fixed: true }
    }), catalog);
    if (cameraModel.parameters.some((param) => param.name === 'camera_fixed')) assert.equal(cameraResult.providerParams.camera_fixed, false);
    assert.throws(() => validateGenerateRequest(videoPayload({
      modelId: framesModel.id,
      ratio: framesModel.capabilities.aspectRatios?.[0] ?? '16:9',
      res: framesModel.capabilities.resolutions?.[0] ?? '720p',
      length: framesModel.capabilities.durationSeconds?.minimum ?? 5,
      params: { frames: 30 }
    }), catalog), /Invalid parameter value/);
  });

  it('validates reference selection metadata instead of accepting arbitrary nested fields', () => {
    const result = validateGenerateRequest(videoPayload({ referenceSelections: [{ generationId: 'g1', intent: 'first_frame' }] }), catalog);
    assert.deepEqual(result.request.referenceSelections, [{ generationId: 'g1', intent: 'first_frame' }]);
    assert.throws(() => validateGenerateRequest(videoPayload({ referenceSelections: [{ generationId: 'g1', intent: 'first_frame', url: 'https://example.test/raw.png' }] }), catalog), /Invalid reference selections/);
    assert.throws(() => validateGenerateRequest(videoPayload({ referenceSelections: [{ generationId: 'g1', intent: 'unsupported' }] }), catalog), /Invalid reference intent/);
  });

  it('validates video reference intents and rejects unsupported/raw descriptors', () => {
    const imageKey = createGenerationObjectKey('generations', 'job_123', 'image_ref', 'image/png');
    const videoKey = createGenerationObjectKey('generations', 'job_123', 'video_ref', 'video/mp4');
    const imageMedia = { provider: 'byteplus-tos', key: imageKey, contentType: 'image/png', size: 1, createdAt: new Date().toISOString(), kind: 'image', role: 'primary' };
    const videoMedia = { provider: 'byteplus-tos', key: videoKey, contentType: 'video/mp4', size: 2, createdAt: new Date().toISOString(), kind: 'video', role: 'primary' };
    const thumbnail = { provider: 'byteplus-tos', key: createGenerationObjectKey('generations', 'job_123', 'thumb_ref', 'image/jpeg'), contentType: 'image/jpeg', size: 1, createdAt: new Date().toISOString(), kind: 'image', role: 'thumbnail' };

    assert.equal(validateGenerateRequest(videoPayload({ references: [{ id: 'g1', intent: 'first_frame', media: imageMedia }] }), catalog).references[0]?.intent, 'first_frame');
    assert.equal(validateGenerateRequest(videoPayload({ references: [{ id: 'g2', intent: 'source_video', media: videoMedia }] }), catalog).references[0]?.intent, 'source_video');
    assert.equal(validateGenerateRequest(videoPayload({ references: [{ id: 'g2b', intent: 'last_frame', media: videoMedia, thumbnail }] }), catalog).references[0]?.intent, 'last_frame');

    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g3', media: imageMedia }] }), catalog), /Invalid reference intent/);
    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g4', intent: 'source_video', media: imageMedia }] }), catalog), /Invalid reference media/);
    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g4b', intent: 'first_frame', media: videoMedia, thumbnail }] }), catalog), /Invalid reference media/);
    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g4c', intent: 'first_frame', media: thumbnail }] }), catalog), /Invalid reference media/);
    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g5', intent: 'audio_reference', media: imageMedia }] }), catalog), /Unsupported reference intent/);
    assert.throws(() => validateGenerateRequest(videoPayload({ references: [{ id: 'g6', intent: 'image_reference', media: imageMedia, url: 'https://example.test/raw.png' }] }), catalog), /Invalid references/);
    assert.throws(() => validateGenerateRequest(videoPayload({ params: { return_last_frame: false } }), catalog), /Last-frame thumbnail/);
    assert.throws(() => validateGenerateRequest(videoPayload({ params: { content: [] } }), catalog), /Unsupported parameter/);
  });
});

describe('media key validation', () => {
  it('requires generated-media prefix, random token, safe ids, and supported image/video extensions', () => {
    const key = createGenerationObjectKey('generations', 'job_123', 'gen_456', 'image/png');
    assert.match(key, /^generations\/job_123\/[a-f0-9]{24}-gen_456\.png$/);
    assert.doesNotThrow(() => validateObjectKey(key, 'generations'));
    assert.equal(contentTypeForKey(key, 'generations'), 'image/png');

    const videoKey = createGenerationObjectKey('generations', 'job_123', 'gen_456', 'video/mp4');
    assert.match(videoKey, /^generations\/job_123\/[a-f0-9]{24}-gen_456\.mp4$/);
    assert.equal(contentTypeForKey(videoKey, 'generations'), 'video/mp4');
    assert.doesNotThrow(() => assertContentTypeMatchesKey(videoKey, 'video/mp4', 'generations'));
    assert.throws(() => assertContentTypeMatchesKey(videoKey, 'image/png', 'generations'), /does not match/);

    assert.throws(() => validateObjectKey('https://example.test/generations/job/a.png', 'generations'), /Invalid media key/);
    assert.throws(() => validateObjectKey('generations/job_123/notrandom-gen_456.png', 'generations'), /Invalid media key/);
    assert.throws(() => createGenerationObjectKey('generations', 'job_123', 'gen_456', 'text/plain'), /Unsupported media content type/);
  });
});

describe('adapter error context', () => {
  it('wraps ModelArk network failures with actionable context', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const failingFetch: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    const adapter = new BytePlusImageAdapter({ baseUrl: 'https://ark.example.test/api/v3', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, failingFetch);
    await assert.rejects(
      adapter.generate({ model: imageModel, endpointId: 'ep-test', prompt: 'hello', params: {}, references: [] }),
      /BytePlus ModelArk request failed before HTTP response: fetch failed/
    );
  });

  it('does not force sequential_image_generation into the request body for models that do not declare it', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const seedream5Pro = catalog.models.find((model) => model.id === 'dola-seedream-5-0-pro-260628');
    assert(seedream5Pro, 'expected current Seedream 5.0 Pro to be present in the catalog');
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      return jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }] });
    };
    const adapter = new BytePlusImageAdapter({ baseUrl: 'https://ark.example.test/api/v3', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl);
    await adapter.generate({ model: seedream5Pro!, endpointId: 'ep-test', prompt: 'hello', params: { response_format: 'b64_json', stream: false, size: '2048x2048' }, references: [] });
    assert.equal('sequential_image_generation' in sentBody, false);
  });

  it('stores PNG base64 responses from Seedream 5.0 Flash with the correct content type', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const flash = catalog.models.find((model) => model.id === 'dola-seedream-5-0-flash-260915');
    assert(flash);
    const fetchImpl: typeof fetch = async () => jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }] });
    const adapter = new BytePlusImageAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl);
    const result = await adapter.generate({ model: flash, endpointId: 'ep-flash', prompt: 'hello', params: { output_format: 'png' }, references: [] });
    assert.equal(result.contentType, 'image/png');
  });

  it('wraps TOS upload network failures with actionable context', async () => {
    process.env.TEST_TOS_ACCESS_KEY_ID = 'test-ak';
    process.env.TEST_TOS_SECRET_ACCESS_KEY = 'test-sk';
    let requestedUrl = '';
    const failingFetch: typeof fetch = async (input) => {
      requestedUrl = String(input);
      throw new TypeError('fetch failed');
    };
    const storage = new BytePlusTosStorageAdapter({ endpoint: 'https://tos.example.test', region: 'test-region', bucket: 'lucidio-test', accessKeyIdEnv: 'TEST_TOS_ACCESS_KEY_ID', secretAccessKeyEnv: 'TEST_TOS_SECRET_ACCESS_KEY', keyPrefix: 'generations', presignTtlSeconds: 900 }, failingFetch);
    await assert.rejects(
      storage.putObject({ key: createGenerationObjectKey('generations', 'job_123', 'gen_456', 'image/png'), body: Buffer.from('image'), contentType: 'image/png' }),
      /BytePlus TOS upload request failed before HTTP response: fetch failed/
    );
    assert.equal(new URL(requestedUrl).host, 'lucidio-test.tos.example.test');
  });


  it('creates, polls, and downloads BytePlus video tasks with references and last-frame return', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url.endsWith('/api/v3/contents/generations/tasks') && method === 'POST') return jsonResponse({ id: 'task-1', status: 'running' });
      if (url.endsWith('/api/v3/contents/generations/tasks/task-1') && method === 'GET') return jsonResponse({ id: 'task-1', status: 'succeeded', output: { video_url: 'https://provider.example/video.mp4', last_frame_url: 'https://provider.example/last.jpg', duration: 5 } });
      if (url === 'https://provider.example/video.mp4') return new Response(Buffer.from('mp4'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      if (url === 'https://provider.example/last.jpg') return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    const result = await adapter.generate({
      model: videoModel,
      endpointId: 'endpoint-video',
      prompt: 'motion',
      params: { resolution: '720p', return_last_frame: true },
      references: [
        { generationId: 'g1', intent: 'first_frame', url: 'https://signed.example/image.png', contentType: 'image/png', kind: 'image' },
        { generationId: 'g2', intent: 'source_video', url: 'https://signed.example/video.mp4', contentType: 'video/mp4', kind: 'video' }
      ]
    });
    assert.equal(result.video.contentType, 'video/mp4');
    assert.equal(result.thumbnail.contentType, 'image/jpeg');
    assert.equal(result.providerTask.taskId, 'task-1');
    const createBody = requests.find((request) => request.method === 'POST')?.body;
    assert.equal(createBody?.model, 'endpoint-video');
    assert.equal(createBody?.return_last_frame, true);
    assert.deepEqual(createBody?.content, [
      { type: 'text', text: 'motion' },
      { type: 'image_url', image_url: { url: 'https://signed.example/image.png' }, role: 'first_frame' },
      { type: 'video_url', video_url: { url: 'https://signed.example/video.mp4' }, role: 'reference_video' }
    ]);
  });

  it('handles data-wrapped BytePlus video task snapshots and adapter cancellation', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.endsWith('/api/v3/contents/generations/tasks') && method === 'POST') return jsonResponse({ data: { task_id: 'task-data', status: 'running' } });
      if (url.endsWith('/api/v3/contents/generations/tasks/task-data') && method === 'GET') return jsonResponse({ data: { task_id: 'task-data', status: 'succeeded', output: { video_url: 'https://provider.example/data-video.mp4', last_frame_url: 'https://provider.example/data-last.png', duration_seconds: 6 } } });
      if (url.endsWith('/api/v3/contents/generations/tasks/task-data') && method === 'DELETE') return new Response(null, { status: 204 });
      if (url === 'https://provider.example/data-video.mp4') return new Response(Buffer.from('mp4'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      if (url === 'https://provider.example/data-last.png') return new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    const result = await adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] });
    assert.equal(result.providerTask.taskId, 'task-data');
    assert.equal(result.video.durationSeconds, 6);
    assert.equal(result.thumbnail.contentType, 'image/png');
    await adapter.cancel?.('task-data');
    assert(requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/task-data')));
  });

  it('parses documented BytePlus video task content URLs', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-content', status: 'running' });
      if (url.endsWith('/api/v3/contents/generations/tasks/task-content') && init?.method === 'GET') return jsonResponse({ id: 'task-content', status: 'succeeded', content: { video_url: 'https://provider.example/content-video.mp4', last_frame_url: 'https://provider.example/content-last.webp', duration: 4 } });
      if (url === 'https://provider.example/content-video.mp4') return new Response(Buffer.from('mp4'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      if (url === 'https://provider.example/content-last.webp') return new Response(Buffer.from('webp'), { status: 200, headers: { 'content-type': 'image/webp', 'content-length': '4' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });

    const result = await adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] });

    assert.equal(result.providerTask.taskId, 'task-content');
    assert.equal(result.video.durationSeconds, 4);
    assert.equal(result.thumbnail.contentType, 'image/webp');
  });

  it('fails video adapter downloads safely on output size limits and redacts provider URLs', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-2', status: 'succeeded', output: { video_url: 'https://secret.example/video.mp4?token=abc', last_frame_url: 'https://secret.example/last.jpg?token=abc' } });
      if (url.startsWith('https://secret.example/video.mp4')) return new Response(Buffer.alloc(5), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5' } });
      if (url.startsWith('https://secret.example/last.jpg')) return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { maxVideoBytes: 1, pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /size limit/
    );
  });

  it('rejects oversized provider media while streaming when content-length is absent', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    let videoStreamCancelled = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-stream-limit', status: 'succeeded', output: { video_url: 'https://provider.example/stream.mp4', last_frame_url: 'https://provider.example/last.jpg' } });
      if (url === 'https://provider.example/stream.mp4') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.alloc(2));
            controller.enqueue(Buffer.alloc(2));
          },
          cancel() {
            videoStreamCancelled = true;
          }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (url === 'https://provider.example/last.jpg') return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { maxVideoBytes: 3, pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /size limit/
    );
    assert.equal(videoStreamCancelled, true);
  });

  it('rejects unsupported BytePlus thumbnail image content types instead of relabeling bytes', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-gif', status: 'succeeded', output: { video_url: 'https://provider.example/video.mp4', last_frame_url: 'https://provider.example/last.gif' } });
      if (url === 'https://provider.example/video.mp4') return new Response(Buffer.from('mp4'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      if (url === 'https://provider.example/last.gif') return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.from('gif'));
          controller.close();
        }
      }), { status: 200, headers: { 'content-type': 'image/gif', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /expected image\/jpeg, image\/png, or image\/webp/
    );
  });

  it('rejects provider media downloads without explicit content-type headers', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-missing-type', status: 'succeeded', output: { video_url: 'https://provider.example/video.mp4', last_frame_url: 'https://provider.example/last.jpg' } });
      if (url === 'https://provider.example/video.mp4') return new Response(Buffer.from('mp4'), { status: 200, headers: { 'content-length': '3' } });
      if (url === 'https://provider.example/last.jpg') return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 1000 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /content-type header/
    );
  });

  it('aborts timed-out provider media downloads', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    let videoDownloadAborted = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-timeout', status: 'succeeded', output: { video_url: 'https://provider.example/slow.mp4', last_frame_url: 'https://provider.example/last.jpg' } });
      if (url === 'https://provider.example/slow.mp4') return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          videoDownloadAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      if (url === 'https://provider.example/last.jpg') return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 5 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /timed out/
    );
    assert.equal(videoDownloadAborted, true);
  });

  it('aborts timed-out provider media response bodies', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    let videoBodyCancelled = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-body-timeout', status: 'succeeded', output: { video_url: 'https://provider.example/body-stall.mp4', last_frame_url: 'https://provider.example/last.jpg' } });
      if (url === 'https://provider.example/body-stall.mp4') return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('m'));
        },
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          videoBodyCancelled = true;
        }
      }), { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (url === 'https://provider.example/last.jpg') return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 100, fetchTimeoutMs: 5 });
    await assert.rejects(
      adapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }),
      /timed out/
    );
    assert.equal(videoBodyCancelled, true);
  });

  it('aborts timed-out video task create and retrieve requests', async () => {
    process.env.TEST_MODELARK_API_KEY = 'test-key';
    let createAborted = false;
    const hangingCreate: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        createAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
    const createAdapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, hangingCreate, { fetchTimeoutMs: 5, pollIntervalMs: 1, pollTimeoutMs: 100 });
    await assert.rejects(createAdapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }), /create timed out/);
    assert.equal(createAborted, true);

    let retrieveAborted = false;
    const hangingRetrieve: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v3/contents/generations/tasks') && init?.method === 'POST') return jsonResponse({ id: 'task-retrieve-timeout', status: 'running' });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          retrieveAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    };
    const retrieveAdapter = new BytePlusVideoAdapter({ baseUrl: 'https://ark.example.test', apiKeyEnv: 'TEST_MODELARK_API_KEY', modelEndpointIds: {} }, hangingRetrieve, { fetchTimeoutMs: 5, pollIntervalMs: 1, pollTimeoutMs: 100 });
    await assert.rejects(retrieveAdapter.generate({ model: videoModel, endpointId: 'endpoint-video', prompt: 'motion', params: {}, references: [] }), /retrieve timed out/);
    assert.equal(retrieveAborted, true);
  });


  it('emits TOS presigned URLs with RFC3986 query encoding', async () => {
    process.env.TEST_TOS_ACCESS_KEY_ID = 'test-ak';
    process.env.TEST_TOS_SECRET_ACCESS_KEY = 'test-sk';
    const storage = new BytePlusTosStorageAdapter({ endpoint: 'https://tos.example.test', region: 'test-region', bucket: 'lucidio-test', accessKeyIdEnv: 'TEST_TOS_ACCESS_KEY_ID', secretAccessKeyEnv: 'TEST_TOS_SECRET_ACCESS_KEY', keyPrefix: 'generations', presignTtlSeconds: 900 });
    const signed = await storage.presignGet({ key: createGenerationObjectKey('generations', 'job_123', 'gen_456', 'image/png'), purpose: 'preview', filename: 'lucidio test.png', contentType: 'image/png' });
    assert.match(signed.url, /^https:\/\/lucidio-test\.tos\.example\.test\//);
    assert.match(signed.url, /\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=/);
    assert.match(signed.url, /response-content-disposition=inline%3B%20filename%3D%22lucidio%20test\.png%22/);
    assert.doesNotMatch(signed.url, /\+/);
  });

  it('deletes generated TOS objects with signed DELETE requests', async () => {
    process.env.TEST_TOS_ACCESS_KEY_ID = 'test-ak';
    process.env.TEST_TOS_SECRET_ACCESS_KEY = 'test-sk';
    let requested: { url: string; method?: string; authorization?: string } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requested = { url: String(input), method: init?.method, authorization: headers.get('authorization') ?? undefined };
      return new Response(null, { status: 204 });
    };
    const storage = new BytePlusTosStorageAdapter({ endpoint: 'https://tos.example.test', region: 'test-region', bucket: 'lucidio-test', accessKeyIdEnv: 'TEST_TOS_ACCESS_KEY_ID', secretAccessKeyEnv: 'TEST_TOS_SECRET_ACCESS_KEY', keyPrefix: 'generations', presignTtlSeconds: 900 }, fetchImpl);
    const key = createGenerationObjectKey('generations', 'job_123', 'gen_456', 'video/mp4');
    await storage.deleteObject(key);
    assert(requested);
    const deleteRequest = requested as { url: string; method?: string; authorization?: string };
    assert.equal(deleteRequest.method, 'DELETE');
    assert.equal(new URL(deleteRequest.url).host, 'lucidio-test.tos.example.test');
    assert.match(deleteRequest.authorization ?? '', /^AWS4-HMAC-SHA256 /);
  });
});

describe('generation routes', () => {
  let server: Server;
  let baseUrl: string;
  const calls: string[] = [];
  let providerFails = false;
  let storageFails = false;
  let lastProviderSize = '';
  const imageAdapter: ImageGenerationAdapter = {
    async generate(input) {
      calls.push(`generate:${input.endpointId}`);
      lastProviderSize = String(input.params.size ?? '');
      if (providerFails) throw new Error('mock provider failed');
      return { bytes: Buffer.from('fake image'), contentType: 'image/png' };
    }
  };
  const storageAdapter: ObjectStorageAdapter = {
    async putObject(input: PutObjectInput) {
      calls.push(`put:${input.key}`);
      if (storageFails) throw new Error('mock storage failed');
      return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString(), bucket: 'lucidio-test', region: 'test-region' };
    },
    async presignGet(input: PresignGetInput) {
      calls.push(`presign:${input.purpose}:${input.key}`);
      return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
    },
    async getObject(input: GetObjectInput) {
      calls.push(`get:${input.key}`);
      return { body: Buffer.from('fake image'), contentType: input.contentType ?? 'image/png', size: 10 };
    }
  };

  before(async () => {
    const app = createApp({ catalog, config: testConfig(), imageAdapter, storageAdapter, logger: testLogger, production: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('returns only configured image models when no video endpoint IDs are configured from /api/models', async () => {
    const cfg = testConfig();
    const imageModels = catalog.models.filter((model) => model.modality === 'image');
    for (const model of imageModels.filter((model) => model.id !== imageModel.id)) cfg.providers.byteplus!.modelArk.modelEndpointIds[model.id] = 'BYTEPLUS_ACCOUNT_ENDPOINT_ID_PLACEHOLDER';
    const app = createApp({ catalog, config: cfg, imageAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/models`);
    assert.equal(response.status, 200);
    const body = await response.json() as { count: number; models: Array<{ id: string; modality: string }> };
    assert.deepEqual(body.models.map((model) => model.id), [imageModel.id]);
    assert.equal(body.count, 1);
    assert(body.models.every((model) => model.modality === 'image'));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('returns configured image and video models from /api/models', async () => {
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/models`);
    assert.equal(response.status, 200);
    const body = await response.json() as { count: number; models: Array<{ id: string; provider: string; modality: string; endpoint: string; capabilities: { referenceIntents?: string[] } }> };
    assert(body.models.some((model) => model.id === imageModel.id && model.modality === 'image'));
    assert(body.models.some((model) => model.id === videoModel.id && model.modality === 'video' && model.endpoint === '/api/v3/contents/generations/tasks'));
    assert.deepEqual(body.models.find((model) => model.id === videoModel.id)?.capabilities.referenceIntents, supportedReferenceIntentsForModel(videoModel));
    // testConfig configures only BytePlus endpoints (no gemini block), so Gemini models are excluded.
    assert.equal(body.count, catalog.models.filter((model) => model.provider === 'byteplus').length);
    assert(body.models.every((model) => model.provider === 'byteplus'));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('exposes configured Gemini models (Nano Banana, Veo, Omni Flash) from /api/models', async () => {
    const app = createApp({ catalog, config: testConfig({ includeVideo: true, includeGemini: true }), imageAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/models`);
    const body = await response.json() as { count: number; models: Array<{ id: string; provider: string; modality: string; capabilities: { referenceIntents?: string[] } }> };
    const geminiIds = body.models.filter((model) => model.provider === 'gemini').map((model) => model.id);
    assert(geminiIds.includes('gemini-3-pro-image'));
    assert(geminiIds.includes('veo-3.1-generate-preview'));
    assert(geminiIds.includes('gemini-omni-flash-preview'));
    assert.equal(body.count, catalog.models.length);
    // Veo (image-to-video-first-and-last-frames) advertises derived reference intents.
    const veoCatalog = catalog.models.find((model) => model.id === 'veo-3.1-generate-preview')!;
    const veo = body.models.find((model) => model.id === 'veo-3.1-generate-preview');
    assert.deepEqual(veo?.capabilities.referenceIntents, supportedReferenceIntentsForModel(veoCatalog));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('runs a mocked image job through complete object metadata', async () => {
    const accepted = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    assert.equal(accepted.status, 202);
    const body = await accepted.json() as { jobId: string; status: string };
    assert.equal(body.status, 'queued');
    type StatusBody = { status: string; result?: { media: { key: string; contentType: string; kind?: string; role?: string } } };
    let status: StatusBody | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`${baseUrl}/api/generate/${body.jobId}/status`)).json() as StatusBody;
      if (status?.status === 'complete') break;
    }
    assert.equal(status?.status, 'complete');
    assert.equal(status?.result?.media.contentType, 'image/png');
    assert.equal(status?.result?.media.kind, 'image');
    assert.equal(status?.result?.media.role, 'primary');
    assert.match(status?.result?.media.key ?? '', /^generations\//);
    assert(calls.some((call) => call.startsWith('generate:endpoint-')));
    assert(calls.some((call) => call.startsWith('put:generations/')));
    assert.match(lastProviderSize, /^\d+x\d+$/);
  });

  it('streams generation status over server-sent events', async () => {
    const accepted = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    assert.equal(accepted.status, 202);
    const body = await accepted.json() as { jobId: string; status: string };
    assert.equal(body.status, 'queued');

    const stream = await fetch(`${baseUrl}/api/generate/${body.jobId}/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type')?.startsWith('text/event-stream'), true);
    assert(stream.body);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 10; i += 1) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: !done });
      if (done || text.includes('"status":"complete"')) break;
    }
    await reader.cancel().catch(() => {});

    assert.match(text, /retry: 5000/);
    assert.match(text, /event: status/);
    assert(text.includes(`"jobId":"${body.jobId}"`));
    assert.match(text, /"status":"complete"/);
  });

  it('fails jobs safely when the provider or storage adapter fails', async () => {
    providerFails = true;
    const accepted = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    const body = await accepted.json() as { jobId: string };
    type FailureStatus = { status: string; error?: string; progress?: { label?: string } };
    let status: FailureStatus | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`${baseUrl}/api/generate/${body.jobId}/status`)).json() as FailureStatus;
      if (status.status === 'failed') break;
    }
    assert.equal(status?.status, 'failed');
    assert.equal(status?.error, 'Failed to generate image');
    assert.equal(status?.progress?.label, 'Failed to generate image');
    providerFails = false;
    storageFails = true;
    const acceptedStorage = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    const storageBody = await acceptedStorage.json() as { jobId: string };
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`${baseUrl}/api/generate/${storageBody.jobId}/status`)).json() as FailureStatus;
      if (status.status === 'failed') break;
    }
    assert.equal(status?.status, 'failed');
    assert.equal(status?.error, 'Failed to generate image');
    assert.equal(status?.progress?.label, 'Failed to generate image');
    storageFails = false;
  });

  it('logs provider failure details without exposing them in job status', async () => {
    const errors: string[] = [];
    const failingImageAdapter: ImageGenerationAdapter = {
      async generate() {
        throw new Error('mock provider failed with private upstream detail');
      }
    };
    const logger = {
      info() {},
      warn() {},
      error(...data: unknown[]) {
        errors.push(data.map(String).join(' '));
      }
    };
    const app = createApp({ catalog, config: testConfig(), imageAdapter: failingImageAdapter, storageAdapter, logger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    const accepted = await response.json() as { jobId: string };
    type FailureStatus = { status: string; error?: string; progress?: { label?: string } };
    let status: FailureStatus | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`http://127.0.0.1:${address.port}/api/generate/${accepted.jobId}/status`)).json() as FailureStatus;
      if (status.status === 'failed') break;
    }
    assert.equal(status?.status, 'failed');
    assert.equal(status?.error, 'Failed to generate image');
    assert.equal(status?.progress?.label, 'Failed to generate image');
    assert.doesNotMatch(JSON.stringify(status), /private upstream detail/);
    assert(errors.some((entry) => entry.includes('mock provider failed with private upstream detail')));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('reports video task polling as generating after the provider task is created', async () => {
    let releaseProvider: (() => void) | null = null;
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        input.onTaskCreated?.('task-progress');
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
        return {
          video: { bytes: Buffer.from('fake mp4'), contentType: 'video/mp4', durationSeconds: 5 },
          thumbnail: { bytes: Buffer.from('fake jpg'), contentType: 'image/jpeg' },
          providerTask: { provider: 'byteplus', taskId: 'task-progress', modelId: input.model.id }
        };
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${root}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    type StatusBody = { status: string; progress?: { label?: string } };
    let status: StatusBody | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await (await fetch(`${root}/api/generate/${accepted.jobId}/status`)).json() as StatusBody;
      if (status.progress?.label === 'Generating video') break;
    }
    assert.equal(status?.status, 'running');
    assert.equal(status?.progress?.label, 'Generating video');
    assert(releaseProvider);
    const finishProvider = releaseProvider as () => void;
    finishProvider();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await (await fetch(`${root}/api/generate/${accepted.jobId}/status`)).json() as StatusBody;
      if (status.status === 'complete') break;
    }
    assert.equal(status?.status, 'complete');
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('returns sanitized vendor details for failed video jobs', async () => {
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate() {
        throw new VideoProviderError('Prompt violates the content policy. Request ID: req_123 task_id=task_456');
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    type FailureStatus = { status: string; error?: string; progress?: { label?: string } };
    let status: FailureStatus | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`http://127.0.0.1:${address.port}/api/generate/${accepted.jobId}/status`)).json() as FailureStatus;
      if (status.status === 'failed') break;
    }
    assert.equal(status?.status, 'failed');
    assert.equal(status?.progress?.label, 'Failed to generate video');
    assert.equal(status?.error, 'Prompt violates the content policy');
    assert.doesNotMatch(JSON.stringify(status), /req_123|task_456|Request ID|task_id/);
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('runs a mocked video job through MP4 and thumbnail object metadata', async () => {
    const routeCalls: string[] = [];
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        routeCalls.push(`video:${input.endpointId}:${input.references.length}`);
        return {
          video: { bytes: Buffer.from('fake mp4'), contentType: 'video/mp4', durationSeconds: 5 },
          thumbnail: { bytes: Buffer.from('fake jpg'), contentType: 'image/jpeg' },
          providerTask: { provider: 'byteplus', taskId: 'task-route', modelId: input.model.id, completedAt: new Date().toISOString() }
        };
      }
    };
    const routeStorage: ObjectStorageAdapter = {
      async putObject(input: PutObjectInput) {
        routeCalls.push(`put:${input.contentType}:${input.key}`);
        return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString(), bucket: 'lucidio-test', region: 'test-region' };
      },
      async presignGet(input: PresignGetInput) {
        routeCalls.push(`presign:${input.assetRole ?? 'primary'}:${input.key}`);
        return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
      },
      async getObject(input: GetObjectInput) {
        return { body: Buffer.from('fake image'), contentType: input.contentType ?? 'image/jpeg', size: 10 };
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter: routeStorage, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    type VideoStatus = { status: string; result?: { media: { contentType: string; kind?: string; thumbnail?: { contentType: string; kind?: string }; providerTask?: { taskId: string } } } };
    let status: VideoStatus | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`http://127.0.0.1:${address.port}/api/generate/${accepted.jobId}/status`)).json() as VideoStatus;
      if (status.status === 'complete') break;
    }
    assert.equal(status?.status, 'complete');
    assert.equal(status?.result?.media.contentType, 'video/mp4');
    assert.equal(status?.result?.media.kind, 'video');
    assert.equal(status?.result?.media.thumbnail?.contentType, 'image/jpeg');
    assert.equal(status?.result?.media.providerTask?.taskId, 'task-route');
    assert(routeCalls.some((call) => call.startsWith('video:endpoint-')));
    assert(routeCalls.some((call) => call.startsWith('put:video/mp4:')));
    assert(routeCalls.some((call) => call.startsWith('put:image/jpeg:')));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('presigns source video and last-frame thumbnail references for video jobs', async () => {
    const routeCalls: string[] = [];
    const videoKey = createGenerationObjectKey('generations', 'job_123', 'video_ref', 'video/mp4');
    const thumbnailKey = createGenerationObjectKey('generations', 'job_123', 'last_frame_ref', 'image/jpeg');
    const videoMedia = { provider: 'byteplus-tos', key: videoKey, contentType: 'video/mp4', size: 20, createdAt: new Date().toISOString(), kind: 'video', role: 'primary' };
    const thumbnail = { provider: 'byteplus-tos', key: thumbnailKey, contentType: 'image/jpeg', size: 10, createdAt: new Date().toISOString(), kind: 'image', role: 'thumbnail' };
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        routeCalls.push(`video-refs:${input.references.map((reference) => `${reference.intent}:${reference.url}`).join('|')}`);
        return {
          video: { bytes: Buffer.from('fake mp4'), contentType: 'video/mp4', durationSeconds: 5 },
          thumbnail: { bytes: Buffer.from('fake jpg'), contentType: 'image/jpeg' },
          providerTask: { provider: 'byteplus', taskId: 'task-reference', modelId: input.model.id, completedAt: new Date().toISOString() }
        };
      }
    };
    const routeStorage: ObjectStorageAdapter = {
      async putObject(input: PutObjectInput) {
        routeCalls.push(`put:${input.contentType}:${input.key}`);
        return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString(), bucket: 'lucidio-test', region: 'test-region' };
      },
      async presignGet(input: PresignGetInput) {
        routeCalls.push(`presign:${input.assetRole ?? 'primary'}:${input.contentType}:${input.key}`);
        return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
      },
      async getObject(input: GetObjectInput) {
        return { body: Buffer.from('fake image'), contentType: input.contentType ?? 'image/jpeg', size: 10 };
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter: routeStorage, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(videoPayload({
        references: [
          { id: 'video-source', intent: 'source_video', media: videoMedia, thumbnail },
          { id: 'video-last-frame', intent: 'last_frame', media: videoMedia, thumbnail }
        ],
        referenceSelections: [
          { generationId: 'video-source', intent: 'source_video' },
          { generationId: 'video-last-frame', intent: 'last_frame' }
        ]
      }))
    });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    for (let i = 0; i < 20 && !routeCalls.some((call) => call.startsWith('video-refs:')); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert(routeCalls.includes(`presign:primary:video/mp4:${videoKey}`));
    assert(routeCalls.includes(`presign:thumbnail:image/jpeg:${thumbnailKey}`));
    const references = routeCalls.find((call) => call.startsWith('video-refs:')) ?? '';
    assert(references.includes(`source_video:https://signed.example.test/${videoKey}`));
    assert(references.includes(`last_frame:https://signed.example.test/${thumbnailKey}`));
    const status = await (await fetch(`http://127.0.0.1:${address.port}/api/generate/${accepted.jobId}/status`)).json() as { status: string };
    assert.equal(status.status, 'complete');
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('fails video jobs without result media when thumbnail upload fails after MP4 upload', async () => {
    const routeCalls: string[] = [];
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        routeCalls.push(`video:${input.endpointId}`);
        return {
          video: { bytes: Buffer.from('fake mp4'), contentType: 'video/mp4' },
          thumbnail: { bytes: Buffer.from('fake jpg'), contentType: 'image/jpeg' },
          providerTask: { provider: 'byteplus', taskId: 'task-fail', modelId: input.model.id }
        };
      }
    };
    const routeStorage: ObjectStorageAdapter = {
      async putObject(input: PutObjectInput) {
        routeCalls.push(`put:${input.contentType}:${input.key}`);
        if (input.contentType === 'image/jpeg') throw new Error('mock thumbnail upload failed');
        return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString(), bucket: 'lucidio-test', region: 'test-region' };
      },
      async presignGet(input: PresignGetInput) {
        return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
      },
      async getObject(input: GetObjectInput) {
        return { body: Buffer.from('fake image'), contentType: input.contentType ?? 'image/jpeg', size: 10 };
      },
      async deleteObject(key: string) {
        routeCalls.push(`delete:${key}`);
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter: routeStorage, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    type FailedStatus = { status: string; result?: unknown };
    let status: FailedStatus | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await (await fetch(`http://127.0.0.1:${address.port}/api/generate/${accepted.jobId}/status`)).json() as FailedStatus;
      if (status.status === 'failed') break;
    }
    assert.equal(status?.status, 'failed');
    assert.equal(status?.result, undefined);
    assert(routeCalls.some((call) => call.startsWith('delete:')));
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('aborts active video jobs and calls provider cancel when a task id is known', async () => {
    const routeCalls: string[] = [];
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        routeCalls.push(`generate-signal:${Boolean(input.signal)}`);
        input.onTaskCreated?.('task-cancel');
        return new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        });
      },
      async cancel(taskId: string) {
        routeCalls.push(`cancel:${taskId}`);
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${root}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    for (let i = 0; i < 20 && !routeCalls.includes('generate-signal:true'); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelResponse = await fetch(`${root}/api/generate/${accepted.jobId}/cancel`, { method: 'POST' });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json() as { status: string };
    assert.equal(cancelled.status, 'cancelled');
    for (let i = 0; i < 20 && !routeCalls.includes('cancel:task-cancel'); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(routeCalls.includes('cancel:task-cancel'));
    const status = await (await fetch(`${root}/api/generate/${accepted.jobId}/status`)).json() as { status: string };
    assert.equal(status.status, 'cancelled');
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('cleans up uploaded video objects when cancellation happens during upload', async () => {
    const routeCalls: string[] = [];
    let uploadedVideoKey = '';
    let releaseThumbnailUpload: (() => void) | null = null;
    const routeVideoAdapter: VideoGenerationAdapter = {
      async generate(input) {
        input.onTaskCreated?.('task-upload-cancel');
        return {
          video: { bytes: Buffer.from('fake mp4'), contentType: 'video/mp4' },
          thumbnail: { bytes: Buffer.from('fake jpg'), contentType: 'image/jpeg' },
          providerTask: { provider: 'byteplus', taskId: 'task-upload-cancel', modelId: input.model.id }
        };
      },
      async cancel(taskId: string) {
        routeCalls.push(`cancel:${taskId}`);
      }
    };
    const routeStorage: ObjectStorageAdapter = {
      async putObject(input: PutObjectInput) {
        routeCalls.push(`put:${input.contentType}:${input.key}`);
        if (input.contentType === 'video/mp4') uploadedVideoKey = input.key;
        if (input.contentType === 'image/jpeg') await new Promise<void>((resolve) => { releaseThumbnailUpload = resolve; });
        return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString(), bucket: 'lucidio-test', region: 'test-region' };
      },
      async presignGet(input: PresignGetInput) {
        return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
      },
      async getObject(input: GetObjectInput) {
        return { body: Buffer.from('fake image'), contentType: input.contentType ?? 'image/jpeg', size: 10 };
      },
      async deleteObject(key: string) {
        routeCalls.push(`delete:${key}`);
      }
    };
    const app = createApp({ catalog, config: testConfig({ includeVideo: true }), imageAdapter, videoAdapter: routeVideoAdapter, storageAdapter: routeStorage, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${root}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(videoPayload()) });
    const accepted = await response.json() as { jobId: string };
    for (let i = 0; i < 20 && !releaseThumbnailUpload; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(releaseThumbnailUpload);
    const finishThumbnailUpload = releaseThumbnailUpload as () => void;
    const cancelResponse = await fetch(`${root}/api/generate/${accepted.jobId}/cancel`, { method: 'POST' });
    assert.equal(cancelResponse.status, 200);
    finishThumbnailUpload();
    for (let i = 0; i < 20 && !routeCalls.some((call) => call.startsWith('delete:')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(routeCalls.includes(`delete:${uploadedVideoKey}`));
    const status = await (await fetch(`${root}/api/generate/${accepted.jobId}/status`)).json() as { status: string; result?: unknown };
    assert.equal(status.status, 'cancelled');
    assert.equal(status.result, undefined);
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('rejects missing endpoint config before job creation', async () => {
    const badConfig = testConfig();
    badConfig.providers.byteplus!.modelArk.modelEndpointIds[imageModel.id] = 'BYTEPLUS_ACCOUNT_ENDPOINT_ID_PLACEHOLDER';
    const app = createApp({ catalog, config: badConfig, imageAdapter, storageAdapter, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()) });
    assert.equal(response.status, 500);
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('rejects arbitrary object keys and content-type/key mismatches at presign boundary', async () => {
    const response = await fetch(`${baseUrl}/api/media/presign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '../secret', purpose: 'preview' }) });
    assert.equal(response.status, 400);

    const videoKey = createGenerationObjectKey('generations', 'job_123', 'gen_456', 'video/mp4');
    const signedVideo = await fetch(`${baseUrl}/api/media/presign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: videoKey, purpose: 'download', contentType: 'video/mp4', assetRole: 'primary' }) });
    assert.equal(signedVideo.status, 200);

    const badRole = await fetch(`${baseUrl}/api/media/presign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: videoKey, purpose: 'preview', contentType: 'video/mp4', assetRole: 'thumbnail' }) });
    assert.equal(badRole.status, 400);

    const mismatch = await fetch(`${baseUrl}/api/media/presign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: videoKey, purpose: 'preview', contentType: 'image/png', assetRole: 'primary' }) });
    assert.equal(mismatch.status, 400);
  });

  it('returns resized WebP thumbnails for stored image media', async () => {
    const source = await sharp({ create: { width: 960, height: 540, channels: 3, background: '#6366f1' } }).jpeg().toBuffer();
    const imageKey = createGenerationObjectKey('generations', 'job_123', 'gen_thumb', 'image/jpeg');
    const routeStorage: ObjectStorageAdapter = {
      async putObject(input: PutObjectInput) {
        return { provider: 'byteplus-tos', key: input.key, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString() };
      },
      async presignGet(input: PresignGetInput) {
        return { url: `https://signed.example.test/${input.key}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), contentType: input.contentType, filename: input.filename };
      },
      async getObject(input: GetObjectInput) {
        assert.equal(input.key, imageKey);
        assert.equal(input.maxBytes, 25 * 1024 * 1024);
        return { body: source, contentType: 'image/jpeg', size: source.length };
      }
    };
    const app = createApp({ catalog, config: testConfig(), imageAdapter, storageAdapter: routeStorage, logger: testLogger, production: false });
    const tempServer = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const address = tempServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/media/thumbnail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: imageKey, contentType: 'image/jpeg', assetRole: 'primary' }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const thumbnail = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.format, 'webp');
    assert((metadata.width ?? 0) <= 320);
    assert((metadata.height ?? 0) <= 320);
    await new Promise<void>((resolve, reject) => tempServer.close((error) => error ? reject(error) : resolve()));
  });

  it('rejects thumbnail requests for non-image and invalid media keys', async () => {
    const badKey = await fetch(`${baseUrl}/api/media/thumbnail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '../secret' }) });
    assert.equal(badKey.status, 400);

    const videoKey = createGenerationObjectKey('generations', 'job_123', 'gen_video', 'video/mp4');
    const videoResponse = await fetch(`${baseUrl}/api/media/thumbnail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: videoKey, contentType: 'video/mp4' }) });
    assert.equal(videoResponse.status, 400);
  });
});
