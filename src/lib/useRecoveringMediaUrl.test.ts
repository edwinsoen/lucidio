import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shouldRetryMedia } from './useRecoveringMediaUrl';

it('retries a failed asset once, then backs off until the cooldown expires', () => {
  const now = Date.now();
  assert.equal(shouldRetryMedia('image-a', null, now), true);
  assert.equal(shouldRetryMedia('image-a', { key: 'image-a', at: now }, now + 100), false);
  assert.equal(shouldRetryMedia('image-b', { key: 'image-a', at: now }, now + 100), true);
  assert.equal(shouldRetryMedia('image-a', { key: 'image-a', at: now }, now + 30_000), true);
});
