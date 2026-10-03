import { getConfiguredSecret, type GeminiConfig } from '../providerConfig.js';

export const GEMINI_API_KEY_HEADER = 'x-goog-api-key';

const DEFAULT_FETCH_TIMEOUT_MS = 2 * 60_000;

export function geminiAuthHeaders(config: GeminiConfig): Record<string, string> {
  return {
    [GEMINI_API_KEY_HEADER]: getConfiguredSecret(config.apiKeyEnv, 'Gemini API key'),
    'Content-Type': 'application/json'
  };
}

/** Fetch with a timeout that also honours a parent AbortSignal, mirroring the BytePlus adapter pattern. */
export async function geminiFetch(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMessage: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error('Gemini request cancelled.'));
  try {
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') throw new Error(timeoutMessage);
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** Fetch a (presigned) reference asset URL and return inline base64 data for the Gemini request body. */
export async function fetchInlineData(fetchImpl: typeof fetch, url: string, maxBytes = 20 * 1024 * 1024): Promise<{ mimeType: string; data: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Gemini reference download failed before HTTP response: ${safeNetworkError(error)}.`, { cause: error });
  }
  if (!response.ok) throw new Error(`Gemini reference download failed (${response.status}).`);
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Gemini reference asset exceeded the inline size limit.');
  return { mimeType, data: buffer.toString('base64') };
}

/** Download generated media (video/image) to a bounded Buffer, abort-aware. */
export async function downloadBounded(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutMs: number = 2 * 60_000
): Promise<{ bytes: Buffer; contentType: string }> {
  const message = `Gemini ${label} download timed out.`;
  const response = await geminiFetch(fetchImpl, url, { method: 'GET', headers }, message, signal, timeoutMs);
  if (!response.ok) throw new Error(`Gemini ${label} download failed (${response.status}).`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || 'application/octet-stream';
  const lengthHeader = response.headers.get('content-length');
  const declaredLength = lengthHeader ? Number(lengthHeader) : undefined;
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Gemini ${label} download exceeded configured size limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Gemini ${label} download exceeded configured size limit.`);
  return { bytes, contentType };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Gemini task polling cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Gemini task polling cancelled.')); }, { once: true });
  });
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string' && (record[key] as string).trim()) return record[key] as string;
  return undefined;
}

export function numberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
  return undefined;
}

export function safeNetworkError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function safeProviderError(status: number, parsed: unknown): string {
  const record = asRecord(parsed);
  const message = stringField(asRecord(record?.error), ['message']) ?? stringField(record, ['message', 'error']) ?? `Gemini request failed (${status}).`;
  return safeProviderErrorMessage(message);
}

export function safeProviderErrorMessage(value: string): string {
  return redact(value)
    .replace(/^Error:\s*/i, '')
    .replace(/\b(?:request|trace|task|job|log|event|session|operation|interaction)[\s_-]*id\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:/-]*["']?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:.-]+$/g, '')
    .trim()
    .slice(0, 300) || 'Gemini generation failed.';
}

export function redact(value: string): string {
  return value
    .replace(new RegExp(`${GEMINI_API_KEY_HEADER}[:=]?\\s*\\S+`, 'gi'), `${GEMINI_API_KEY_HEADER}: [redacted]`)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[?&]key=[^&\s]+/gi, '?key=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]');
}

export function isSuccessfulStatus(status: string | undefined): boolean {
  return ['succeeded', 'success', 'completed', 'complete', 'done'].includes(status?.toLowerCase() ?? '');
}

export function isFailureStatus(status: string | undefined): boolean {
  return ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status?.toLowerCase() ?? '');
}
