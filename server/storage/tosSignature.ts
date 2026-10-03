import crypto from 'node:crypto';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string }
export interface SignRequestInput {
  method: string;
  url: URL;
  region: string;
  service?: string;
  headers?: Record<string, string>;
  bodyHash?: string;
  credentials: AwsCredentials;
  now?: Date;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function signRequest(input: SignRequestInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const service = input.service ?? 's3';
  const headers = normalizeHeaders({ ...(input.headers ?? {}), host: input.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': input.bodyHash ?? 'UNSIGNED-PAYLOAD' });
  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers);
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri(input.url.pathname), canonicalQuery(input.url.searchParams), canonicalHeaders, signedHeaders, input.bodyHash ?? 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacHex(signingKey(input.credentials.secretAccessKey, dateStamp, input.region, service), stringToSign);
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

export function presignUrl(input: Omit<SignRequestInput, 'headers' | 'bodyHash'> & { expiresSeconds: number; responseContentDisposition?: string; responseContentType?: string }): string {
  const now = input.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const service = input.service ?? 's3';
  const url = new URL(input.url.toString());
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const query = new URLSearchParams(url.search);
  query.set('X-Amz-Algorithm', ALGORITHM);
  query.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${credentialScope}`);
  query.set('X-Amz-Date', amzDate);
  query.set('X-Amz-Expires', String(input.expiresSeconds));
  query.set('X-Amz-SignedHeaders', 'host');
  if (input.responseContentDisposition) query.set('response-content-disposition', input.responseContentDisposition);
  if (input.responseContentType) query.set('response-content-type', input.responseContentType);

  const canonicalPresignQuery = canonicalQuery(query);
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri(url.pathname), canonicalPresignQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacHex(signingKey(input.credentials.secretAccessKey, dateStamp, input.region, service), stringToSign);
  url.search = '';
  return `${url.toString()}?${canonicalPresignQuery}&X-Amz-Signature=${encodeRfc3986(signature)}`;
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
function hmac(key: string | Buffer, data: string): Buffer { return crypto.createHmac('sha256', key).update(data).digest(); }
function hmacHex(key: string | Buffer, data: string): string { return crypto.createHmac('sha256', key).update(data).digest('hex'); }
function formatAmzDate(date: Date): string { return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function canonicalUri(pathname: string): string { return pathname.split('/').map((part) => encodeURIComponent(decodeURIComponent(part))).join('/'); }
function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
}
function canonicalizeHeaders(headers: Record<string, string>): { canonicalHeaders: string; signedHeaders: string } {
  const entries = Object.entries(headers).sort(([a], [b]) => compareAscii(a, b));
  return { canonicalHeaders: entries.map(([key, value]) => `${key}:${value}\n`).join(''), signedHeaders: entries.map(([key]) => key).join(';') };
}
function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([ak, av], [bk, bv]) => ak === bk ? compareAscii(av, bv) : compareAscii(ak, bk))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
}
function encodeRfc3986(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
