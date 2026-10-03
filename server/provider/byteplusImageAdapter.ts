import { getConfiguredSecret, type BytePlusModelArkConfig } from '../providerConfig.js';
import type { ImageGenerationAdapter, ImageGenerationInput, ImageGenerationResult } from './imageAdapter.js';
import { normalizeProviderUsage } from './usage.js';

interface BytePlusImageResponse {
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  usage?: unknown;
  error?: { message?: string; code?: string };
}

export class BytePlusImageAdapter implements ImageGenerationAdapter {
  constructor(private readonly config: BytePlusModelArkConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const body: Record<string, unknown> = {
      ...input.params,
      model: input.endpointId,
      prompt: input.prompt,
      response_format: 'b64_json',
      stream: false
    };
    if (input.references.length) body.image = input.references.length === 1 ? input.references[0].url : input.references.map((ref) => ref.url);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/api/v3/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getConfiguredSecret(this.config.apiKeyEnv, 'BytePlus ModelArk API key')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(`BytePlus ModelArk request failed before HTTP response: ${safeNetworkError(error)}. Check providers.byteplus.modelArk.baseUrl, endpoint region, and network access.`, { cause: error });
    }
    const text = await response.text();
    let parsed: BytePlusImageResponse | null = null;
    try { parsed = text ? JSON.parse(text) as BytePlusImageResponse : null; } catch { parsed = null; }
    if (!response.ok) throw new Error(safeProviderError(response.status, parsed));

    const usage = normalizeProviderUsage(parsed?.usage);
    const first = parsed?.data?.[0];
    if (!first) throw new Error('BytePlus image response did not contain image data.');
    if (first.b64_json) return { bytes: Buffer.from(stripDataUrlPrefix(first.b64_json), 'base64'), contentType: contentTypeFromDataUrl(first.b64_json) ?? (input.params.output_format === 'png' ? 'image/png' : 'image/jpeg'), usage };
    if (first.url) {
      let imageResponse: Response;
      try {
        imageResponse = await this.fetchImpl(first.url);
      } catch (error) {
        throw new Error(`BytePlus generated image download failed before HTTP response: ${safeNetworkError(error)}. The generated URL may be unreachable from the backend.`, { cause: error });
      }
      if (!imageResponse.ok) throw new Error(`BytePlus image URL fetch failed (${imageResponse.status}).`);
      const contentType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      return { bytes: Buffer.from(await imageResponse.arrayBuffer()), contentType, usage };
    }
    throw new Error('BytePlus image response did not include url or b64_json.');
  }
}

function safeProviderError(status: number, parsed: BytePlusImageResponse | null): string {
  const message = parsed?.error?.message || `BytePlus image generation failed (${status}).`;
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300);
}
function safeNetworkError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300);
}
function stripDataUrlPrefix(value: string): string { return value.includes(',') ? value.split(',').at(-1) ?? '' : value; }
function contentTypeFromDataUrl(value: string): string | undefined { return value.match(/^data:([^;]+);base64,/)?.[1]; }
