import { useCallback, useEffect, useRef, useState } from 'react';
import type { Generation, PresignAssetRole } from '../types';
import { api } from '../lib/api';
import { generationFilename, mediaAssetForRole, mediaUrlCacheKey } from '../lib/generationMedia';
import { readCachedThumbnail, writeCachedThumbnail } from '../lib/thumbnailCache';
import type { UiAction } from '../state/uiReducer';

export type MediaPurpose = 'thumbnail' | 'preview' | 'download';
export type MediaUrlCache = Record<string, { url: string; expiresAt?: string; key: string; role: PresignAssetRole; purpose: Exclude<MediaPurpose, 'download'> }>;

export function useMediaUrls(dispatchUi: React.Dispatch<UiAction>) {
  const [mediaUrls, setMediaUrls] = useState<MediaUrlCache>({});
  const mediaUrlsRef = useRef<MediaUrlCache>({});
  const objectUrlsRef = useRef(new Map<string, string>());
  const thumbnailRequestsRef = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => () => {
    for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
  }, []);

  const setCacheEntry = useCallback((cacheKey: string, entry: MediaUrlCache[string]) => {
    setMediaUrls((current) => {
      const next = { ...current, [cacheKey]: entry };
      mediaUrlsRef.current = next;
      return next;
    });
  }, []);

  const rememberObjectUrl = useCallback((cacheKey: string, blob: Blob) => {
    const previous = objectUrlsRef.current.get(cacheKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.set(cacheKey, url);
    return url;
  }, []);

  const ensureMediaUrl = useCallback(async (generation: Generation, purpose: MediaPurpose = 'preview', role: PresignAssetRole = 'primary') => {
    const asset = mediaAssetForRole(generation, role);
    if (!asset) return null;
    const cacheKey = mediaUrlCacheKey(generation, role, purpose);
    const cached = mediaUrlsRef.current[cacheKey];
    if (purpose === 'thumbnail') {
      if (cached?.key === asset.key && cached.purpose === 'thumbnail') return cached.url;
      const existing = thumbnailRequestsRef.current.get(cacheKey);
      if (existing) return existing;
      const request = (async () => {
        try {
          const local = await readCachedThumbnail(asset);
          if (local) {
            const url = rememberObjectUrl(cacheKey, local);
            setCacheEntry(cacheKey, { url, key: asset.key, role, purpose: 'thumbnail' });
            return url;
          }
          const blob = await api.thumbnail({ key: asset.key, contentType: asset.contentType, assetRole: role });
          void writeCachedThumbnail(asset, blob).catch(() => undefined);
          const url = rememberObjectUrl(cacheKey, blob);
          setCacheEntry(cacheKey, { url, key: asset.key, role, purpose: 'thumbnail' });
          return url;
        } catch {
          const signed = await api.presign({ key: asset.key, purpose: 'preview', filename: generationFilename(generation), contentType: asset.contentType, assetRole: role });
          setCacheEntry(cacheKey, { url: signed.url, expiresAt: signed.expiresAt, key: asset.key, role, purpose: 'thumbnail' });
          return signed.url;
        } finally {
          thumbnailRequestsRef.current.delete(cacheKey);
        }
      })();
      thumbnailRequestsRef.current.set(cacheKey, request);
      return request;
    }
    if (purpose === 'preview' && cached?.key === asset.key && cached.expiresAt && Date.parse(cached.expiresAt) - Date.now() > 60_000) return cached.url;
    const signed = await api.presign({ key: asset.key, purpose, filename: generationFilename(generation), contentType: asset.contentType, assetRole: role });
    if (purpose === 'preview') setCacheEntry(cacheKey, { url: signed.url, expiresAt: signed.expiresAt, key: asset.key, role, purpose: 'preview' });
    return signed.url;
  }, [rememberObjectUrl, setCacheEntry]);

  const download = useCallback(async (generation: Generation) => {
    if (generation.media) {
      try {
        const url = await ensureMediaUrl(generation, 'download');
        if (!url) return;
        const link = document.createElement('a');
        link.href = url;
        link.download = generationFilename(generation);
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        dispatchUi({ type: 'api-status', apiStatus: `Download started for ${generationFilename(generation)}` });
        return;
      } catch (error) {
        dispatchUi({ type: 'api-status', apiStatus: `Download failed (${error instanceof Error ? error.message : 'unknown error'})` });
        return;
      }
    }
    dispatchUi({ type: 'api-status', apiStatus: 'No object-storage media is available for this generation.' });
  }, [dispatchUi, ensureMediaUrl]);

  return { mediaUrls, ensureMediaUrl, download };
}
