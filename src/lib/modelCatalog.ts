import type { AppState, CatalogValue, GenerationControls, ModelCatalog, ModelCatalogCache, ModelCatalogEntry, OutputMode, ParameterDescriptor } from '../types';
import { MODEL_CATALOG_TTL_MS } from './data';

export type ParamPatch = Record<string, CatalogValue | undefined>;

const DEFAULT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '21:9'];
const ADVANCED_PARAM_NAMES = [
  'service_tier',
  'watermark',
  'frames',
  'output_format',
  'background',
  'optimize_prompt_options.mode',
  'priority',
  'negative_prompt',
  'person_generation'
];
const EXCLUDED_PARAM_NAMES = new Set(['model', 'prompt', 'content', 'image', 'callback_url', 'execution_expires_after', 'safety_identifier']);

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

export function isCacheFresh(cache: ModelCatalogCache, now = Date.now()) {
  const cachedAt = Date.parse(cache.cachedAt);
  return Number.isFinite(cachedAt) && now - cachedAt <= MODEL_CATALOG_TTL_MS;
}

export function modelsForMode(catalog: ModelCatalog | null, mode: OutputMode): ModelCatalogEntry[] {
  return catalog?.models.filter((model) => model.modality === mode) ?? [];
}

export function modelById(catalog: ModelCatalog | null, id: string): ModelCatalogEntry | null {
  return catalog?.models.find((model) => model.id === id) ?? null;
}

export function firstModel(catalog: ModelCatalog | null, mode?: OutputMode): ModelCatalogEntry | null {
  if (!catalog?.models.length) return null;
  return mode ? modelsForMode(catalog, mode)[0] ?? catalog.models[0] : catalog.models[0];
}

export function modeLabel(mode: OutputMode) {
  return mode === 'video' ? 'Video' : 'Image';
}

export function modelName(catalog: ModelCatalog | null, id: string): string {
  return modelById(catalog, id)?.displayName ?? (id ? 'Unknown model' : 'No model');
}

export function parameter(model: ModelCatalogEntry | null, name: string): ParameterDescriptor | null {
  return model?.parameters.find((param) => param.name === name) ?? null;
}

export function hasParameter(model: ModelCatalogEntry | null, name: string): boolean {
  return Boolean(parameter(model, name));
}

export function supportsSeed(model: ModelCatalogEntry | null): boolean {
  return hasParameter(model, 'seed');
}

export function supportsGuidance(model: ModelCatalogEntry | null): boolean {
  return hasParameter(model, 'guidance') || hasParameter(model, 'cfg_scale');
}

export function supportsCamera(model: ModelCatalogEntry | null): boolean {
  return hasParameter(model, 'camera_fixed');
}

export function supportsAudio(model: ModelCatalogEntry | null): boolean {
  return Boolean(model?.capabilities.audio || hasParameter(model, 'generate_audio'));
}

export function supportsLocalReferenceUpload(model: ModelCatalogEntry | null | undefined): boolean {
  return Boolean(model && model.provider === 'byteplus' && model.family === 'seedream' && model.id.includes('seedream-5-'));
}

export function advancedParameters(model: ModelCatalogEntry | null): ParameterDescriptor[] {
  if (!model) return [];
  return ADVANCED_PARAM_NAMES.map((name) => parameter(model, name)).filter((param): param is ParameterDescriptor => param !== null && !EXCLUDED_PARAM_NAMES.has(param.name));
}

export function catalogValueKey(value: CatalogValue) {
  return JSON.stringify(value);
}

export function parameterLabel(name: string): string {
  return name.split('.').pop()?.replace(/_/g, ' ') ?? name;
}

export function displayCatalogValue(value: CatalogValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(displayCatalogValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function defaultParamValue(param: ParameterDescriptor): CatalogValue | undefined {
  if (param.default !== undefined) return param.default;
  if (param.enum?.length) return param.enum[0];
  if (param.type === 'boolean') return false;
  if (param.type === 'integer' || param.type === 'number') return param.minimum ?? 0;
  return undefined;
}

function normalizeParamValue(param: ParameterDescriptor, value: CatalogValue | undefined): CatalogValue | undefined {
  const fallback = defaultParamValue(param);
  if (value === undefined) return fallback;
  if (param.enum?.length) {
    const allowed = new Set(param.enum.map(catalogValueKey));
    return allowed.has(catalogValueKey(value)) ? value : fallback;
  }
  if (param.type === 'boolean') return typeof value === 'boolean' ? value : fallback;
  if ((param.type === 'integer' || param.type === 'number') && typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value, param.minimum ?? Number.NEGATIVE_INFINITY, param.maximum ?? Number.POSITIVE_INFINITY);
  }
  if (param.type === 'string') return typeof value === 'string' ? value : fallback;
  return value;
}

function normalizeParams(model: ModelCatalogEntry | null, params: Record<string, CatalogValue> | undefined, patch?: ParamPatch): Record<string, CatalogValue> {
  const next: Record<string, CatalogValue> = {};
  for (const param of advancedParameters(model)) {
    const patched = patch && Object.prototype.hasOwnProperty.call(patch, param.name);
    const normalized = normalizeParamValue(param, patched ? patch[param.name] : params?.[param.name]);
    if (normalized !== undefined) next[param.name] = normalized;
  }
  return next;
}

function preferredOption(options: string[] | undefined, current: string, fallback?: string): string {
  if (!options?.length) return current || '';
  if (options.includes(current)) return current;
  if (fallback && options.includes(fallback)) return fallback;
  return options[0];
}

export function normalizeControls(catalog: ModelCatalog | null, ctl: GenerationControls, patch: Partial<GenerationControls> & { params?: ParamPatch } = {}): GenerationControls {
  const next = { ...ctl, ...patch, params: { ...(ctl.params ?? {}), ...(patch.params ?? {}) } };
  if (!catalog?.models.length) return next;

  const requestedMode = patch.mode ?? next.mode;
  let model = patch.modelId ? modelById(catalog, patch.modelId) : modelById(catalog, next.modelId);
  if (!model || (patch.mode && model.modality !== requestedMode)) model = firstModel(catalog, requestedMode);
  if (!model) return next;

  const changedModel = model.id !== ctl.modelId;
  const resolutionDefault = parameter(model, 'resolution')?.default;
  const ratioDefault = parameter(model, 'ratio')?.default;
  const audioDefault = parameter(model, 'generate_audio')?.default;

  next.modelId = model.id;
  next.mode = model.modality;
  next.ratio = preferredOption(model.capabilities.aspectRatios ?? DEFAULT_RATIOS, next.ratio, typeof ratioDefault === 'string' ? ratioDefault : model.modality === 'video' ? '16:9' : '1:1');
  next.res = preferredOption(model.capabilities.resolutions, next.res, typeof resolutionDefault === 'string' ? resolutionDefault : model.modality === 'video' ? '720p' : '2K');
  next.params = normalizeParams(model, ctl.params, patch.params);

  if (model.modality === 'video') {
    const duration = model.capabilities.durationSeconds;
    next.length = duration ? next.length === duration.intelligent ? next.length : clamp(next.length, duration.minimum, duration.maximum) : next.length;
    const fps = model.capabilities.frameRates ?? [24];
    if (!fps.includes(next.fps)) next.fps = fps[0] ?? 24;
    if (supportsCamera(model)) next.camera = changedModel ? true : next.camera;
    else next.camera = false;
    if (supportsAudio(model)) next.audio = changedModel ? (typeof audioDefault === 'boolean' ? audioDefault : true) : next.audio;
    else next.audio = false;
  } else {
    next.camera = false;
    next.audio = false;
  }

  if (!supportsSeed(model)) next.seed = '';
  if (!supportsGuidance(model)) next.guidance = 7;
  if (next.params.draft === true && (model.capabilities.resolutions ?? []).includes('480p')) next.res = '480p';
  if (next.params.background === 'transparent' && (model.capabilities.outputFormats ?? []).includes('png')) next.params.output_format = 'png';
  return next;
}

export function normalizeStateForCatalog(state: AppState, catalog: ModelCatalog | null): AppState {
  const ctl = normalizeControls(catalog, state.ctl);
  const projects = state.projects.map((project) => ({
    ...project,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      ctl: scene.id === state.activeSceneId && project.id === state.activeProjectId
        ? ctl
        : scene.ctl
          ? normalizeControls(catalog, scene.ctl)
          : undefined
    }))
  }));
  return { ...state, ctl, projects };
}
