import type { GeminiConfig } from '../providerConfig.js';
import type { CatalogValue } from '../modelCatalog.js';
import type { GenerationUsage } from '../contracts.js';
import { normalizeProviderUsage } from './usage.js';
import { VideoProviderError, type VideoGenerationAdapter, type VideoGenerationInput, type VideoGenerationResult, type VideoReferenceInput } from './videoAdapter.js';
import { extractVideoThumbnail, type VideoThumbnail } from './videoThumbnail.js';
import {
  GEMINI_API_KEY_HEADER, asRecord, downloadBounded, fetchInlineData, geminiAuthHeaders, geminiFetch,
  numberField, parseJson, safeNetworkError, safeProviderError, safeProviderErrorMessage,
  sleep, stringField
} from './geminiShared.js';
import { getConfiguredSecret } from '../providerConfig.js';

interface GeminiVeoAdapterOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxVideoBytes?: number;
  extractThumbnail?: (mp4Bytes: Buffer) => Promise<VideoThumbnail>;
}

const DEFAULTS: Required<GeminiVeoAdapterOptions> = {
  pollIntervalMs: 5_000,
  pollTimeoutMs: 10 * 60_000,
  maxVideoBytes: 500 * 1024 * 1024,
  extractThumbnail: extractVideoThumbnail
};
const VEO_DURATIONS = [4, 6, 8];

interface OperationSnapshot {
  name?: string;
  done?: boolean;
  videoUri?: string;
  videoBytes?: string;
  durationSeconds?: number;
  usage?: GenerationUsage;
  errorMessage?: string;
}

/**
 * Veo video generation via the Gemini `:predictLongRunning` API: submit an
 * operation, poll until done, then download the resulting MP4 and derive a
 * thumbnail from its first frame (Veo returns no thumbnail image).
 */
export class GeminiVeoAdapter implements VideoGenerationAdapter {
  private readonly options: Required<GeminiVeoAdapterOptions>;

  constructor(private readonly config: GeminiConfig, private readonly fetchImpl: typeof fetch = fetch, options: GeminiVeoAdapterOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const operationName = await this.createOperation(input);
    input.onTaskCreated?.(operationName);
    const snapshot = await this.pollOperation(operationName, input.signal);

    let videoBytes: Buffer;
    if (snapshot.videoBytes) {
      videoBytes = Buffer.from(snapshot.videoBytes, 'base64');
    } else if (snapshot.videoUri) {
      const downloaded = await downloadBounded(this.fetchImpl, snapshot.videoUri, this.downloadHeaders(), 'video', this.options.maxVideoBytes, input.signal);
      videoBytes = downloaded.bytes;
    } else {
      throw new Error('Veo operation completed without a video URI or inline video bytes.');
    }

    const thumbnail = await this.options.extractThumbnail(videoBytes);
    return {
      video: { bytes: videoBytes, contentType: 'video/mp4', durationSeconds: snapshot.durationSeconds },
      thumbnail: { bytes: thumbnail.bytes, contentType: thumbnail.contentType, width: thumbnail.width, height: thumbnail.height },
      providerTask: { provider: 'gemini', taskId: operationName, modelId: input.model.id, completedAt: new Date().toISOString() },
      usage: snapshot.usage
    };
  }

  private async createOperation(input: VideoGenerationInput): Promise<string> {
    const instance = await this.buildInstance(input);
    const body = { instances: [instance], parameters: buildParameters(input.params) };
    let response: Response;
    try {
      response = await geminiFetch(this.fetchImpl, `${this.config.baseUrl}/v1beta/models/${encodeURIComponent(input.endpointId)}:predictLongRunning`, {
        method: 'POST',
        headers: geminiAuthHeaders(this.config),
        body: JSON.stringify(body)
      }, 'Veo operation create timed out.', input.signal);
    } catch (error) {
      throw new Error(`Veo operation create failed before HTTP response: ${safeNetworkError(error)}. Check providers.gemini.baseUrl and network access.`, { cause: error });
    }
    const parsed = await parseJson(response);
    if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
    const name = stringField(asRecord(parsed), ['name']);
    if (!name) throw new Error('Veo predictLongRunning response did not include an operation name.');
    return name;
  }

  private async pollOperation(operationName: string, signal?: AbortSignal): Promise<OperationSnapshot> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Veo operation polling cancelled.');
      await sleep(this.options.pollIntervalMs, signal);
      const snapshot = await this.retrieveOperation(operationName, signal);
      if (snapshot.errorMessage) throw new VideoProviderError(safeProviderErrorMessage(snapshot.errorMessage));
      if (snapshot.done) {
        if (!snapshot.videoUri && !snapshot.videoBytes) throw new Error('Veo operation reported done without a video result.');
        return snapshot;
      }
    }
    throw new Error(`Veo operation timed out after ${this.options.pollTimeoutMs}ms.`);
  }

  private async retrieveOperation(operationName: string, signal?: AbortSignal): Promise<OperationSnapshot> {
    let response: Response;
    try {
      response = await geminiFetch(this.fetchImpl, `${this.config.baseUrl}/v1beta/${operationName}`, {
        method: 'GET',
        headers: geminiAuthHeaders(this.config)
      }, 'Veo operation retrieve timed out.', signal);
    } catch (error) {
      throw new Error(`Veo operation retrieve failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
    }
    const parsed = await parseJson(response);
    if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
    return operationSnapshot(parsed);
  }

  private async buildInstance(input: VideoGenerationInput): Promise<Record<string, unknown>> {
    const instance: Record<string, unknown> = { prompt: input.prompt };
    const referenceImages: Array<Record<string, unknown>> = [];
    for (const reference of input.references) {
      const inline = await this.referenceInline(reference);
      if (!inline) continue;
      if (reference.intent === 'first_frame') instance.image = { inlineData: inline };
      else if (reference.intent === 'last_frame') instance.lastFrame = { inlineData: inline };
      else referenceImages.push({ image: { inlineData: inline }, referenceType: 'asset' });
    }
    if (referenceImages.length) instance.referenceImages = referenceImages;
    return instance;
  }

  private async referenceInline(reference: VideoReferenceInput): Promise<{ mimeType: string; data: string } | undefined> {
    if (!reference.contentType.startsWith('image/')) return undefined;
    return fetchInlineData(this.fetchImpl, reference.url);
  }

  private downloadHeaders(): Record<string, string> {
    return { [GEMINI_API_KEY_HEADER]: getConfiguredSecret(this.config.apiKeyEnv, 'Gemini API key') };
  }
}

function buildParameters(params: Record<string, CatalogValue>): Record<string, unknown> {
  const out: Record<string, unknown> = { numberOfVideos: 1 };
  if (typeof params.resolution === 'string') out.resolution = params.resolution;
  if (typeof params.ratio === 'string') out.aspectRatio = params.ratio;
  if (typeof params.duration === 'number') out.durationSeconds = coerceDuration(params.duration);
  if (typeof params.generate_audio === 'boolean') out.generateAudio = params.generate_audio;
  if (typeof params.person_generation === 'string') out.personGeneration = params.person_generation;
  if (typeof params.negative_prompt === 'string' && params.negative_prompt.trim()) out.negativePrompt = params.negative_prompt;
  return out;
}

function coerceDuration(value: number): number {
  return VEO_DURATIONS.reduce((best, option) => Math.abs(option - value) < Math.abs(best - value) ? option : best, VEO_DURATIONS[0]);
}

function operationSnapshot(value: unknown): OperationSnapshot {
  const root = asRecord(value);
  const response = asRecord(root?.response);
  const samples = firstArray(response?.generatedSamples) ?? firstArray(response?.videos) ?? firstArray(response?.generateVideoResponse) ?? firstArray(asRecord(response?.generateVideoResponse)?.generatedSamples);
  const sample = asRecord(samples?.[0]) ?? asRecord(response?.video) ?? response;
  const video = asRecord(sample?.video) ?? sample;
  const errorRecord = asRecord(root?.error);
  return {
    name: stringField(root, ['name']),
    done: root?.done === true,
    videoUri: stringField(video, ['uri', 'url', 'video_uri', 'videoUri']),
    videoBytes: stringField(video, ['bytesBase64Encoded', 'videoBytes', 'data']),
    durationSeconds: numberField(video, ['durationSeconds', 'duration_seconds', 'duration']),
    usage: normalizeProviderUsage(root?.metadata ?? response?.usageMetadata ?? response?.usage),
    errorMessage: stringField(errorRecord, ['message']) ?? stringField(asRecord(root?.response), ['error'])
  };
}

function firstArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
