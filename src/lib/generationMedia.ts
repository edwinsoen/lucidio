import type { Generation, GenerationStatus, PresignAssetRole, StoredMediaAsset } from '../types';

const allowedProgressLabels = new Set([
  'Creating task',
  'Queued',
  'Generating image',
  'Generating video',
  'Saving image',
  'Saving video',
  'Failed to generate image',
  'Failed to generate video'
]);

export function isImageAsset(asset: StoredMediaAsset | undefined): boolean {
  return Boolean(asset?.contentType.toLowerCase().startsWith('image/'));
}

export function isVideoAsset(asset: StoredMediaAsset | undefined): boolean {
  return asset?.contentType.toLowerCase() === 'video/mp4';
}

export function mediaAssetForRole(generation: Generation, role: PresignAssetRole): StoredMediaAsset | undefined {
  if (!generation.media) return undefined;
  if (role === 'primary') return generation.media;
  return generation.media.thumbnail ?? (isImageAsset(generation.media) ? generation.media : undefined);
}

export function storedMediaAssetPayload(asset: StoredMediaAsset): StoredMediaAsset {
  const payload: StoredMediaAsset = {
    provider: asset.provider,
    key: asset.key,
    contentType: asset.contentType,
    size: asset.size,
    createdAt: asset.createdAt
  };
  if (asset.kind !== undefined) payload.kind = asset.kind;
  if (asset.role !== undefined) payload.role = asset.role;
  if (asset.bucket !== undefined) payload.bucket = asset.bucket;
  if (asset.region !== undefined) payload.region = asset.region;
  if (asset.etag !== undefined) payload.etag = asset.etag;
  if (asset.checksum !== undefined) payload.checksum = asset.checksum;
  if (asset.width !== undefined) payload.width = asset.width;
  if (asset.height !== undefined) payload.height = asset.height;
  if (asset.durationSeconds !== undefined) payload.durationSeconds = asset.durationSeconds;
  return payload;
}

export function previewAssetRole(generation: Generation): PresignAssetRole {
  return generation.type === 'video' && generation.media?.thumbnail ? 'thumbnail' : 'primary';
}

export function mediaUrlCacheKey(generation: Generation, role: PresignAssetRole, purpose: 'thumbnail' | 'preview' | 'download' = 'preview'): string {
  const asset = mediaAssetForRole(generation, role);
  return `${generation.id}:${purpose}:${role}:${asset?.key ?? 'none'}:${asset?.contentType ?? 'none'}:${asset?.size ?? 0}:${asset?.etag ?? ''}`;
}

export function generationStatusLabel(status: GenerationStatus | undefined): string {
  if (!status || status === 'local') return 'Local';
  return status[0].toUpperCase() + status.slice(1);
}

export function generationFailureLabel(generation: Pick<Generation, 'type'>): string {
  return `Failed to generate ${generation.type}`;
}

export function generationFailureDetail(generation: Pick<Generation, 'type' | 'error'>): string {
  return sanitizeGenerationErrorDetail(generation.error) || generationFailureLabel(generation);
}

export function sanitizeGenerationErrorDetail(error: string | undefined): string {
  if (!error?.trim()) return '';
  return error
    .trim()
    .replace(/^Error:\s*/i, '')
    .replace(/^BytePlus\s+video\s+task\s+failed:\s*/i, '')
    .replace(/^Failed to generate (?:image|video)$/i, '')
    .replace(/\b(?:request|trace|task|job|log|event|session)[\s_-]*id\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\b(?:requestId|traceId|taskId|jobId|logId|eventId|sessionId)\b\s*(?:[:=]|\s+)\s*["']?[A-Za-z0-9][A-Za-z0-9._:-]*["']?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:.-]+$/g, '')
    .trim();
}

export function generationProgressLabel(generation: Pick<Generation, 'type' | 'status' | 'progress'>): string {
  if (generation.status === 'queued') return 'Queued';
  if (generation.status === 'uploading') return `Saving ${generation.type}`;
  if (generation.status === 'failed') return generationFailureLabel(generation);
  if (generation.status === 'running') {
    const label = generation.progress?.label;
    if (label && allowedProgressLabels.has(label)) return label;
    return `Generating ${generation.type}`;
  }
  return generationStatusLabel(generation.status);
}

export function generationFilename(generation: Generation): string {
  const ext = generation.media?.contentType === 'video/mp4' ? 'mp4' : generation.media?.contentType === 'image/png' ? 'png' : generation.media?.contentType === 'image/webp' ? 'webp' : 'jpg';
  return `lucidio_${generation.modelId || generation.type}_${generation.seed || generation.id}.${ext}`;
}
