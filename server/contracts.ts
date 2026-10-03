import type { CatalogValue } from './modelCatalog.js';

export type GenerationJobStatus = 'queued' | 'running' | 'uploading' | 'complete' | 'failed' | 'cancelled';
export type MediaProvider = 'byteplus-tos';
export type PresignPurpose = 'preview' | 'download';
export type PresignAssetRole = 'primary' | 'thumbnail';
export type GenerationMediaKind = 'image' | 'video' | 'audio';
export type GenerationMediaRole = 'primary' | 'thumbnail';
export type VideoReferenceIntent = 'image_reference' | 'first_frame' | 'last_frame' | 'source_video' | 'audio_reference' | 'sample_task';

export interface StoredMediaAsset {
  provider: MediaProvider;
  key: string;
  contentType: string;
  size: number;
  createdAt: string;
  kind?: GenerationMediaKind;
  role?: GenerationMediaRole;
  bucket?: string;
  region?: string;
  etag?: string;
  checksum?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface GenerationProviderTask {
  provider: 'byteplus' | 'gemini';
  taskId: string;
  modelId: string;
  completedAt?: string;
}

export interface GenerationMedia extends StoredMediaAsset {
  role?: 'primary';
  thumbnail?: StoredMediaAsset & { kind: 'image'; role: 'thumbnail' };
  providerTask?: GenerationProviderTask;
}

export interface GenerationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerationReferenceSelection {
  generationId: string;
  intent: VideoReferenceIntent;
}

export interface ReferenceMedia {
  id: string;
  intent?: VideoReferenceIntent;
  media: StoredMediaAsset;
  thumbnail?: StoredMediaAsset;
  providerTask?: GenerationProviderTask;
}

export interface GenerateRequest {
  mode: 'image' | 'video';
  modelId: string;
  prompt: string;
  ratio: string;
  res: string;
  length?: number;
  fps?: number;
  camera?: boolean;
  audio?: boolean;
  guidance?: number;
  seed?: number | '';
  params?: Record<string, CatalogValue>;
  references?: ReferenceMedia[];
  referenceSelections?: GenerationReferenceSelection[];
  projectId: string;
  sceneId: string | null;
}

export interface GenerateAcceptedResponse {
  ok: true;
  jobId: string;
  status: GenerationJobStatus;
}

export interface GenerateStatusResponse {
  ok: true;
  jobId: string;
  status: GenerationJobStatus;
  progress?: { label: string; percent?: number };
  error?: string;
  result?: { media: GenerationMedia; usage?: GenerationUsage };
  createdAt: string;
  updatedAt: string;
}

export interface PresignRequest {
  key: string;
  purpose: PresignPurpose;
  filename?: string;
  contentType?: string;
  ttlSeconds?: number;
  assetRole?: PresignAssetRole;
}

export interface ThumbnailRequest {
  key: string;
  contentType?: string;
  assetRole?: PresignAssetRole;
}

export interface PresignResponse {
  ok: true;
  url: string;
  expiresAt: string;
  contentType?: string;
  filename?: string;
}

export interface ApiErrorResponse {
  ok: false;
  error: string;
  details?: string;
  code?: string;
}

export function apiError(error: string, details?: string, code?: string): ApiErrorResponse {
  return Object.fromEntries(Object.entries({ ok: false, error, details, code }).filter(([, value]) => value !== undefined)) as unknown as ApiErrorResponse;
}
