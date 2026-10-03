import type { GeminiConfig } from '../providerConfig.js';
import { getConfiguredSecret } from '../providerConfig.js';
import type { GenerationUsage } from '../contracts.js';
import { normalizeProviderUsage } from './usage.js';
import { VideoProviderError, type VideoGenerationAdapter, type VideoGenerationInput, type VideoGenerationResult, type VideoReferenceInput } from './videoAdapter.js';
import { extractVideoThumbnail, type VideoThumbnail } from './videoThumbnail.js';
import {
  GEMINI_API_KEY_HEADER, asRecord, downloadBounded, fetchInlineData, geminiAuthHeaders, geminiFetch,
  isFailureStatus, parseJson, safeNetworkError, safeProviderError,
  safeProviderErrorMessage, sleep, stringField
} from './geminiShared.js';

interface GeminiOmniFlashAdapterOptions {
  createTimeoutMs?: number;
  filePollIntervalMs?: number;
  filePollTimeoutMs?: number;
  maxVideoBytes?: number;
  extractThumbnail?: (mp4Bytes: Buffer) => Promise<VideoThumbnail>;
}

const DEFAULTS: Required<GeminiOmniFlashAdapterOptions> = {
  createTimeoutMs: 6 * 60_000,
  filePollIntervalMs: 3_000,
  filePollTimeoutMs: 5 * 60_000,
  maxVideoBytes: 500 * 1024 * 1024,
  extractThumbnail: extractVideoThumbnail
};

interface OmniSnapshot {
  interactionId?: string;
  status?: string;
  videoData?: string;
  videoUri?: string;
  usage?: GenerationUsage;
  errorMessage?: string;
}

/**
 * Gemini Omni Flash video generation via the Interactions API
 * (POST /v1beta/interactions).
 *
 * NOTE: Omni Flash is a public-preview model. The interaction call is synchronous
 * (it blocks until status `completed` and returns the video in a `model_output`
 * step). `response_format` for video accepts only `type`, `aspect_ratio`, and
 * `delivery` — resolution/duration are not client-controllable. With
 * `delivery: "uri"` (used here so videos >4MB are supported) the video is a Files
 * API reference that must reach state `ACTIVE` before it can be downloaded.
 */
export class GeminiOmniFlashAdapter implements VideoGenerationAdapter {
  private readonly options: Required<GeminiOmniFlashAdapterOptions>;

  constructor(private readonly config: GeminiConfig, private readonly fetchImpl: typeof fetch = fetch, options: GeminiOmniFlashAdapterOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const snapshot = await this.createInteraction(input);
    if (snapshot.interactionId) input.onTaskCreated?.(snapshot.interactionId);
    if (isFailureStatus(snapshot.status) || snapshot.errorMessage) throw new VideoProviderError(safeProviderErrorMessage(snapshot.errorMessage || snapshot.status || 'unknown failure'));

    let videoBytes: Buffer;
    if (snapshot.videoData) {
      videoBytes = Buffer.from(snapshot.videoData, 'base64');
    } else if (snapshot.videoUri) {
      videoBytes = await this.downloadFileUri(snapshot.videoUri, input.signal);
    } else {
      throw new Error('Omni Flash interaction completed without a video result.');
    }

    const thumbnail = await this.options.extractThumbnail(videoBytes);
    return {
      video: { bytes: videoBytes, contentType: 'video/mp4' },
      thumbnail: { bytes: thumbnail.bytes, contentType: thumbnail.contentType, width: thumbnail.width, height: thumbnail.height },
      providerTask: { provider: 'gemini', taskId: snapshot.interactionId ?? input.model.id, modelId: input.model.id, completedAt: new Date().toISOString() },
      usage: snapshot.usage
    };
  }

  private async createInteraction(input: VideoGenerationInput): Promise<OmniSnapshot> {
    // Docs place image parts before the text prompt for image-to-video.
    const imageParts: Array<Record<string, unknown>> = [];
    let hasImageInput = false;
    for (const reference of input.references) {
      const inline = await this.referenceInline(reference);
      if (inline) {
        imageParts.push({ type: 'image', mime_type: inline.mimeType, data: inline.data });
        hasImageInput = true;
      }
    }
    const body: Record<string, unknown> = {
      model: input.endpointId,
      input: [...imageParts, { type: 'text', text: input.prompt }],
      response_format: stripUndefined({ type: 'video', aspect_ratio: aspectRatio(input), delivery: 'uri' })
    };
    if (hasImageInput) body.generation_config = { video_config: { task: 'image_to_video' } };

    let response: Response;
    try {
      response = await geminiFetch(this.fetchImpl, `${this.config.baseUrl}/v1beta/interactions`, {
        method: 'POST',
        headers: geminiAuthHeaders(this.config),
        body: JSON.stringify(body)
      }, 'Omni Flash interaction timed out.', input.signal, this.options.createTimeoutMs);
    } catch (error) {
      throw new Error(`Omni Flash interaction failed before HTTP response: ${safeNetworkError(error)}. Check providers.gemini.baseUrl and network access.`, { cause: error });
    }
    const parsed = await parseJson(response);
    if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
    return omniSnapshot(parsed);
  }

  private async downloadFileUri(uri: string, signal?: AbortSignal): Promise<Buffer> {
    const fileId = extractFileId(uri);
    if (fileId) await this.waitForFileActive(fileId, signal);
    const { bytes } = await downloadBounded(this.fetchImpl, uri, this.downloadHeaders(), 'video', this.options.maxVideoBytes, signal);
    return bytes;
  }

  private async waitForFileActive(fileId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.options.filePollTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Omni Flash file activation cancelled.');
      let response: Response;
      try {
        response = await geminiFetch(this.fetchImpl, `${this.config.baseUrl}/v1beta/files/${encodeURIComponent(fileId)}`, {
          method: 'GET',
          headers: this.downloadHeaders()
        }, 'Omni Flash file status timed out.', signal);
      } catch (error) {
        throw new Error(`Omni Flash file status failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
      }
      const parsed = await parseJson(response);
      if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
      const state = stringField(asRecord(parsed), ['state', 'status'])?.toUpperCase();
      if (state === 'ACTIVE') return;
      if (state === 'FAILED') throw new VideoProviderError('Omni Flash video file processing failed.');
      await sleep(this.options.filePollIntervalMs, signal);
    }
    throw new Error(`Omni Flash video file did not become ACTIVE within ${this.options.filePollTimeoutMs}ms.`);
  }

  private async referenceInline(reference: VideoReferenceInput): Promise<{ mimeType: string; data: string } | undefined> {
    if (!reference.contentType.startsWith('image/')) return undefined;
    return fetchInlineData(this.fetchImpl, reference.url);
  }

  private downloadHeaders(): Record<string, string> {
    return { [GEMINI_API_KEY_HEADER]: getConfiguredSecret(this.config.apiKeyEnv, 'Gemini API key') };
  }
}

function aspectRatio(input: VideoGenerationInput): string | undefined {
  const ratio = input.params.ratio;
  return typeof ratio === 'string' && (ratio === '16:9' || ratio === '9:16') ? ratio : undefined;
}

function extractFileId(uri: string): string | undefined {
  return uri.match(/\/files\/([^/:?]+)/)?.[1];
}

function omniSnapshot(value: unknown): OmniSnapshot {
  const root = asRecord(value);
  const video = findVideoContent(root);
  const errorRecord = asRecord(root?.error);
  return {
    interactionId: stringField(root, ['id', 'interaction_id', 'interactionId', 'name']),
    status: stringField(root, ['status', 'state']),
    videoData: video ? stringField(video, ['data', 'bytesBase64Encoded', 'b64_json']) : undefined,
    videoUri: video ? stringField(video, ['uri', 'url']) : undefined,
    usage: normalizeProviderUsage(root?.usage ?? root?.usageMetadata),
    errorMessage: stringField(errorRecord, ['message']) ?? stringField(root, ['error_message'])
  };
}

/** Locate the `{ type: 'video', mime_type, data|uri }` part inside the model_output step content. */
function findVideoContent(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!root) return undefined;
  const steps = Array.isArray(root.steps) ? root.steps : [];
  // Prefer the last model_output step (the final generated/edited video).
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = asRecord(steps[i]);
    if (step && stringField(step, ['type']) !== 'model_output' && step.type !== undefined) continue;
    const content = Array.isArray(step?.content) ? step!.content : [];
    for (const item of content) {
      const record = asRecord(item);
      if (record && isVideoPart(record)) return record;
    }
  }
  // Fallbacks for shapes that inline the video outside of steps.
  const direct = asRecord(root.output_video) ?? asRecord(root.video);
  return direct && isVideoPart(direct) ? direct : undefined;
}

function isVideoPart(record: Record<string, unknown>): boolean {
  const mime = stringField(record, ['mime_type', 'mimeType']);
  const type = stringField(record, ['type']);
  const hasPayload = Boolean(stringField(record, ['data', 'uri', 'url', 'bytesBase64Encoded']));
  return hasPayload && (type === 'video' || Boolean(mime?.startsWith('video/')));
}

function stripUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== '')) as T;
}
