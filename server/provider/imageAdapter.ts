import type { CatalogValue, ModelCatalogEntry } from '../modelCatalog.js';
import type { GenerationUsage } from '../contracts.js';

export interface ImageReferenceInput { id: string; url: string }
export interface ImageGenerationInput {
  model: ModelCatalogEntry;
  endpointId: string;
  prompt: string;
  params: Record<string, CatalogValue>;
  references: ImageReferenceInput[];
}
export interface ImageGenerationResult {
  bytes: Buffer;
  contentType: string;
  usage?: GenerationUsage;
}
export interface ImageGenerationAdapter {
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
