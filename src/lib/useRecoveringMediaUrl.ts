import { useCallback, useRef, useState } from 'react';
import type { Generation, PresignAssetRole } from '../types';
import type { MediaPurpose, ResolveMediaUrl } from '../app/useMediaUrls';

const RETRY_COOLDOWN_MS = 30_000;

export function shouldRetryMedia(assetKey: string, lastRetry: { key: string; at: number } | null, now: number): boolean {
  return lastRetry?.key !== assetKey || now - lastRetry.at >= RETRY_COOLDOWN_MS;
}

/** Hide a failed media element and request one fresh URL for this asset. */
export function useRecoveringMediaUrl(
  generation: Generation,
  url: string | undefined,
  purpose: Exclude<MediaPurpose, 'download'>,
  role: PresignAssetRole,
  resolve: ResolveMediaUrl
) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const lastRetry = useRef<{ key: string; at: number } | null>(null);
  const assetKey = role === 'thumbnail' ? generation.media?.thumbnail?.key ?? generation.media?.key : generation.media?.key;
  const onError = useCallback(() => {
    if (!url || !assetKey) return;
    setFailedUrl(url);
    const now = Date.now();
    if (!shouldRetryMedia(assetKey, lastRetry.current, now)) return;
    lastRetry.current = { key: assetKey, at: now };
    void resolve(generation, purpose, role, true).catch(() => undefined);
  }, [assetKey, generation, purpose, resolve, role, url]);
  return { visibleUrl: url === failedUrl ? undefined : url, onError };
}
