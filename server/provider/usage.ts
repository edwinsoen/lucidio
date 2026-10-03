import type { GenerationUsage } from '../contracts.js';

const INPUT_KEYS = ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens', 'promptTokenCount'];
const OUTPUT_KEYS = ['output_tokens', 'completion_tokens', 'generated_tokens', 'outputTokens', 'completionTokens', 'candidatesTokenCount'];
const TOTAL_KEYS = ['total_tokens', 'totalTokens', 'totalTokenCount'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return undefined;
}

/**
 * Normalize a provider `usage` payload into the shared { input, output, total } shape.
 * Field names vary across BytePlus image (output_tokens/total_tokens) and video
 * (completion_tokens/total_tokens) responses, and some responses omit usage entirely.
 * Returns undefined when no token counts are present so callers can skip metering.
 */
export function normalizeProviderUsage(raw: unknown): GenerationUsage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const input = firstNumber(record, INPUT_KEYS);
  const output = firstNumber(record, OUTPUT_KEYS);
  const total = firstNumber(record, TOTAL_KEYS);
  if (input === undefined && output === undefined && total === undefined) return undefined;

  const inputTokens = input ?? 0;
  const totalTokens = total ?? inputTokens + (output ?? 0);
  const outputTokens = output ?? Math.max(totalTokens - inputTokens, 0);
  return { inputTokens, outputTokens, totalTokens };
}
