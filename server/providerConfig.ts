import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ModelCatalogEntry } from './modelCatalog.js';

export class ProviderConfigError extends Error {
  constructor(message: string, public readonly details?: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export interface BytePlusModelArkConfig {
  baseUrl: string;
  apiKeyEnv: string;
  modelEndpointIds: Record<string, string>;
}

export interface GeminiConfig {
  baseUrl: string;
  apiKeyEnv: string;
}

export interface BytePlusTosConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  publicBaseUrl?: string;
  keyPrefix: string;
  presignTtlSeconds: number;
}

export interface ProviderConfig {
  providers: { byteplus?: { modelArk: BytePlusModelArkConfig }; gemini?: GeminiConfig };
  storage: { provider: 'byteplus-tos'; byteplusTos: BytePlusTosConfig };
}

const defaultLocalPath = path.resolve(process.cwd(), 'server/provider-config.local.yaml');
const defaultExamplePath = path.resolve(process.cwd(), 'server/provider-config.example.yaml');

export function loadProviderConfig(filePath = process.env.LUCIDIO_PROVIDER_CONFIG || (fs.existsSync(defaultLocalPath) ? defaultLocalPath : defaultExamplePath)): ProviderConfig {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ProviderConfigError('Unable to read provider config', errorMessage(error));
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new ProviderConfigError('Unable to parse provider config YAML', errorMessage(error));
  }

  return validateProviderConfig(parsed);
}

export function getConfiguredSecret(envName: string, label: string): string {
  const value = process.env[envName];
  if (!value?.trim()) throw new ProviderConfigError(`Missing ${label}`, `Set environment variable ${envName}.`);
  return value;
}

export function hasConfiguredGeminiProvider(config: ProviderConfig): boolean {
  return Boolean(config.providers.gemini);
}

export function geminiConfigOrThrow(config: ProviderConfig): GeminiConfig {
  const gemini = config.providers.gemini;
  if (!gemini) throw new ProviderConfigError('Missing Gemini provider config', 'Configure providers.gemini.baseUrl and apiKeyEnv in server/provider-config.local.yaml.');
  return gemini;
}

export function hasConfiguredEndpointMapping(config: ProviderConfig, modelId: string): boolean {
  const endpointId = config.providers.byteplus?.modelArk.modelEndpointIds[modelId];
  return Boolean(endpointId && !isPlaceholder(endpointId));
}

export function endpointIdForModel(config: ProviderConfig, modelId: string): string {
  const endpointId = config.providers.byteplus?.modelArk.modelEndpointIds[modelId];
  if (!endpointId || isPlaceholder(endpointId)) {
    throw new ProviderConfigError('Missing BytePlus endpoint mapping', `Configure providers.byteplus.modelArk.modelEndpointIds.${modelId} in server/provider-config.local.yaml.`);
  }
  return endpointId;
}

/** True when the provider backing this model is configured and, for BytePlus, its endpoint id is mapped. */
export function hasConfiguredModel(config: ProviderConfig, model: Pick<ModelCatalogEntry, 'id' | 'provider'>): boolean {
  return model.provider === 'gemini' ? hasConfiguredGeminiProvider(config) : hasConfiguredEndpointMapping(config, model.id);
}

/** Resolve the provider-specific model reference sent to the API: the Gemini model id, or the mapped BytePlus endpoint id. */
export function endpointRefForModel(config: ProviderConfig, model: Pick<ModelCatalogEntry, 'id' | 'provider'>): string {
  return model.provider === 'gemini' ? model.id : endpointIdForModel(config, model.id);
}


function validateProviderConfig(value: unknown): ProviderConfig {
  const root = asRecord(value, 'provider config');
  const providers = asRecord(root.providers, 'providers');
  const byteplus = providers.byteplus === undefined ? undefined : validateBytePlusProvider(asRecord(providers.byteplus, 'providers.byteplus'));
  const gemini = providers.gemini === undefined ? undefined : validateGeminiProvider(asRecord(providers.gemini, 'providers.gemini'));
  if (!byteplus && !gemini) throw new ProviderConfigError('Invalid provider config', 'providers must configure at least one of byteplus or gemini');
  const storage = asRecord(root.storage, 'storage');
  const provider = stringValue(storage.provider, 'storage.provider');
  if (provider !== 'byteplus-tos') throw new ProviderConfigError('Invalid provider config', 'storage.provider must be byteplus-tos');
  const tos = asRecord(storage.byteplusTos, 'storage.byteplusTos');

  return {
    providers: stripUndefined({ byteplus, gemini }),
    storage: {
      provider: 'byteplus-tos',
      byteplusTos: {
        endpoint: trimTrailingSlash(stringValue(tos.endpoint, 'storage.byteplusTos.endpoint')),
        region: stringValue(tos.region, 'storage.byteplusTos.region'),
        bucket: stringValue(tos.bucket, 'storage.byteplusTos.bucket'),
        accessKeyIdEnv: stringValue(tos.accessKeyIdEnv, 'storage.byteplusTos.accessKeyIdEnv'),
        secretAccessKeyEnv: stringValue(tos.secretAccessKeyEnv, 'storage.byteplusTos.secretAccessKeyEnv'),
        publicBaseUrl: optionalString(tos.publicBaseUrl, 'storage.byteplusTos.publicBaseUrl'),
        keyPrefix: normalizePrefix(optionalString(tos.keyPrefix, 'storage.byteplusTos.keyPrefix') ?? 'generations'),
        presignTtlSeconds: clampTtl(optionalNumber(tos.presignTtlSeconds, 'storage.byteplusTos.presignTtlSeconds') ?? 900)
      }
    }
  };
}

function validateBytePlusProvider(byteplus: Record<string, unknown>): { modelArk: BytePlusModelArkConfig } {
  const modelArk = asRecord(byteplus.modelArk, 'providers.byteplus.modelArk');
  const modelEndpointIds = asStringMap(modelArk.modelEndpointIds, 'providers.byteplus.modelArk.modelEndpointIds');
  return {
    modelArk: {
      baseUrl: trimTrailingSlash(stringValue(modelArk.baseUrl, 'providers.byteplus.modelArk.baseUrl')),
      apiKeyEnv: stringValue(modelArk.apiKeyEnv, 'providers.byteplus.modelArk.apiKeyEnv'),
      modelEndpointIds
    }
  };
}

function validateGeminiProvider(gemini: Record<string, unknown>): GeminiConfig {
  return {
    baseUrl: trimTrailingSlash(stringValue(gemini.baseUrl, 'providers.gemini.baseUrl')),
    apiKeyEnv: stringValue(gemini.apiKeyEnv, 'providers.gemini.apiKeyEnv')
  };
}

function stripUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isPlaceholder(value: string): boolean {
  return /^BYTEPLUS_ACCOUNT_ENDPOINT_ID_/.test(value) || value.includes('<') || value.toLowerCase().includes('your-');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderConfigError('Invalid provider config', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function asStringMap(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  const entries = Object.entries(record);
  if (!entries.length) throw new ProviderConfigError('Invalid provider config', `${label} must not be empty`);
  for (const [key, item] of entries) {
    if (typeof item !== 'string' || !item.trim()) throw new ProviderConfigError('Invalid provider config', `${label}.${key} must be a non-empty string`);
  }
  return record as Record<string, string>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderConfigError('Invalid provider config', `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return stringValue(value, label);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProviderConfigError('Invalid provider config', `${label} must be a finite number`);
  return value;
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..') || /^https?:\/\//i.test(normalized)) throw new ProviderConfigError('Invalid provider config', 'storage.byteplusTos.keyPrefix must be a safe object-key prefix');
  return normalized;
}

function clampTtl(value: number): number {
  if (!Number.isInteger(value) || value < 60) throw new ProviderConfigError('Invalid provider config', 'storage.byteplusTos.presignTtlSeconds must be an integer >= 60');
  return Math.min(value, 3600);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
