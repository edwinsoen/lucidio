import { getConfiguredSecret, type BytePlusModelArkConfig } from '../providerConfig.js';
import type { CatalogValue } from '../modelCatalog.js';
import type { GenerationUsage } from '../contracts.js';
import { normalizeProviderUsage } from './usage.js';
import { VideoProviderError, type VideoGenerationAdapter, type VideoGenerationInput, type VideoGenerationResult, type VideoReferenceInput } from './videoAdapter.js';

interface BytePlusVideoAdapterOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchTimeoutMs?: number;
  maxVideoBytes?: number;
  maxThumbnailBytes?: number;
}

interface TaskSnapshot {
  taskId?: string;
  status?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  usage?: GenerationUsage;
  errorMessage?: string;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  pollTimeoutMs: 10 * 60_000,
  fetchTimeoutMs: 2 * 60_000,
  maxVideoBytes: 500 * 1024 * 1024,
  maxThumbnailBytes: 20 * 1024 * 1024
};

export class BytePlusVideoAdapter implements VideoGenerationAdapter {
  private readonly options: Required<BytePlusVideoAdapterOptions>;

  constructor(private readonly config: BytePlusModelArkConfig, private readonly fetchImpl: typeof fetch = fetch, options: BytePlusVideoAdapterOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationResult> {
    const createSnapshot = await this.createTask(input);
    const taskId = createSnapshot.taskId;
    if (!taskId) throw new Error('BytePlus video task response did not include a task id.');
    input.onTaskCreated?.(taskId);
    const finalSnapshot = isSuccessfulStatus(createSnapshot.status) && createSnapshot.videoUrl && createSnapshot.thumbnailUrl
      ? createSnapshot
      : await this.pollTask(taskId, input.signal);
    if (!finalSnapshot.videoUrl) throw new Error('BytePlus video task completed without a video URL.');
    if (!finalSnapshot.thumbnailUrl) throw new Error('BytePlus video task completed without a returned last-frame thumbnail URL.');

    const [video, thumbnail] = await Promise.all([
      this.downloadMedia(finalSnapshot.videoUrl, 'video', this.options.maxVideoBytes, input.signal),
      this.downloadMedia(finalSnapshot.thumbnailUrl, 'thumbnail', this.options.maxThumbnailBytes, input.signal)
    ]);
    if (video.contentType !== 'video/mp4') throw new Error(`BytePlus video output content type was ${video.contentType}, expected video/mp4.`);
    const thumbnailContentType = normalizeImageContentType(thumbnail.contentType);

    return {
      video: { bytes: video.bytes, contentType: 'video/mp4', durationSeconds: finalSnapshot.durationSeconds },
      thumbnail: { bytes: thumbnail.bytes, contentType: thumbnailContentType },
      providerTask: { provider: 'byteplus', taskId, modelId: input.model.id, completedAt: new Date().toISOString() },
      usage: finalSnapshot.usage
    };
  }

  async cancel(taskId: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        headers: this.authHeaders()
      }, `BytePlus video task cancel timed out.`);
    } catch (error) {
      throw new Error(`BytePlus video task cancel failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
    }
    if (!response.ok && response.status !== 404) throw new Error(`BytePlus video task cancel failed (${response.status}).`);
  }

  private async createTask(input: VideoGenerationInput): Promise<TaskSnapshot> {
    const body: Record<string, unknown> = {
      ...input.params,
      model: input.endpointId,
      content: buildContent(input.prompt, input.references),
      return_last_frame: true
    };
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v3/contents/generations/tasks`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body)
      }, 'BytePlus video task create timed out.', input.signal);
    } catch (error) {
      throw new Error(`BytePlus video task create failed before HTTP response: ${safeNetworkError(error)}. Check providers.byteplus.modelArk.baseUrl, endpoint region, and network access.`, { cause: error });
    }
    const parsed = await parseJson(response);
    if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
    return taskSnapshot(parsed);
  }

  private async pollTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    let last: TaskSnapshot = { taskId };
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('BytePlus video task polling cancelled.');
      await sleep(this.options.pollIntervalMs, signal);
      const snapshot = await this.retrieveTask(taskId, signal);
      last = snapshot;
      if (isFailureStatus(snapshot.status)) throw new VideoProviderError(safeProviderErrorMessage(snapshot.errorMessage || snapshot.status || 'unknown failure'));
      if (isSuccessfulStatus(snapshot.status)) {
        if (!snapshot.videoUrl || !snapshot.thumbnailUrl) throw new Error('BytePlus video task succeeded without video and last-frame thumbnail URLs.');
        return snapshot;
      }
    }
    throw new Error(`BytePlus video task timed out after ${this.options.pollTimeoutMs}ms; last status: ${redact(last.status || 'unknown')}.`);
  }

  private async retrieveTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: this.authHeaders()
      }, 'BytePlus video task retrieve timed out.', signal);
    } catch (error) {
      throw new Error(`BytePlus video task retrieve failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
    }
    const parsed = await parseJson(response);
    if (!response.ok) throw new VideoProviderError(safeProviderError(response.status, parsed));
    return taskSnapshot(parsed);
  }

  private async downloadMedia(url: string, label: 'video' | 'thumbnail', maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
    let response: Response;
    const message = `BytePlus ${label} download timed out.`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(message)), this.options.fetchTimeoutMs);
    const abortFromParent = () => controller.abort(signal?.reason ?? new Error('BytePlus video request cancelled.'));
    try {
      if (signal?.aborted) abortFromParent();
      else signal?.addEventListener('abort', abortFromParent, { once: true });
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') throw new Error(message);
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw new Error(`BytePlus ${label} download failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
    }
    try {
      if (!response.ok) throw new Error(`BytePlus ${label} download failed (${response.status}).`);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
      if (!contentType) throw new Error(`BytePlus ${label} download did not include a content-type header.`);
      const normalizedContentType = label === 'video' ? normalizeVideoContentType(contentType) : normalizeImageContentType(contentType);
      const lengthHeader = response.headers.get('content-length');
      const declaredLength = lengthHeader ? Number(lengthHeader) : undefined;
      if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`BytePlus ${label} download exceeded configured size limit.`);
      const bytes = await readBoundedBody(response, label, maxBytes, controller.signal, message);
      return { bytes, contentType: normalizedContentType };
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') throw new Error(message);
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${getConfiguredSecret(this.config.apiKeyEnv, 'BytePlus ModelArk API key')}`,
      'Content-Type': 'application/json'
    };
  }

  private async fetchWithTimeout(input: Parameters<typeof fetch>[0], init: RequestInit, message: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(message)), this.options.fetchTimeoutMs);
    const abortFromParent = () => controller.abort(signal?.reason ?? new Error('BytePlus video request cancelled.'));
    try {
      if (signal?.aborted) abortFromParent();
      else signal?.addEventListener('abort', abortFromParent, { once: true });
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') throw new Error(message);
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }
}

function buildContent(prompt: string, references: VideoReferenceInput[]): unknown[] {
  const content: unknown[] = [{ type: 'text', text: prompt }];
  for (const reference of references) content.push(referenceContent(reference));
  return content;
}

function referenceContent(reference: VideoReferenceInput): Record<string, unknown> {
  if (reference.intent === 'source_video') return { type: 'video_url', video_url: { url: reference.url }, role: 'reference_video' };
  if (reference.intent === 'sample_task') return { type: 'sample_task', task_id: reference.providerTask?.taskId, role: 'sample_task' };
  if (reference.intent === 'audio_reference') return { type: 'audio_url', audio_url: { url: reference.url }, role: 'audio_reference' };
  return { type: 'image_url', image_url: { url: reference.url }, role: reference.intent };
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function taskSnapshot(value: unknown): TaskSnapshot {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? asRecord(root?.task) ?? root;
  const output = asRecord(data?.output) ?? asRecord(data?.result) ?? asRecord(data?.outputs) ?? asRecord(data?.content) ?? data;
  const videoUrl = stringField(output, ['video_url', 'videoUrl', 'url']) ?? stringField(asRecord(output?.video), ['url', 'video_url']);
  const thumbnailUrl = stringField(output, ['last_frame_url', 'lastFrameUrl', 'thumbnail_url', 'thumbnailUrl', 'image_url']) ?? stringField(asRecord(output?.last_frame), ['url']) ?? stringField(asRecord(output?.thumbnail), ['url']);
  return {
    taskId: stringField(data, ['id', 'task_id', 'taskId']) ?? stringField(root, ['id', 'task_id', 'taskId']),
    status: stringField(data, ['status', 'state']) ?? stringField(root, ['status', 'state']),
    videoUrl,
    thumbnailUrl,
    durationSeconds: numberField(output, ['duration', 'duration_seconds', 'durationSeconds']),
    usage: normalizeProviderUsage(data?.usage ?? root?.usage ?? output?.usage),
    errorMessage: stringField(asRecord(data?.error), ['message']) ?? stringField(data, ['error_message', 'message'])
  };
}

function isSuccessfulStatus(status: string | undefined): boolean {
  return ['succeeded', 'success', 'completed', 'complete', 'done'].includes(status?.toLowerCase() ?? '');
}
function isFailureStatus(status: string | undefined): boolean {
  return ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status?.toLowerCase() ?? '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key] as string;
  return undefined;
}
function numberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
  return undefined;
}

function normalizeVideoContentType(value: string): 'video/mp4' {
  if (value === 'video/mp4') return 'video/mp4';
  throw new Error(`BytePlus video output content type was ${value}, expected video/mp4.`);
}

function normalizeImageContentType(value: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (value === 'image/jpg') return 'image/jpeg';
  if (value === 'image/jpeg') return 'image/jpeg';
  if (value === 'image/png') return 'image/png';
  if (value === 'image/webp') return 'image/webp';
  throw new Error(`BytePlus thumbnail output content type was ${value}, expected image/jpeg, image/png, or image/webp.`);
}

async function readBoundedBody(response: Response, label: 'video' | 'thumbnail', maxBytes: number, signal: AbortSignal, timeoutMessage: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abortRead = () => {
    void reader.cancel(signal.reason ?? timeoutMessage).catch(() => undefined);
    rejectAbort?.(signal.reason instanceof Error ? signal.reason : new Error(timeoutMessage));
  };
  try {
    if (signal.aborted) abortRead();
    else signal.addEventListener('abort', abortRead, { once: true });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(timeoutMessage);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel(`BytePlus ${label} download exceeded configured size limit.`).catch(() => undefined);
        throw new Error(`BytePlus ${label} download exceeded configured size limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function safeProviderError(status: number, parsed: unknown): string {
  const record = asRecord(parsed);
  const message = stringField(asRecord(record?.error), ['message']) ?? stringField(record, ['message', 'error']) ?? `BytePlus video generation failed (${status}).`;
  return safeProviderErrorMessage(message);
}
function safeNetworkError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
function safeProviderErrorMessage(value: string): string {
  return redact(value)
    .replace(/^Error:\s*/i, '')
    .replace(/\b(?:request|trace|task|job|log|event|session)[\s_-]*id\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\b(?:requestId|traceId|taskId|jobId|logId|eventId|sessionId)\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:.-]+$/g, '')
    .trim()
    .slice(0, 300) || 'Video generation failed.';
}
function redact(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/AWS4-HMAC-SHA256 Credential=\S+/gi, 'AWS4-HMAC-SHA256 Credential=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]');
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('BytePlus video task polling cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('BytePlus video task polling cancelled.')); }, { once: true });
  });
}
