import type { Generation, StoredMediaAsset } from '../types';
import { deleteThumbnailCacheRecord, listThumbnailCacheRecords, loadThumbnailCacheRecord, saveThumbnailCacheRecord } from './idb';

const CACHE_VERSION = 1;
const MAX_THUMBNAILS = 300;
const MAX_CACHE_BYTES = 80 * 1024 * 1024;

export interface ThumbnailCacheRecord {
  version: 1;
  cacheKey: string;
  sourceKey: string;
  sourceContentType: string;
  sourceSize: number;
  sourceEtag?: string;
  blob: Blob;
  size: number;
  createdAt: string;
  lastAccessedAt: string;
}

export function thumbnailCacheKey(asset: StoredMediaAsset): string {
  return [
    CACHE_VERSION,
    asset.provider,
    asset.key,
    asset.contentType,
    String(asset.size),
    asset.etag ?? ''
  ].join('|');
}

export async function readCachedThumbnail(asset: StoredMediaAsset): Promise<Blob | null> {
  const cacheKey = thumbnailCacheKey(asset);
  const record = await loadThumbnailCacheRecord(cacheKey);
  if (!isRecordForAsset(record, asset)) return null;
  void saveThumbnailCacheRecord({ ...record, lastAccessedAt: new Date().toISOString() }).catch(() => undefined);
  return record.blob;
}

export async function writeCachedThumbnail(asset: StoredMediaAsset, blob: Blob): Promise<void> {
  const now = new Date().toISOString();
  await saveThumbnailCacheRecord({
    version: CACHE_VERSION,
    cacheKey: thumbnailCacheKey(asset),
    sourceKey: asset.key,
    sourceContentType: asset.contentType,
    sourceSize: asset.size,
    sourceEtag: asset.etag,
    blob,
    size: blob.size,
    createdAt: now,
    lastAccessedAt: now
  });
  await pruneThumbnailCache();
}

export async function deleteGenerationThumbnails(generation: Generation | null | undefined): Promise<void> {
  if (!generation?.media) return;
  const assets: StoredMediaAsset[] = [];
  if (generation.media.contentType.startsWith('image/')) assets.push(generation.media);
  if (generation.media.thumbnail?.contentType.startsWith('image/')) assets.push(generation.media.thumbnail);
  await Promise.allSettled(assets.map((asset) => deleteThumbnailCacheRecord(thumbnailCacheKey(asset))));
}

async function pruneThumbnailCache(): Promise<void> {
  const records = await listThumbnailCacheRecords();
  let totalBytes = records.reduce((total, item) => total + (Number.isFinite(item.value.size) ? item.value.size : item.value.blob?.size ?? 0), 0);
  const sorted = records
    .slice()
    .sort((a, b) => Date.parse(a.value.lastAccessedAt || a.value.createdAt) - Date.parse(b.value.lastAccessedAt || b.value.createdAt));
  while (sorted.length > MAX_THUMBNAILS || totalBytes > MAX_CACHE_BYTES) {
    const item = sorted.shift();
    if (!item) break;
    totalBytes -= Number.isFinite(item.value.size) ? item.value.size : item.value.blob?.size ?? 0;
    await deleteThumbnailCacheRecord(item.value.cacheKey);
  }
}

function isRecordForAsset(record: ThumbnailCacheRecord | null, asset: StoredMediaAsset): record is ThumbnailCacheRecord {
  return Boolean(
    record &&
    record.version === CACHE_VERSION &&
    record.sourceKey === asset.key &&
    record.sourceContentType === asset.contentType &&
    record.sourceSize === asset.size &&
    record.sourceEtag === asset.etag &&
    record.blob instanceof Blob
  );
}
