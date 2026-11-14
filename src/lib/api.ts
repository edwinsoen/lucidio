import type { GenerationControls, GenerationMedia, GenerationProgress, GenerationReferenceSelection, GenerationStatus, GenerationUsage, ModelsResponse, PresignAssetRole, ReferenceMedia, StoredMediaAsset } from '../types';

export interface GenerateResponse { ok: boolean; jobId: string; status: GenerationStatus; }
export interface GenerateStatusResponse {
  ok: true;
  jobId: string;
  status: GenerationStatus;
  progress?: GenerationProgress;
  error?: string;
  result?: { media: GenerationMedia; usage?: GenerationUsage };
  createdAt: string;
  updatedAt: string;
}
export interface PresignResponse { ok: true; url: string; expiresAt: string; contentType?: string; filename?: string; }
export interface ApiErrorPayload { ok?: false; error?: string; details?: string; code?: string; }

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const method = init?.method ?? 'GET';
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No HTTP response from ${method} ${url}: ${message}. Check that the API server is running and that the Vite proxy can reach it.`);
  }
  if (!res.ok) {
    let payload: ApiErrorPayload | null = null;
    try { payload = await res.json() as ApiErrorPayload; } catch { payload = null; }
    const message = payload?.details ? `${payload.error ?? res.statusText}: ${payload.details}` : payload?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function blobFetch(url: string, init?: RequestInit): Promise<Blob> {
  let res: Response;
  const method = init?.method ?? 'GET';
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No HTTP response from ${method} ${url}: ${message}. Check that the API server is running and that the Vite proxy can reach it.`);
  }
  if (!res.ok) {
    let payload: ApiErrorPayload | null = null;
    try { payload = await res.json() as ApiErrorPayload; } catch { payload = null; }
    const message = payload?.details ? `${payload.error ?? res.statusText}: ${payload.details}` : payload?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return res.blob();
}

export const api = {
  login(name = 'Anonymous') {
    return jsonFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ name }) });
  },
  logout() {
    return jsonFetch('/api/auth/logout', { method: 'POST' });
  },
  models() {
    return jsonFetch<ModelsResponse>('/api/models');
  },
  async uploadReference(modelId: string, file: File): Promise<StoredMediaAsset> {
    let response: Response;
    try {
      response = await fetch(`/api/references/upload?modelId=${encodeURIComponent(modelId)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    } catch (error) {
      throw new Error(`Reference upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = await response.json() as { ok?: boolean; media?: StoredMediaAsset; error?: string; details?: string };
    if (!response.ok || !payload.media) throw new Error(payload.details ? `${payload.error ?? 'Upload failed'}: ${payload.details}` : payload.error ?? `Upload failed (${response.status})`);
    return payload.media;
  },
  generate(payload: GenerationControls & { references: ReferenceMedia[]; referenceSelections?: GenerationReferenceSelection[]; projectId: string; sceneId: string | null }) {
    return jsonFetch<GenerateResponse>('/api/generate', { method: 'POST', body: JSON.stringify(payload) });
  },
  cancel(jobId: string) {
    return jsonFetch<GenerateResponse>(`/api/generate/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  },
  status(jobId: string) {
    return jsonFetch<GenerateStatusResponse>(`/api/generate/${encodeURIComponent(jobId)}/status`);
  },
  eventsUrl(jobId: string) {
    return `/api/generate/${encodeURIComponent(jobId)}/events`;
  },
  presign(payload: { key: string; purpose: 'preview' | 'download'; filename?: string; contentType?: string; assetRole?: PresignAssetRole }) {
    return jsonFetch<PresignResponse>('/api/media/presign', { method: 'POST', body: JSON.stringify(payload) });
  },
  thumbnail(payload: { key: string; contentType?: string; assetRole?: PresignAssetRole }) {
    return blobFetch('/api/media/thumbnail', { method: 'POST', body: JSON.stringify(payload) });
  }
};
