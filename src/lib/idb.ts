import type { AppState, ModelCatalogCache } from '../types';
import type { ThumbnailCacheRecord } from './thumbnailCache';
import type { UsageRecord } from './usageMeter';

const DB_NAME = 'lucidio-studio';
const DB_VERSION = 1;
const STORE = 'kv';
const STATE_KEY = 'app-state';
const MODEL_CATALOG_KEY = 'model-catalog';
const THUMBNAIL_PREFIX = 'thumbnail-cache:v1:';
const USAGE_PREFIX = 'usage-meter:v1:';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function putValue<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteValue(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function listValuesByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const values: Array<{ key: string; value: T }> = [];
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) values.push({ key: cursor.key, value: cursor.value as T });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => { db.close(); resolve(values); };
  });
}

export function loadState(): Promise<AppState | null> {
  return getValue<AppState>(STATE_KEY);
}

export function saveState(state: AppState): Promise<void> {
  return putValue(STATE_KEY, state);
}

export function loadModelCatalogCache(): Promise<ModelCatalogCache | null> {
  return getValue<ModelCatalogCache>(MODEL_CATALOG_KEY);
}

export function saveModelCatalogCache(cache: ModelCatalogCache): Promise<void> {
  return putValue(MODEL_CATALOG_KEY, cache);
}

export function thumbnailCacheStorageKey(cacheKey: string): string {
  return `${THUMBNAIL_PREFIX}${cacheKey}`;
}

export function loadThumbnailCacheRecord(cacheKey: string): Promise<ThumbnailCacheRecord | null> {
  return getValue<ThumbnailCacheRecord>(thumbnailCacheStorageKey(cacheKey));
}

export function saveThumbnailCacheRecord(record: ThumbnailCacheRecord): Promise<void> {
  return putValue(thumbnailCacheStorageKey(record.cacheKey), record);
}

export function deleteThumbnailCacheRecord(cacheKey: string): Promise<void> {
  return deleteValue(thumbnailCacheStorageKey(cacheKey));
}

export function listThumbnailCacheRecords(): Promise<Array<{ key: string; value: ThumbnailCacheRecord }>> {
  return listValuesByPrefix<ThumbnailCacheRecord>(THUMBNAIL_PREFIX);
}

export function saveUsageRecord(record: UsageRecord): Promise<void> {
  return putValue(`${USAGE_PREFIX}${record.jobId}`, record);
}

export async function listUsageRecords(): Promise<UsageRecord[]> {
  const rows = await listValuesByPrefix<UsageRecord>(USAGE_PREFIX);
  return rows.map((row) => row.value);
}
