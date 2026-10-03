import type { CatalogValue, ModelCatalogEntry } from '../modelCatalog.js';
import type { GenerationMediaKind, GenerationUsage, VideoReferenceIntent } from '../contracts.js';

export class VideoProviderError extends Error {
  constructor(readonly publicMessage: string, options?: ErrorOptions) {
    super(publicMessage, options);
    this.name = 'VideoProviderError';
  }
}

export interface VideoReferenceInput {
  generationId: string;
  intent: VideoReferenceIntent;
  url: string;
  contentType: string;
  kind: GenerationMediaKind;
  providerTask?: { provider: 'byteplus' | 'gemini'; taskId: string; modelId: string };
}

export interface VideoGenerationInput {
  model: ModelCatalogEntry;
  endpointId: string;
  prompt: string;
  params: Record<string, CatalogValue>;
  references: VideoReferenceInput[];
  signal?: AbortSignal;
  onTaskCreated?: (taskId: string) => void;
}

export interface VideoGenerationResult {
  video: { bytes: Buffer; contentType: 'video/mp4'; durationSeconds?: number };
  thumbnail: { bytes: Buffer; contentType: 'image/jpeg' | 'image/png' | 'image/webp'; width?: number; height?: number };
  providerTask: { provider: 'byteplus' | 'gemini'; taskId: string; modelId: string; completedAt?: string };
  usage?: GenerationUsage;
}

export interface VideoGenerationAdapter {
  generate(input: VideoGenerationInput): Promise<VideoGenerationResult>;
  cancel?(taskId: string): Promise<void>;
}
