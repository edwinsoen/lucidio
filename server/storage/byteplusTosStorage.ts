import { getConfiguredSecret, type BytePlusTosConfig } from '../providerConfig.js';
import { assertContentTypeMatchesKey, contentTypeForKey, filenameForKey, validateObjectKey } from '../mediaKeys.js';
import type { GetObjectInput, GetObjectResult, ObjectStorageAdapter, PresignGetInput, PresignGetResult, PutObjectInput, PutObjectResult } from './storageAdapter.js';
import { presignUrl, sha256Hex, signRequest, type AwsCredentials } from './tosSignature.js';

export class BytePlusTosStorageAdapter implements ObjectStorageAdapter {
  constructor(private readonly config: BytePlusTosConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    validateObjectKey(input.key, this.config.keyPrefix);
    assertContentTypeMatchesKey(input.key, input.contentType, this.config.keyPrefix);
    const credentials = this.credentials();
    const url = this.objectUrl(input.key);
    const bodyHash = sha256Hex(input.body);
    const headers = signRequest({
      method: 'PUT',
      url,
      region: this.config.region,
      credentials,
      bodyHash,
      headers: { 'content-type': input.contentType, 'content-length': String(input.body.length) }
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'PUT', headers, body: input.body });
    } catch (error) {
      throw new Error(`BytePlus TOS upload request failed before HTTP response: ${safeNetworkError(error)}. Check storage.byteplusTos.endpoint/publicBaseUrl, bucket, region, credentials, and network access.`, { cause: error });
    }
    if (!response.ok) throw new Error(`BytePlus TOS upload failed (${response.status}): ${await safeResponseText(response)}`);
    return {
      provider: 'byteplus-tos',
      key: input.key,
      contentType: input.contentType,
      size: input.body.length,
      bucket: this.config.bucket,
      region: this.config.region,
      etag: response.headers.get('etag') ?? undefined,
      createdAt: new Date().toISOString()
    };
  }

  async presignGet(input: PresignGetInput): Promise<PresignGetResult> {
    validateObjectKey(input.key, this.config.keyPrefix);
    const ttl = Math.min(Math.max(Math.floor(input.ttlSeconds ?? this.config.presignTtlSeconds), 60), this.config.presignTtlSeconds, 3600);
    const filename = sanitizeFilename(input.filename || filenameForKey(input.key, this.config.keyPrefix));
    const keyContentType = contentTypeForKey(input.key, this.config.keyPrefix);
    if (input.contentType) assertContentTypeMatchesKey(input.key, input.contentType, this.config.keyPrefix);
    const contentType = input.contentType ?? keyContentType;
    const dispositionType = input.purpose === 'download' ? 'attachment' : 'inline';
    const url = presignUrl({
      method: 'GET',
      url: this.objectUrl(input.key),
      region: this.config.region,
      credentials: this.credentials(),
      expiresSeconds: ttl,
      responseContentDisposition: `${dispositionType}; filename="${filename}"`,
      responseContentType: contentType
    });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), contentType, filename };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult> {
    validateObjectKey(input.key, this.config.keyPrefix);
    if (input.contentType) assertContentTypeMatchesKey(input.key, input.contentType, this.config.keyPrefix);
    const expectedContentType = input.contentType ?? contentTypeForKey(input.key, this.config.keyPrefix);
    const maxBytes = Math.max(1, Math.floor(input.maxBytes ?? 20 * 1024 * 1024));
    const url = this.objectUrl(input.key);
    const headers = signRequest({
      method: 'GET',
      url,
      region: this.config.region,
      credentials: this.credentials()
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (error) {
      throw new Error(`BytePlus TOS download request failed before HTTP response: ${safeNetworkError(error)}. Check storage.byteplusTos.endpoint/publicBaseUrl, bucket, region, credentials, and network access.`, { cause: error });
    }
    if (!response.ok) throw new Error(`BytePlus TOS download failed (${response.status}): ${await safeResponseText(response)}`);
    const actualContentType = normalizeHeaderContentType(response.headers.get('content-type')) ?? expectedContentType;
    if (actualContentType !== expectedContentType) throw new Error('Downloaded media content type does not match object key');
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('BytePlus TOS download exceeded configured size limit');
    const body = await readBoundedBody(response, maxBytes);
    return { body, contentType: actualContentType, size: body.length };
  }

  async deleteObject(key: string): Promise<void> {
    validateObjectKey(key, this.config.keyPrefix);
    const credentials = this.credentials();
    const url = this.objectUrl(key);
    const headers = signRequest({
      method: 'DELETE',
      url,
      region: this.config.region,
      credentials,
      bodyHash: sha256Hex(Buffer.alloc(0)),
      headers: {}
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'DELETE', headers });
    } catch (error) {
      throw new Error(`BytePlus TOS delete request failed before HTTP response: ${safeNetworkError(error)}. Check storage.byteplusTos.endpoint/publicBaseUrl, bucket, region, credentials, and network access.`, { cause: error });
    }
    if (!response.ok && response.status !== 404) throw new Error(`BytePlus TOS delete failed (${response.status}): ${await safeResponseText(response)}`);
  }

  private objectUrl(key: string): URL {
    const base = this.config.publicBaseUrl?.trim() || virtualHostedBaseUrl(this.config.endpoint, this.config.bucket);
    return new URL(`${base.replace(/\/+$/g, '')}/${key.split('/').map(encodeURIComponent).join('/')}`);
  }

  private credentials(): AwsCredentials {
    return {
      accessKeyId: getConfiguredSecret(this.config.accessKeyIdEnv, 'BytePlus TOS access key'),
      secretAccessKey: getConfiguredSecret(this.config.secretAccessKeyEnv, 'BytePlus TOS secret key')
    };
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error('BytePlus TOS download exceeded configured size limit');
    return body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('BytePlus TOS download exceeded configured size limit.').catch(() => undefined);
        throw new Error('BytePlus TOS download exceeded configured size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeHeaderContentType(value: string | null): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[\\/\r\n"]/g, '_').slice(0, 120);
  return sanitized || 'lucidio-generation.jpg';
}

function virtualHostedBaseUrl(endpoint: string, bucket: string): string {
  const url = new URL(endpoint);
  if (!url.hostname.startsWith(`${bucket}.`)) url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/g, '');
}

function safeNetworkError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/AWS4-HMAC-SHA256 Credential=\S+/gi, 'AWS4-HMAC-SHA256 Credential=[redacted]').slice(0, 300);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/AWS4-HMAC-SHA256 Credential=\S+/gi, 'AWS4-HMAC-SHA256 Credential=[redacted]').slice(0, 300) || response.statusText;
  } catch {
    return response.statusText;
  }
}
