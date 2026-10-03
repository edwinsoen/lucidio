import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadModelCatalog, type ModelCatalogEntry } from '../modelCatalog.js';
import type { GeminiConfig } from '../providerConfig.js';
import type { VideoThumbnail } from './videoThumbnail.js';
import { GeminiImageAdapter } from './geminiImageAdapter.js';
import { GeminiVeoAdapter } from './geminiVeoAdapter.js';
import { GeminiOmniFlashAdapter } from './geminiOmniFlashAdapter.js';

const catalog = loadModelCatalog();
const geminiConfig: GeminiConfig = { baseUrl: 'https://gen.example.test', apiKeyEnv: 'TEST_GEMINI_API_KEY' };
process.env.TEST_GEMINI_API_KEY = 'test-gemini-key';

function model(id: string): ModelCatalogEntry {
  const found = catalog.models.find((entry) => entry.id === id);
  assert.ok(found, `catalog is missing ${id}`);
  return found;
}

const stubThumbnail = async (): Promise<VideoThumbnail> => ({ bytes: Buffer.from('thumb'), contentType: 'image/webp', width: 320, height: 180 });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GeminiImageAdapter (Nano Banana / Interactions API)', () => {
  it('sends an interactions request with inline references and decodes output_image.data', async () => {
    const pngBytes = Buffer.from('generated-png');
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown>; apiKey?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      const apiKey = new Headers(init?.headers).get('x-goog-api-key') ?? undefined;
      requests.push({ url, method, body, apiKey });
      if (url === 'https://signed.example/ref.png') return new Response(Buffer.from('ref'), { status: 200, headers: { 'content-type': 'image/png' } });
      if (url.endsWith('/v1beta/interactions') && method === 'POST') {
        return jsonResponse({ output_image: { data: pngBytes.toString('base64'), mime_type: 'image/png' }, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
      }
      return new Response('not found', { status: 404 });
    };
    const adapter = new GeminiImageAdapter(geminiConfig, fetchImpl);
    const result = await adapter.generate({
      model: model('gemini-3-pro-image'),
      endpointId: 'gemini-3-pro-image',
      prompt: 'a glass sculpture',
      params: { image_size: '2K', aspect_ratio: '16:9', mime_type: 'image/png' },
      references: [{ id: 'r1', url: 'https://signed.example/ref.png' }]
    });

    assert.equal(result.contentType, 'image/png');
    assert.deepEqual(result.bytes, pngBytes);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    const post = requests.find((request) => request.method === 'POST');
    assert.equal(post?.apiKey, 'test-gemini-key');
    assert.equal(post?.body?.model, 'gemini-3-pro-image');
    assert.deepEqual((post?.body?.input as unknown[])[0], { type: 'text', text: 'a glass sculpture' });
    assert.equal(((post?.body?.input as Array<Record<string, unknown>>)[1]).type, 'image');
    assert.deepEqual(post?.body?.response_format, { type: 'image', mime_type: 'image/png', aspect_ratio: '16:9', image_size: '2K' });
  });

  it('surfaces a missing image payload as an error', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ output: [] });
    const adapter = new GeminiImageAdapter(geminiConfig, fetchImpl);
    await assert.rejects(
      adapter.generate({ model: model('gemini-3.1-flash-image'), endpointId: 'gemini-3.1-flash-image', prompt: 'x', params: {}, references: [] }),
      /did not contain image data/
    );
  });
});

describe('GeminiVeoAdapter (predictLongRunning)', () => {
  it('submits, polls the operation, downloads the video, and derives a thumbnail', async () => {
    const mp4 = Buffer.from('veo-mp4-bytes');
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let polls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url === 'https://signed.example/frame.png') return new Response(Buffer.from('frame'), { status: 200, headers: { 'content-type': 'image/png' } });
      if (url.endsWith('/v1beta/models/veo-3.1-generate-preview:predictLongRunning') && method === 'POST') return jsonResponse({ name: 'operations/veo-1' });
      if (url.endsWith('/v1beta/operations/veo-1') && method === 'GET') {
        polls += 1;
        if (polls < 2) return jsonResponse({ name: 'operations/veo-1', done: false });
        return jsonResponse({ name: 'operations/veo-1', done: true, response: { generatedSamples: [{ video: { uri: 'https://gen.example/veo.mp4', durationSeconds: 8 } }] } });
      }
      if (url === 'https://gen.example/veo.mp4') return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new GeminiVeoAdapter(geminiConfig, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 500, extractThumbnail: stubThumbnail });
    const taskIds: string[] = [];
    const result = await adapter.generate({
      model: model('veo-3.1-generate-preview'),
      endpointId: 'veo-3.1-generate-preview',
      prompt: 'a drone shot over dunes',
      params: { resolution: '1080p', ratio: '16:9', duration: 5, generate_audio: true, person_generation: 'allow_adult' },
      references: [{ generationId: 'g1', intent: 'first_frame', url: 'https://signed.example/frame.png', contentType: 'image/png', kind: 'image' }],
      onTaskCreated: (id) => taskIds.push(id)
    });

    assert.equal(result.video.contentType, 'video/mp4');
    assert.deepEqual(result.video.bytes, mp4);
    assert.equal(result.video.durationSeconds, 8);
    assert.equal(result.thumbnail.contentType, 'image/webp');
    assert.equal(result.providerTask.provider, 'gemini');
    assert.equal(result.providerTask.taskId, 'operations/veo-1');
    assert.deepEqual(taskIds, ['operations/veo-1']);

    const post = requests.find((request) => request.method === 'POST');
    const parameters = post?.body?.parameters as Record<string, unknown>;
    assert.equal(parameters.resolution, '1080p');
    assert.equal(parameters.aspectRatio, '16:9');
    assert.equal(parameters.durationSeconds, 4); // 5 coerced to the nearest supported Veo duration
    assert.equal(parameters.generateAudio, true);
    assert.equal(parameters.personGeneration, 'allow_adult');
    assert.equal(parameters.numberOfVideos, 1);
    const instance = (post?.body?.instances as Array<Record<string, unknown>>)[0];
    assert.equal(instance.prompt, 'a drone shot over dunes');
    assert.ok(instance.image, 'first_frame reference should map to instances[0].image');
  });

  it('accepts inline base64 video bytes without a download', async () => {
    const mp4 = Buffer.from('inline-veo');
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith(':predictLongRunning') && method === 'POST') return jsonResponse({ name: 'operations/veo-2' });
      if (url.endsWith('/v1beta/operations/veo-2')) return jsonResponse({ done: true, response: { generatedSamples: [{ video: { bytesBase64Encoded: mp4.toString('base64') } }] } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new GeminiVeoAdapter(geminiConfig, fetchImpl, { pollIntervalMs: 1, pollTimeoutMs: 500, extractThumbnail: stubThumbnail });
    const result = await adapter.generate({ model: model('veo-3.1-fast-generate-preview'), endpointId: 'veo-3.1-fast-generate-preview', prompt: 'x', params: {}, references: [] });
    assert.deepEqual(result.video.bytes, mp4);
  });
});

describe('GeminiOmniFlashAdapter (Interactions API)', () => {
  it('uses an inline model_output video and sends only valid response_format fields', async () => {
    const mp4 = Buffer.from('omni-inline');
    let postBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1beta/interactions') && method === 'POST') {
        postBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        return jsonResponse({ id: 'omni-1', status: 'completed', object: 'interaction', steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'clouds' }] },
          { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }] }
        ] });
      }
      return new Response('not found', { status: 404 });
    };
    const adapter = new GeminiOmniFlashAdapter(geminiConfig, fetchImpl, { filePollIntervalMs: 1, filePollTimeoutMs: 500, extractThumbnail: stubThumbnail });
    const result = await adapter.generate({ model: model('gemini-omni-flash-preview'), endpointId: 'gemini-omni-flash-preview', prompt: 'clouds', params: { resolution: '720p', ratio: '16:9', duration: 6 }, references: [] });
    assert.deepEqual(result.video.bytes, mp4);
    assert.equal(result.providerTask.provider, 'gemini');
    assert.equal(result.providerTask.taskId, 'omni-1');
    assert.equal(result.thumbnail.contentType, 'image/webp');
    // response_format must not carry resolution/duration (the API rejects them).
    assert.deepEqual(postBody?.response_format, { type: 'video', aspect_ratio: '16:9', delivery: 'uri' });
    assert.equal((postBody?.response_format as Record<string, unknown>).resolution, undefined);
  });

  it('downloads a delivery=uri video after the Files entry becomes ACTIVE', async () => {
    const mp4 = Buffer.from('omni-uri');
    const fileUri = 'https://gen.example.test/v1beta/files/abc123:download?alt=media';
    let fileChecks = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1beta/interactions') && method === 'POST') {
        return jsonResponse({ id: 'omni-2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: fileUri }] }] });
      }
      if (url.endsWith('/v1beta/files/abc123') && method === 'GET') {
        fileChecks += 1;
        return jsonResponse({ name: 'files/abc123', state: fileChecks < 2 ? 'PROCESSING' : 'ACTIVE' });
      }
      if (url === fileUri) return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
      return new Response('not found', { status: 404 });
    };
    const adapter = new GeminiOmniFlashAdapter(geminiConfig, fetchImpl, { filePollIntervalMs: 1, filePollTimeoutMs: 500, extractThumbnail: stubThumbnail });
    const result = await adapter.generate({ model: model('gemini-omni-flash-preview'), endpointId: 'gemini-omni-flash-preview', prompt: 'waves', params: { ratio: '9:16' }, references: [] });
    assert.deepEqual(result.video.bytes, mp4);
    assert.equal(result.providerTask.taskId, 'omni-2');
    assert.ok(fileChecks >= 2, 'should poll the Files entry until ACTIVE');
  });
});
