export type OutputMode = 'image' | 'video';

export type CatalogPrimitive = string | number | boolean | null;
export type CatalogValue = CatalogPrimitive | CatalogValue[] | { [key: string]: CatalogValue };

export interface SourceDoc {
  title: string;
  url: string;
  lastReviewed: string;
}

export interface ParameterDescriptor {
  name: string;
  type: string;
  required?: boolean;
  default?: CatalogValue;
  enum?: CatalogValue[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  maxRecommendedWords?: number;
  supportsIntelligent?: number;
  stepRule?: string;
  notes?: string;
}

export interface ModelCapabilities {
  tasks: string[];
  resolutions?: string[];
  aspectRatios?: string[];
  frameRates?: number[];
  durationSeconds?: { minimum: number; maximum: number; intelligent?: number };
  referenceIntents?: VideoReferenceIntent[];
  outputFormats?: string[];
  responseFormats?: string[];
  videoFormat?: string;
  maxReferenceImages?: number;
  maxOutputImages?: number;
  audio?: boolean;
  draft?: boolean;
  serviceTiers?: string[];
}

export type ModelProvider = 'byteplus' | 'gemini';
export type ModelFamily = 'seedream' | 'seedance' | 'nano-banana' | 'veo' | 'omni-flash';

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  provider: ModelProvider;
  family: ModelFamily;
  modality: OutputMode;
  endpoint: string;
  description: string;
  capabilities: ModelCapabilities;
  parameters: ParameterDescriptor[];
}

export interface ModelCatalog {
  provider: ModelProvider;
  updated: string;
  sourceDocs: SourceDoc[];
  notes?: string[];
  models: ModelCatalogEntry[];
}

export interface ModelsResponse extends ModelCatalog {
  ok: true;
  count: number;
}

export interface ModelCatalogCache {
  catalog: ModelCatalog;
  cachedAt: string;
}

export interface ModelOption {
  id: string;
  name: string;
  mode: OutputMode;
  tag: string;
  caps: {
    res: string[];
    guidance?: boolean;
    len?: [number, number];
    fps?: number[];
    camera?: boolean;
    audio?: boolean;
  };
}

export interface GenerationControls {
  mode: OutputMode;
  modelId: string;
  prompt: string;
  ratio: string;
  res: string;
  length: number;
  fps: number;
  camera: boolean;
  audio: boolean;
  guidance: number;
  seed: number | '';
  params: Record<string, CatalogValue>;
}

export type GenerationStatus = 'local' | 'queued' | 'running' | 'uploading' | 'complete' | 'cancelled' | 'failed';

export type GenerationMediaKind = 'image' | 'video' | 'audio';
export type GenerationMediaRole = 'primary' | 'thumbnail';
export type VideoReferenceIntent = 'image_reference' | 'first_frame' | 'last_frame' | 'source_video' | 'audio_reference' | 'sample_task';
export type PresignAssetRole = 'primary' | 'thumbnail';

export interface StoredMediaAsset {
  provider: 'byteplus-tos';
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

export interface GenerationProgress {
  label: string;
  percent?: number;
}

export interface Generation {
  id: string;
  type: OutputMode;
  prompt: string;
  modelId: string;
  ratio: string;
  res: string;
  length: number;
  fps: number;
  camera: boolean;
  audio: boolean;
  guidance: number;
  seed: number | '';
  params?: Record<string, CatalogValue>;
  pal: number;
  preferred?: boolean;
  jobId?: string;
  status?: GenerationStatus;
  progress?: GenerationProgress;
  error?: string;
  media?: GenerationMedia;
  createdAt: string;
}

export interface Scene {
  id: string;
  name: string;
  gens: Generation[];
}

export interface Project {
  id: string;
  name: string;
  accent: string;
  scenes: Scene[];
}

export interface UploadedReference {
  id: string;
  projectId: string;
  name: string;
  media: StoredMediaAsset;
}

export interface AppState {
  version: 1;
  seq: number;
  projects: Project[];
  activeProjectId: string | null;
  activeSceneId: string | null;
  refIds: string[];
  uploadedReferences?: UploadedReference[];
  referenceSelections?: GenerationReferenceSelection[];
  ctl: GenerationControls;
}
