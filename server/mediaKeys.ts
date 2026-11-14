import crypto from 'node:crypto';
import path from 'node:path';

const SAFE_ID = '[A-Za-z0-9_-]+';
export type SupportedMediaContentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';
export type SupportedMediaExtension = 'jpg' | 'jpeg' | 'png' | 'webp' | 'mp4';

const EXTENSIONS = new Set<SupportedMediaExtension>(['jpg', 'jpeg', 'png', 'webp', 'mp4']);
const CONTENT_TYPES_BY_EXT: Record<SupportedMediaExtension, SupportedMediaContentType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4'
};
const EXT_BY_CONTENT_TYPE: Record<string, Exclude<SupportedMediaExtension, 'jpeg'>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4'
};

export function extensionForContentType(contentType: string): Exclude<SupportedMediaExtension, 'jpeg'> {
  const ext = EXT_BY_CONTENT_TYPE[contentType.toLowerCase()];
  if (!ext) throw new Error('Unsupported media content type');
  return ext;
}

export function contentTypeForKey(key: string, prefix = 'generations'): SupportedMediaContentType {
  validateObjectKey(key, prefix);
  const ext = key.split('.').at(-1)?.toLowerCase() as SupportedMediaExtension | undefined;
  const contentType = ext ? CONTENT_TYPES_BY_EXT[ext] : undefined;
  if (!contentType) throw new Error('Unsupported media content type');
  return contentType;
}

export function assertContentTypeMatchesKey(key: string, contentType: string, prefix = 'generations'): void {
  const expected = contentTypeForKey(key, prefix);
  const normalized = normalizeContentType(contentType);
  if (normalized !== expected) throw new Error('Media content type does not match object key');
}

export function isImageContentType(contentType: string): boolean {
  return normalizeContentType(contentType).startsWith('image/');
}

export function isVideoContentType(contentType: string): boolean {
  return normalizeContentType(contentType) === 'video/mp4';
}

export function normalizeContentType(contentType: string): string {
  return contentType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : contentType.toLowerCase();
}

export function createGenerationObjectKey(prefix: string, jobId: string, generationId: string, contentType: string): string {
  const ext = extensionForContentType(contentType);
  const token = crypto.randomBytes(12).toString('hex');
  return `${sanitizePrefix(prefix)}/${sanitizeId(jobId)}/${token}-${sanitizeId(generationId)}.${ext}`;
}

export function createReferenceObjectKey(prefix: string, contentType: string): string {
  const ext = extensionForContentType(contentType);
  return `${sanitizePrefix(prefix)}/reference/${crypto.randomBytes(12).toString('hex')}-${crypto.randomUUID()}.${ext}`;
}

export function isUploadedReferenceKey(key: string, prefix: string): boolean {
  try {
    validateObjectKey(key, prefix);
    return key.startsWith(`${sanitizePrefix(prefix)}/reference/`);
  } catch {
    return false;
  }
}

export function validateObjectKey(key: string, prefix = 'generations'): void {
  const safePrefix = sanitizePrefix(prefix);
  if (!key || key.startsWith('/') || key.includes('..') || /^https?:\/\//i.test(key) || key.includes('\\')) throw new Error('Invalid media key');
  const regex = new RegExp(`^${escapeRegExp(safePrefix)}/${SAFE_ID}/[a-f0-9]{24}-${SAFE_ID}\\.([A-Za-z0-9]+)$`);
  const match = key.match(regex);
  const ext = match?.[1]?.toLowerCase() as SupportedMediaExtension | undefined;
  if (!ext || !EXTENSIONS.has(ext)) throw new Error('Invalid media key');
  if (path.posix.normalize(key) !== key) throw new Error('Invalid media key');
}

export function filenameForKey(key: string, prefix = 'generations'): string {
  validateObjectKey(key, prefix);
  return `lucidio-${key.split('/').at(-1) ?? 'generation'}`;
}

function sanitizeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!normalized) throw new Error('Invalid id for media key');
  return normalized;
}

function sanitizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..') || /^https?:\/\//i.test(normalized)) throw new Error('Invalid media prefix');
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
