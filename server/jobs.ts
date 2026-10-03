import type { GenerateStatusResponse, GenerationJobStatus, GenerationMedia, GenerationUsage } from './contracts.js';

type JobListener = () => void;

export interface JobRecord {
  id: string;
  status: GenerationJobStatus;
  progress?: { label: string; percent?: number };
  error?: string;
  result?: { media: GenerationMedia; usage?: GenerationUsage };
  createdAt: string;
  updatedAt: string;
  cancelled?: boolean;
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Map<string, Set<JobListener>>();

  create(): JobRecord {
    const now = new Date().toISOString();
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const job: JobRecord = { id, status: 'queued', progress: { label: 'Queued' }, createdAt: now, updatedAt: now };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): JobRecord | undefined { return this.jobs.get(id); }

  cancel(id: string): JobRecord {
    const existing = this.jobs.get(id);
    if (!existing) {
      const now = new Date().toISOString();
      const job: JobRecord = { id, status: 'cancelled', progress: { label: 'Cancelled' }, createdAt: now, updatedAt: now, cancelled: true };
      this.jobs.set(id, job);
      return job;
    }
    if (existing.status !== 'complete' && existing.status !== 'failed') this.patch(id, { status: 'cancelled', cancelled: true, progress: { label: 'Cancelled' } });
    return this.jobs.get(id)!;
  }

  patch(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): JobRecord {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Unknown job ${id}`);
    const job = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, job);
    this.notify(id);
    return job;
  }

  subscribe(id: string, listener: JobListener): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set<JobListener>();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  response(id: string): GenerateStatusResponse | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return {
      ok: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  private notify(id: string): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }
}
