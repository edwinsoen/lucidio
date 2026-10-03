import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export class CatalogError extends Error {
  constructor(message: string, public readonly details?: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

type JsonPrimitive = string | number | boolean | null;
export type CatalogValue = JsonPrimitive | CatalogValue[] | { [key: string]: CatalogValue };

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
  referenceIntents?: Array<'image_reference' | 'first_frame' | 'last_frame' | 'source_video' | 'audio_reference' | 'sample_task'>;
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

const MODEL_PROVIDERS = new Set<ModelProvider>(['byteplus', 'gemini']);
const MODEL_FAMILIES = new Set<ModelFamily>(['seedream', 'seedance', 'nano-banana', 'veo', 'omni-flash']);

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  provider: ModelProvider;
  family: ModelFamily;
  modality: 'image' | 'video';
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

const catalogPath = path.resolve(process.cwd(), 'server/model-catalog.yaml');

export function loadModelCatalog(filePath = catalogPath): ModelCatalog {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CatalogError('Unable to read model catalog YAML', errorMessage(error));
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new CatalogError('Unable to parse model catalog YAML', errorMessage(error));
  }

  return validateCatalog(parsed);
}

export function loadModelsResponse(): ModelsResponse {
  const catalog = loadModelCatalog();
  return { ok: true, count: catalog.models.length, ...catalog };
}

function validateCatalog(value: unknown): ModelCatalog {
  const root = asRecord(value, 'catalog root');
  const provider = requiredString(root, 'provider');
  if (!MODEL_PROVIDERS.has(provider as ModelProvider)) throw new CatalogError('Invalid model catalog', `provider must be one of ${[...MODEL_PROVIDERS].join(', ')}`);

  const updated = requiredString(root, 'updated');
  const sourceDocs = requiredArray(root, 'sourceDocs').map((item, index) => validateSourceDoc(item, `sourceDocs[${index}]`));
  const models = requiredArray(root, 'models').map((item, index) => validateModel(item, `models[${index}]`));
  if (models.length === 0) throw new CatalogError('Invalid model catalog', 'models must contain at least one entry');

  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new CatalogError('Invalid model catalog', `duplicate model id ${model.id}`);
    seen.add(model.id);
  }

  const notes = optionalStringArray(root, 'notes');
  return { provider: provider as ModelProvider, updated, sourceDocs, notes, models };
}

function validateSourceDoc(value: unknown, label: string): SourceDoc {
  const doc = asRecord(value, label);
  return {
    title: requiredString(doc, `${label}.title`),
    url: requiredString(doc, `${label}.url`),
    lastReviewed: requiredString(doc, `${label}.lastReviewed`)
  };
}

function validateModel(value: unknown, label: string): ModelCatalogEntry {
  const model = asRecord(value, label);
  const provider = model.provider === undefined ? 'byteplus' : requiredString(model, `${label}.provider`);
  if (!MODEL_PROVIDERS.has(provider as ModelProvider)) throw new CatalogError('Invalid model catalog', `${label}.provider must be one of ${[...MODEL_PROVIDERS].join(', ')}`);
  const family = requiredString(model, `${label}.family`);
  if (!MODEL_FAMILIES.has(family as ModelFamily)) throw new CatalogError('Invalid model catalog', `${label}.family must be one of ${[...MODEL_FAMILIES].join(', ')}`);
  const modality = requiredString(model, `${label}.modality`);
  if (modality !== 'image' && modality !== 'video') throw new CatalogError('Invalid model catalog', `${label}.modality must be image or video`);

  const capabilities = validateCapabilities(requiredRecord(model, `${label}.capabilities`), `${label}.capabilities`);
  const parameters = requiredArray(model, `${label}.parameters`).map((item, index) => validateParameter(item, `${label}.parameters[${index}]`));
  if (parameters.length === 0) throw new CatalogError('Invalid model catalog', `${label}.parameters must contain at least one entry`);

  return {
    id: requiredString(model, `${label}.id`),
    displayName: requiredString(model, `${label}.displayName`),
    provider: provider as ModelProvider,
    family: family as ModelFamily,
    modality,
    endpoint: requiredString(model, `${label}.endpoint`),
    description: requiredString(model, `${label}.description`),
    capabilities,
    parameters
  };
}

function validateCapabilities(value: Record<string, unknown>, label: string): ModelCapabilities {
  const tasks = requiredStringArray(value, `${label}.tasks`);
  if (tasks.length === 0) throw new CatalogError('Invalid model catalog', `${label}.tasks must contain at least one task`);
  const durationValue = value.durationSeconds === undefined ? undefined : validateDuration(requiredRecord(value, `${label}.durationSeconds`), `${label}.durationSeconds`);
  return stripUndefined({
    tasks,
    resolutions: optionalStringArray(value, 'resolutions'),
    aspectRatios: optionalStringArray(value, 'aspectRatios'),
    frameRates: optionalNumberArray(value, 'frameRates'),
    durationSeconds: durationValue,
    outputFormats: optionalStringArray(value, 'outputFormats'),
    responseFormats: optionalStringArray(value, 'responseFormats'),
    videoFormat: optionalString(value, 'videoFormat'),
    maxReferenceImages: optionalNumber(value, 'maxReferenceImages'),
    maxOutputImages: optionalNumber(value, 'maxOutputImages'),
    audio: optionalBoolean(value, 'audio'),
    draft: optionalBoolean(value, 'draft'),
    serviceTiers: optionalStringArray(value, 'serviceTiers')
  });
}

function validateDuration(value: Record<string, unknown>, label: string): { minimum: number; maximum: number; intelligent?: number } {
  return stripUndefined({
    minimum: requiredNumber(value, `${label}.minimum`),
    maximum: requiredNumber(value, `${label}.maximum`),
    intelligent: optionalNumber(value, 'intelligent')
  });
}

function validateParameter(value: unknown, label: string): ParameterDescriptor {
  const param = asRecord(value, label);
  return stripUndefined({
    name: requiredString(param, `${label}.name`),
    type: requiredString(param, `${label}.type`),
    required: optionalBoolean(param, 'required'),
    default: optionalCatalogValue(param, 'default'),
    enum: optionalCatalogValueArray(param, 'enum'),
    minimum: optionalNumber(param, 'minimum'),
    maximum: optionalNumber(param, 'maximum'),
    maxItems: optionalNumber(param, 'maxItems'),
    maxLength: optionalNumber(param, 'maxLength'),
    maxRecommendedWords: optionalNumber(param, 'maxRecommendedWords'),
    supportsIntelligent: optionalNumber(param, 'supportsIntelligent'),
    stepRule: optionalString(param, 'stepRule'),
    notes: optionalString(param, 'notes')
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogError('Invalid model catalog', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key.split('.').pop() ?? key], key);
}

function requiredArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key.split('.').pop() ?? key];
  if (!Array.isArray(value)) throw new CatalogError('Invalid model catalog', `${key} must be an array`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key.split('.').pop() ?? key];
  if (typeof value !== 'string' || !value.trim()) throw new CatalogError('Invalid model catalog', `${key} must be a non-empty string`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key.split('.').pop() ?? key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogError('Invalid model catalog', `${key} must be a finite number`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
  const values = requiredArray(record, key);
  if (!values.every((item) => typeof item === 'string' && item.trim())) throw new CatalogError('Invalid model catalog', `${key} must be an array of non-empty strings`);
  return values as string[];
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new CatalogError('Invalid model catalog', `${key} must be a non-empty string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogError('Invalid model catalog', `${key} must be a finite number`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new CatalogError('Invalid model catalog', `${key} must be a boolean`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new CatalogError('Invalid model catalog', `${key} must be an array of non-empty strings`);
  return value as string[];
}

function optionalNumberArray(record: Record<string, unknown>, key: string): number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) throw new CatalogError('Invalid model catalog', `${key} must be an array of finite numbers`);
  return value as number[];
}

function optionalCatalogValue(record: Record<string, unknown>, key: string): CatalogValue | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isCatalogValue(value)) throw new CatalogError('Invalid model catalog', `${key} must be JSON-compatible`);
  return value;
}

function optionalCatalogValueArray(record: Record<string, unknown>, key: string): CatalogValue[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isCatalogValue)) throw new CatalogError('Invalid model catalog', `${key} must be a JSON-compatible array`);
  return value as CatalogValue[];
}

function isCatalogValue(value: unknown): value is CatalogValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCatalogValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isCatalogValue);
  return false;
}

function stripUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function catalogErrorResponse(error: unknown): { ok: false; error: string; details?: string } {
  if (error instanceof CatalogError) return stripUndefined({ ok: false, error: error.message, details: error.details });
  return { ok: false, error: 'Unexpected model catalog error', details: errorMessage(error) };
}
