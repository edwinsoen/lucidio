import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generationCompleteNotificationBody } from './notifications';

describe('generation notifications', () => {
  it('formats completion notification bodies', () => {
    assert.equal(generationCompleteNotificationBody({ jobId: 'job_1', mode: 'video' }), 'Video generation is ready.');
    assert.equal(generationCompleteNotificationBody({ jobId: 'job_2', mode: 'image', prompt: '  luminous   studio   frame  ' }), 'Image generation is ready: luminous studio frame');
    assert.match(generationCompleteNotificationBody({ jobId: 'job_3', prompt: 'x'.repeat(140) }), /^Your generation is ready: x+\.\.\.$/);
  });
});
