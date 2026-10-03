import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generationFailureDetail, storedMediaAssetPayload } from './generationMedia';
import type { GenerationMedia } from '../types';

describe('generation media helpers', () => {
  it('strips nested video-only fields from stored media reference payloads', () => {
    const media: GenerationMedia = {
      provider: 'byteplus-tos',
      key: 'generations/job_123/0123456789abcdef01234567-video_ref.mp4',
      contentType: 'video/mp4',
      size: 20,
      createdAt: '2026-07-04T00:00:00.000Z',
      kind: 'video',
      role: 'primary',
      thumbnail: {
        provider: 'byteplus-tos',
        key: 'generations/job_123/0123456789abcdef01234567-video_ref_thumb.jpeg',
        contentType: 'image/jpeg',
        size: 10,
        createdAt: '2026-07-04T00:00:00.000Z',
        kind: 'image',
        role: 'thumbnail'
      },
      providerTask: {
        provider: 'byteplus',
        taskId: 'task-reference',
        modelId: 'seedance-test',
        completedAt: '2026-07-04T00:00:00.000Z'
      }
    };

    assert.deepEqual(Object.keys(storedMediaAssetPayload(media)).sort(), [
      'contentType',
      'createdAt',
      'key',
      'kind',
      'provider',
      'role',
      'size'
    ]);
    assert.equal('thumbnail' in storedMediaAssetPayload(media), false);
    assert.equal('providerTask' in storedMediaAssetPayload(media), false);
  });

  it('shows vendor failure messages without provider ids', () => {
    assert.equal(
      generationFailureDetail({
        type: 'video',
        error: 'Error: BytePlus video task failed: Prompt violates the content policy. Request ID: req_123 task_id=task_456'
      }),
      'Prompt violates the content policy'
    );
  });
});
