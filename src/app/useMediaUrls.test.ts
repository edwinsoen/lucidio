import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mediaUrlFromCache, type MediaUrlCache } from './useMediaUrls';

it('ignores expired signed preview and thumbnail URLs while keeping local blob URLs', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const cache: MediaUrlCache = {
    oldThumbnail: { url: 'https://example.test/old', expiresAt: new Date(now - 1).toISOString(), key: 'old', role: 'primary', purpose: 'thumbnail' },
    nearExpiry: { url: 'https://example.test/near', expiresAt: new Date(now + 5_000).toISOString(), key: 'near', role: 'primary', purpose: 'preview' },
    fresh: { url: 'https://example.test/fresh', expiresAt: new Date(now + 120_000).toISOString(), key: 'fresh', role: 'primary', purpose: 'preview' },
    local: { url: 'blob:local-thumbnail', key: 'local', role: 'primary', purpose: 'thumbnail' }
  };
  assert.equal(mediaUrlFromCache(cache, 'oldThumbnail', now), undefined);
  assert.equal(mediaUrlFromCache(cache, 'nearExpiry', now), undefined);
  assert.equal(mediaUrlFromCache(cache, 'fresh', now), 'https://example.test/fresh');
  assert.equal(mediaUrlFromCache(cache, 'local', now), 'blob:local-thumbnail');
});
