import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTokens } from './usageMeter';

test('formats small counts verbatim', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(129), '129');
  assert.equal(formatTokens(999), '999');
});

test('formats thousands with a trimmed k suffix', () => {
  assert.equal(formatTokens(129_000), '129k');
  assert.equal(formatTokens(1_234), '1.2k');
});

test('formats millions with a trimmed M suffix', () => {
  assert.equal(formatTokens(14_400_000), '14.4M');
  assert.equal(formatTokens(2_000_000), '2M');
});

test('formats billions and guards against invalid input', () => {
  assert.equal(formatTokens(3_500_000_000), '3.5B');
  assert.equal(formatTokens(-10), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});
