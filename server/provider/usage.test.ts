import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProviderUsage } from './usage.js';

test('normalizes BytePlus image usage (output + total, no input)', () => {
  const usage = normalizeProviderUsage({ generated_images: 1, output_tokens: 4096, total_tokens: 4096 });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 4096, totalTokens: 4096 });
});

test('normalizes BytePlus video usage (completion + total)', () => {
  const usage = normalizeProviderUsage({ completion_tokens: 1_200_000, total_tokens: 1_200_000 });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 1_200_000, totalTokens: 1_200_000 });
});

test('derives output from total minus input when output is absent', () => {
  const usage = normalizeProviderUsage({ prompt_tokens: 30, total_tokens: 100 });
  assert.deepEqual(usage, { inputTokens: 30, outputTokens: 70, totalTokens: 100 });
});

test('derives total when only input and output are present', () => {
  const usage = normalizeProviderUsage({ input_tokens: 12, output_tokens: 88 });
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 88, totalTokens: 100 });
});

test('normalizes Gemini usageMetadata token counts', () => {
  const usage = normalizeProviderUsage({ promptTokenCount: 40, candidatesTokenCount: 120, totalTokenCount: 160 });
  assert.deepEqual(usage, { inputTokens: 40, outputTokens: 120, totalTokens: 160 });
});

test('returns undefined when no token fields are present', () => {
  assert.equal(normalizeProviderUsage({ generated_images: 2 }), undefined);
  assert.equal(normalizeProviderUsage(null), undefined);
  assert.equal(normalizeProviderUsage('nope'), undefined);
});

test('ignores negative or non-finite counts', () => {
  const usage = normalizeProviderUsage({ output_tokens: -5, total_tokens: 500 });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 500, totalTokens: 500 });
});
