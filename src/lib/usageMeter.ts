import type { OutputMode } from '../types';
import { listUsageRecords, saveUsageRecord } from './idb';

export interface UsageRecord {
  jobId: string;
  modelId: string;
  mode: OutputMode;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface ModelUsageSummary {
  modelId: string;
  mode: OutputMode;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  count: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  count: number;
  models: ModelUsageSummary[];
}

// Client-side usage metering. Each completed generation is persisted to IndexedDB
// keyed by jobId (idempotent), and aggregated into a summary the header renders.
const records = new Map<string, UsageRecord>();
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;
let snapshot: UsageSummary = emptySummary();

function emptySummary(): UsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0, models: [] };
}

function recompute(): void {
  const byModel = new Map<string, ModelUsageSummary>();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const record of records.values()) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    totalTokens += record.totalTokens;
    const existing = byModel.get(record.modelId) ?? { modelId: record.modelId, mode: record.mode, inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
    existing.inputTokens += record.inputTokens;
    existing.outputTokens += record.outputTokens;
    existing.totalTokens += record.totalTokens;
    existing.count += 1;
    byModel.set(record.modelId, existing);
  }
  const models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  snapshot = { inputTokens, outputTokens, totalTokens, count: records.size, models };
}

function emit(): void {
  recompute();
  for (const listener of [...listeners]) listener();
}

export function ensureUsageLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = listUsageRecords()
      .then((rows) => {
        for (const row of rows) if (row?.jobId) records.set(row.jobId, row);
        recompute();
      })
      .catch(() => undefined);
  }
  return loadPromise;
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  await ensureUsageLoaded();
  if (records.has(record.jobId)) return;
  records.set(record.jobId, record);
  emit();
  try {
    await saveUsageRecord(record);
  } catch {
    // Metering is best-effort; a failed persist still counts for this session.
  }
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  void ensureUsageLoaded().then(() => listener());
  return () => { listeners.delete(listener); };
}

export function getUsageSnapshot(): UsageSummary {
  return snapshot;
}

function trimTokens(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${trimTokens(value / 1_000)}k`;
  if (value < 1_000_000_000) return `${trimTokens(value / 1_000_000)}M`;
  return `${trimTokens(value / 1_000_000_000)}B`;
}
