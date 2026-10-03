import type { GeminiConfig } from '../providerConfig.js';
import type { CatalogValue } from '../modelCatalog.js';
import { normalizeProviderUsage } from './usage.js';
import type { ImageGenerationAdapter, ImageGenerationInput, ImageGenerationResult } from './imageAdapter.js';
import { asRecord, fetchInlineData, geminiAuthHeaders, geminiFetch, parseJson, safeNetworkError, safeProviderError, stringField } from './geminiShared.js';

const DEFAULT_OUTPUT_MIME = 'image/jpeg';
const SUPPORTED_OUTPUT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Nano Banana image generation via the Gemini Interactions API
 * (POST /v1beta/interactions). The catalog `id` is used directly as the API
 * model name; res/ratio are canonicalised to image_size/aspect_ratio upstream.
 */
export class GeminiImageAdapter implements ImageGenerationAdapter {
  constructor(private readonly config: GeminiConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const inputParts: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
    for (const reference of input.references) {
      const { mimeType, data } = await fetchInlineData(this.fetchImpl, reference.url);
      inputParts.push({ type: 'image', mime_type: mimeType, data });
    }

    const outputMime = stringParam(input.params, 'mime_type', DEFAULT_OUTPUT_MIME);
    const body: Record<string, unknown> = {
      model: input.endpointId,
      input: inputParts,
      response_format: stripUndefined({
        type: 'image',
        mime_type: SUPPORTED_OUTPUT_MIME.has(outputMime) ? outputMime : DEFAULT_OUTPUT_MIME,
        aspect_ratio: stringParam(input.params, 'aspect_ratio'),
        image_size: stringParam(input.params, 'image_size')
      })
    };

    let response: Response;
    try {
      response = await geminiFetch(this.fetchImpl, `${this.config.baseUrl}/v1beta/interactions`, {
        method: 'POST',
        headers: geminiAuthHeaders(this.config),
        body: JSON.stringify(body)
      }, 'Gemini image request timed out.');
    } catch (error) {
      throw new Error(`Gemini image request failed before HTTP response: ${safeNetworkError(error)}. Check providers.gemini.baseUrl and network access.`, { cause: error });
    }

    const parsed = await parseJson(response);
    if (!response.ok) throw new Error(safeProviderError(response.status, parsed));

    const image = extractImage(parsed);
    if (!image) throw new Error('Gemini image response did not contain image data.');
    const usage = normalizeProviderUsage(asRecord(parsed)?.usage ?? asRecord(parsed)?.usageMetadata);
    return { bytes: Buffer.from(image.data, 'base64'), contentType: normalizeImageMime(image.mimeType), usage };
  }
}

function extractImage(value: unknown): { data: string; mimeType: string } | undefined {
  const root = asRecord(value);
  if (!root) return undefined;
  // Preferred Interactions API shape: { output_image: { data, mime_type } }
  const direct = imageFromRecord(asRecord(root.output_image) ?? asRecord(root.outputImage));
  if (direct) return direct;
  // Fall back to scanning output/candidate content parts for inline image data.
  for (const container of [root.output, root.candidates, root.outputs, root.content, root.parts]) {
    const found = scanForImage(container);
    if (found) return found;
  }
  return imageFromRecord(root);
}

function scanForImage(value: unknown): { data: string; mimeType: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanForImage(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = imageFromRecord(record)
    ?? imageFromRecord(asRecord(record.inlineData) ?? asRecord(record.inline_data))
    ?? imageFromRecord(asRecord(record.image) ?? asRecord(record.output_image));
  if (direct) return direct;
  for (const nested of [record.content, record.parts, record.output, record.candidates]) {
    const found = scanForImage(nested);
    if (found) return found;
  }
  return undefined;
}

function imageFromRecord(record: Record<string, unknown> | undefined): { data: string; mimeType: string } | undefined {
  if (!record) return undefined;
  const data = stringField(record, ['data', 'b64_json', 'bytesBase64Encoded']);
  if (!data) return undefined;
  const mimeType = stringField(record, ['mime_type', 'mimeType']) ?? DEFAULT_OUTPUT_MIME;
  return { data: stripDataUrlPrefix(data), mimeType };
}

function normalizeImageMime(value: string): string {
  const normalized = value.toLowerCase() === 'image/jpg' ? 'image/jpeg' : value.toLowerCase();
  return SUPPORTED_OUTPUT_MIME.has(normalized) ? normalized : DEFAULT_OUTPUT_MIME;
}

function stringParam(params: Record<string, CatalogValue>, name: string, fallback?: string): string {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value : (fallback ?? '');
}

function stripDataUrlPrefix(value: string): string {
  return value.includes(',') && value.startsWith('data:') ? value.split(',').at(-1) ?? '' : value;
}

function stripUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== '')) as T;
}
