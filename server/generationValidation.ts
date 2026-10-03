import type { CatalogValue, ModelCatalog, ModelCatalogEntry, ParameterDescriptor } from './modelCatalog.js';
import type { GenerateRequest, GenerationProviderTask, GenerationReferenceSelection, ReferenceMedia, StoredMediaAsset, VideoReferenceIntent } from './contracts.js';
import { assertContentTypeMatchesKey, isImageContentType, isVideoContentType, normalizeContentType, validateObjectKey } from './mediaKeys.js';

export class RequestValidationError extends Error {
  constructor(message: string, public readonly details?: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export interface ValidatedGenerateRequest {
  request: GenerateRequest;
  model: ModelCatalogEntry;
  providerParams: Record<string, CatalogValue>;
  references: ReferenceMedia[];
}

const UI_TOP_LEVEL_KEYS = new Set([
  'mode', 'modelId', 'prompt', 'ratio', 'res', 'length', 'fps', 'camera', 'audio', 'guidance', 'seed', 'params', 'references', 'referenceSelections', 'projectId', 'sceneId'
]);
const PROVIDER_PARAMS_EXCLUDED_FROM_CLIENT = new Set(['model', 'prompt', 'image', 'content', 'callback_url', 'execution_expires_after', 'safety_identifier', 'response_format', 'input', 'instances', 'parameters', 'image_size', 'aspect_ratio', 'mime_type', 'numberOfVideos']);
const SINGLE_OUTPUT_REJECTED_PARAMS = new Set(['sequential_image_generation', 'sequential_image_generation_options.max_images']);
const VIDEO_REFERENCE_INTENTS: VideoReferenceIntent[] = ['image_reference', 'first_frame', 'last_frame', 'source_video', 'audio_reference', 'sample_task'];

export function validateGenerateRequest(body: unknown, catalog: ModelCatalog, mediaKeyPrefix = 'generations'): ValidatedGenerateRequest {
  const raw = record(body, 'request body');
  for (const key of Object.keys(raw)) {
    if (!UI_TOP_LEVEL_KEYS.has(key)) throw new RequestValidationError('Unsupported generation field', `${key} is not accepted by /api/generate.`);
  }

  const mode = outputMode(raw.mode);
  const modelId = stringValue(raw.modelId, 'modelId');
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw new RequestValidationError('Unsupported model', `${modelId} is not present in server/model-catalog.yaml.`);

  if (mode === 'image') return validateImageRequest(raw, model, mediaKeyPrefix);
  return validateVideoRequest(raw, model, mediaKeyPrefix);
}

export function supportedReferenceIntentsForModel(model: ModelCatalogEntry): VideoReferenceIntent[] {
  if (model.modality !== 'video') return [];
  const tasks = new Set(model.capabilities.tasks);
  const intents = new Set<VideoReferenceIntent>();
  if (tasks.has('multimodal-reference-to-video') || tasks.has('image-to-video-first-frame') || tasks.has('image-to-video-first-and-last-frames')) intents.add('image_reference');
  if (tasks.has('image-to-video-first-frame') || tasks.has('image-to-video-first-and-last-frames')) intents.add('first_frame');
  if (tasks.has('image-to-video-first-and-last-frames')) intents.add('last_frame');
  if (tasks.has('video-modification') || tasks.has('video-extension')) intents.add('source_video');
  return [...intents];
}

function validateImageRequest(raw: Record<string, unknown>, model: ModelCatalogEntry, mediaKeyPrefix: string): ValidatedGenerateRequest {
  if (model.modality !== 'image') throw new RequestValidationError('Unsupported model', `${model.id} is not an image generation model.`);

  const prompt = validatePrompt(raw.prompt, model);
  const ratio = stringValue(raw.ratio, 'ratio');
  validateEnum(ratio, model.capabilities.aspectRatios, 'Unsupported aspect ratio', `${ratio} is not supported by ${model.displayName}.`);
  const res = stringValue(raw.res, 'res');
  validateEnum(res, model.capabilities.resolutions, 'Unsupported resolution', `${res} is not supported by ${model.displayName}.`);

  const params = optionalParamRecord(raw.params);
  const providerParams = validateParams(params, model);
  applyImageCanonicalParams(model, providerParams, res, ratio);

  const references = validateReferences(raw.references, model, 'image', mediaKeyPrefix);
  return {
    request: baseRequest(raw, 'image', model.id, prompt, ratio, res, params, references),
    model,
    providerParams,
    references
  };
}

function validateVideoRequest(raw: Record<string, unknown>, model: ModelCatalogEntry, mediaKeyPrefix: string): ValidatedGenerateRequest {
  if (model.modality !== 'video') throw new RequestValidationError('Unsupported model', `${model.id} is not a video generation model.`);

  const prompt = validatePrompt(raw.prompt, model);
  const ratio = stringValue(raw.ratio, 'ratio');
  validateEnum(ratio, model.capabilities.aspectRatios, 'Unsupported aspect ratio', `${ratio} is not supported by ${model.displayName}.`);
  const res = stringValue(raw.res, 'res');
  validateEnum(res, model.capabilities.resolutions, 'Unsupported resolution', `${res} is not supported by ${model.displayName}.`);

  const params = optionalParamRecord(raw.params);
  const providerParams = validateParams(params, model);
  // BytePlus derives the Lucidio thumbnail from the provider's returned last frame; Gemini video
  // (Veo, Omni Flash) returns only an MP4 and the thumbnail is extracted server-side instead.
  if (model.provider !== 'gemini') {
    if (providerParams.return_last_frame === false) throw new RequestValidationError('Last-frame thumbnail is required', 'return_last_frame cannot be disabled for Lucidio video generation.');
    if (providerParams.draft === true) throw new RequestValidationError('Draft mode is not compatible with thumbnails', 'Draft mode disables last-frame return, which Lucidio uses as the video thumbnail.');
    providerParams.return_last_frame = true;
  }

  setCanonicalParameter(providerParams, model, 'resolution', res);
  setCanonicalParameter(providerParams, model, 'ratio', ratio);
  const length = optionalNumber(raw.length, 'length');
  if (length !== undefined) setCanonicalParameter(providerParams, model, 'duration', validateCatalogParamValue(parameter(model, 'duration') ?? parameter(model, 'length') ?? syntheticDuration(model), length));
  const fps = optionalNumber(raw.fps, 'fps');
  if (fps !== undefined && model.capabilities.frameRates?.length && !model.capabilities.frameRates.includes(fps)) throw new RequestValidationError('Unsupported frame rate', `${fps}fps is not supported by ${model.displayName}.`);
  const audio = optionalBoolean(raw.audio, 'audio');
  if (audio !== undefined && parameter(model, 'generate_audio')) setCanonicalParameter(providerParams, model, 'generate_audio', audio);
  const camera = optionalBoolean(raw.camera, 'camera');
  if (camera !== undefined && parameter(model, 'camera_fixed')) setCanonicalParameter(providerParams, model, 'camera_fixed', !camera);
  const seed = raw.seed === '' || raw.seed === undefined ? undefined : optionalNumber(raw.seed, 'seed');
  if (seed !== undefined && parameter(model, 'seed')) setCanonicalParameter(providerParams, model, 'seed', validateCatalogParamValue(parameter(model, 'seed')!, seed));

  const references = validateReferences(raw.references, model, 'video', mediaKeyPrefix);
  return {
    request: baseRequest(raw, 'video', model.id, prompt, ratio, res, params, references),
    model,
    providerParams,
    references
  };
}

function baseRequest(raw: Record<string, unknown>, mode: 'image' | 'video', modelId: string, prompt: string, ratio: string, res: string, params: Record<string, CatalogValue>, references: ReferenceMedia[]): GenerateRequest {
  return {
    mode,
    modelId,
    prompt,
    ratio,
    res,
    length: optionalNumber(raw.length, 'length'),
    fps: optionalNumber(raw.fps, 'fps'),
    camera: optionalBoolean(raw.camera, 'camera'),
    audio: optionalBoolean(raw.audio, 'audio'),
    guidance: optionalNumber(raw.guidance, 'guidance'),
    seed: raw.seed === '' || raw.seed === undefined ? '' : optionalNumber(raw.seed, 'seed'),
    params,
    references,
    referenceSelections: validateReferenceSelections(raw.referenceSelections),
    projectId: stringValue(raw.projectId, 'projectId'),
    sceneId: raw.sceneId === null ? null : stringValue(raw.sceneId, 'sceneId')
  };
}

function validateReferenceSelections(value: unknown): GenerationReferenceSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RequestValidationError('Invalid reference selections', 'referenceSelections must be an array.');
  return value.map((item, index) => {
    const label = `referenceSelections[${index}]`;
    const selection = record(item, label);
    for (const key of Object.keys(selection)) {
      if (!['generationId', 'intent'].includes(key)) throw new RequestValidationError('Invalid reference selections', `${label}.${key} is not accepted.`);
    }
    return {
      generationId: stringValue(selection.generationId, `${label}.generationId`),
      intent: videoReferenceIntent(selection.intent, `${label}.intent`)
    };
  });
}

const BYTEPLUS_RECOMMENDED_SIZES: Record<string, Record<string, string>> = {
  '1K': {
    '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1280x720', '9:16': '720x1280', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1512x648'
  },
  '2K': {
    '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344'
  },
  '3K': {
    '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456', '16:9': '4096x2304', '9:16': '2304x4096', '3:2': '3744x2496', '2:3': '2496x3744', '21:9': '4704x2016'
  },
  '4K': {
    '1:1': '4096x4096', '3:4': '3520x4704', '4:3': '4704x3520', '16:9': '5504x3040', '9:16': '3040x5504', '2:3': '3328x4992', '3:2': '4992x3328', '21:9': '6240x2656'
  }
};

const BYTEPLUS_DOLA_RECOMMENDED_SIZES: Record<string, Record<string, string>> = {
  '1K': {
    '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1568x672'
  },
  '1.5K': {
    '1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792', '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248', '2:3': '1248x1872', '21:9': '2352x1008'
  },
  '2K': {
    '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368', '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344'
  }
};

function applyImageCanonicalParams(model: ModelCatalogEntry, providerParams: Record<string, CatalogValue>, res: string, ratio: string): void {
  if (model.provider === 'gemini') {
    providerParams.image_size = res;
    providerParams.aspect_ratio = ratio;
    providerParams.mime_type = model.capabilities.outputFormats?.[0] === 'png' ? 'image/png' : 'image/jpeg';
    return;
  }
  providerParams.response_format = 'b64_json';
  providerParams.stream = false;
  if (model.parameters.some((param) => param.name === 'sequential_image_generation')) providerParams.sequential_image_generation = 'disabled';
  providerParams.size = providerParams.size ?? providerSizeFor(model, res, ratio);
}

function providerSizeFor(model: ModelCatalogEntry, resolution: string, ratio: string): string {
  if (model.id.startsWith('dola-seedream-5-0-')) {
    const recommended = BYTEPLUS_DOLA_RECOMMENDED_SIZES[resolution]?.[ratio];
    if (recommended) return recommended;
  }
  const recommended = BYTEPLUS_RECOMMENDED_SIZES[resolution]?.[ratio];
  if (recommended) return recommended;

  const base = resolution === '1K' ? 1024 : resolution === '4K' ? 4096 : 2048;
  const [rw, rh] = ratio.split(':').map((part) => Number(part));
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return resolution;
  if (rw === rh) return `${base}x${base}`;
  const landscape = rw > rh;
  const width = landscape ? base : roundToMultiple(base * (rw / rh), 8);
  const height = landscape ? roundToMultiple(base * (rh / rw), 8) : base;
  return `${Math.max(width, 16)}x${Math.max(height, 16)}`;
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function validateParams(params: Record<string, CatalogValue>, model: ModelCatalogEntry): Record<string, CatalogValue> {
  const output: Record<string, CatalogValue> = {};
  for (const [name, value] of Object.entries(params)) {
    if (PROVIDER_PARAMS_EXCLUDED_FROM_CLIENT.has(name)) throw new RequestValidationError('Unsupported parameter', `${name} is managed by the server.`);
    const param = parameter(model, name);
    if (!param) throw new RequestValidationError('Unsupported parameter', `${name} is not supported by ${model.displayName}.`);
    if (SINGLE_OUTPUT_REJECTED_PARAMS.has(name)) {
      if (name === 'sequential_image_generation' && value !== 'disabled') throw new RequestValidationError('Sequential image generation is not enabled', 'This first pass supports one output image per request.');
      if (name === 'sequential_image_generation_options.max_images' && value !== 1) throw new RequestValidationError('Multiple output images are not enabled', 'This first pass supports one output image per request.');
    }
    output[name] = validateCatalogParamValue(param, value);
  }
  return output;
}

function validateReferences(value: unknown, model: ModelCatalogEntry, mode: 'image' | 'video', mediaKeyPrefix: string): ReferenceMedia[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequestValidationError('Invalid references', 'references must be an array.');
  if (mode === 'image') return validateImageReferences(value, model, mediaKeyPrefix);
  return validateVideoReferences(value, model, mediaKeyPrefix);
}

function validateImageReferences(value: unknown[], model: ModelCatalogEntry, mediaKeyPrefix: string): ReferenceMedia[] {
  const maxRefs = Math.min(model.capabilities.maxReferenceImages ?? Infinity, parameter(model, 'image')?.maxItems ?? Infinity);
  if (value.length > maxRefs) throw new RequestValidationError('Too many references', `${model.displayName} supports at most ${maxRefs} reference image(s).`);
  return value.map((item, index) => {
    const ref = referenceRecord(item, `references[${index}]`);
    const id = stringValue(ref.id, `references[${index}].id`);
    const media = validateMediaAsset(ref.media, `references[${index}].media`, mediaKeyPrefix);
    if (!isImageContentType(media.contentType)) throw new RequestValidationError('Invalid reference media', `references[${index}].media.contentType must be an image content type.`);
    const intent = ref.intent === undefined ? undefined : videoReferenceIntent(ref.intent, `references[${index}].intent`);
    if (intent && intent !== 'image_reference') throw new RequestValidationError('Invalid reference intent', 'Image generation references only support image_reference intent.');
    return { id, intent, media };
  });
}

function validateVideoReferences(value: unknown[], model: ModelCatalogEntry, mediaKeyPrefix: string): ReferenceMedia[] {
  const supported = supportedReferenceIntentsForModel(model);
  return value.map((item, index) => {
    const label = `references[${index}]`;
    const ref = referenceRecord(item, label);
    const id = stringValue(ref.id, `${label}.id`);
    const intent = videoReferenceIntent(ref.intent, `${label}.intent`);
    if (!supported.includes(intent)) throw new RequestValidationError('Unsupported reference intent', `${intent} is not supported by ${model.displayName}.`);
    const media = validateMediaAsset(ref.media, `${label}.media`, mediaKeyPrefix);
    const thumbnail = ref.thumbnail === undefined ? undefined : validateMediaAsset(ref.thumbnail, `${label}.thumbnail`, mediaKeyPrefix);
    const providerTask = ref.providerTask === undefined ? undefined : validateProviderTask(ref.providerTask, `${label}.providerTask`);

    if (intent === 'source_video') {
      if (!isVideoContentType(media.contentType)) throw new RequestValidationError('Invalid reference media', `${label}.media must be a video/mp4 source for source_video.`);
    } else if (intent === 'first_frame') {
      if (!isPrimaryImageAsset(media)) throw new RequestValidationError('Invalid reference media', `${label}.media must be primary image media for first_frame; returned video thumbnails cannot be used as first-frame provenance.`);
    } else if (intent === 'audio_reference') {
      throw new RequestValidationError('Unsupported reference intent', 'audio_reference is reserved until Lucidio has existing audio media support.');
    } else if (intent === 'sample_task') {
      if (!providerTask) throw new RequestValidationError('Invalid reference media', `${label}.providerTask is required for sample_task references.`);
      throw new RequestValidationError('Unsupported reference intent', 'sample_task references are not enabled for this first video pass.');
    } else {
      // last_frame may use the returned last-frame thumbnail from a Lucidio video.
      // image_reference may use either primary image media or a video thumbnail as a generic visual reference.
      const imageAsset = isImageContentType(media.contentType) ? media : thumbnail;
      if (!imageAsset || !isImageContentType(imageAsset.contentType)) throw new RequestValidationError('Invalid reference media', `${label} must include image media for ${intent}.`);
    }

    return { id, intent, media, thumbnail, providerTask };
  });
}

function validateMediaAsset(value: unknown, label: string, mediaKeyPrefix: string): StoredMediaAsset {
  const media = mediaRecord(value, label);
  if (stringValue(media.provider, `${label}.provider`) !== 'byteplus-tos') throw new RequestValidationError('Invalid reference media', `${label}.provider must be byteplus-tos.`);
  const key = stringValue(media.key, `${label}.key`);
  const contentType = normalizeContentType(stringValue(media.contentType, `${label}.contentType`));
  try {
    validateObjectKey(key, mediaKeyPrefix);
    assertContentTypeMatchesKey(key, contentType, mediaKeyPrefix);
  } catch {
    throw new RequestValidationError('Invalid reference media', `${label}.key/contentType is not an allowed generated-media object.`);
  }
  const kind = media.kind === undefined ? kindForContentType(contentType) : mediaKind(media.kind, `${label}.kind`);
  const role = media.role === undefined ? undefined : mediaRole(media.role, `${label}.role`);
  return {
    provider: 'byteplus-tos',
    key,
    contentType,
    size: numberValue(media.size, `${label}.size`),
    createdAt: stringValue(media.createdAt, `${label}.createdAt`),
    kind,
    role,
    bucket: optionalString(media.bucket, `${label}.bucket`),
    region: optionalString(media.region, `${label}.region`),
    etag: optionalString(media.etag, `${label}.etag`),
    checksum: optionalString(media.checksum, `${label}.checksum`),
    width: optionalNumber(media.width, `${label}.width`),
    height: optionalNumber(media.height, `${label}.height`),
    durationSeconds: optionalNumber(media.durationSeconds, `${label}.durationSeconds`)
  };
}

function validateProviderTask(value: unknown, label: string): GenerationProviderTask {
  const task = record(value, label);
  const provider = stringValue(task.provider, `${label}.provider`);
  if (provider !== 'byteplus' && provider !== 'gemini') throw new RequestValidationError('Invalid reference media', `${label}.provider must be byteplus or gemini.`);
  return { provider, taskId: stringValue(task.taskId, `${label}.taskId`), modelId: stringValue(task.modelId, `${label}.modelId`), completedAt: optionalString(task.completedAt, `${label}.completedAt`) };
}

function referenceRecord(value: unknown, label: string): Record<string, unknown> {
  const ref = record(value, label);
  for (const key of Object.keys(ref)) {
    if (!['id', 'intent', 'media', 'thumbnail', 'providerTask'].includes(key)) throw new RequestValidationError('Invalid references', `${label}.${key} is not accepted; raw URLs, files, blobs, and data URLs are not allowed.`);
  }
  return ref;
}

function mediaRecord(value: unknown, label: string): Record<string, unknown> {
  const media = record(value, label);
  for (const key of Object.keys(media)) {
    if (!['provider', 'key', 'contentType', 'size', 'createdAt', 'kind', 'role', 'bucket', 'region', 'etag', 'checksum', 'width', 'height', 'durationSeconds'].includes(key)) {
      throw new RequestValidationError('Invalid reference media', `${label}.${key} is not accepted; raw URLs, files, blobs, and data URLs are not allowed.`);
    }
  }
  return media;
}

function validateCatalogParamValue(param: ParameterDescriptor, value: CatalogValue): CatalogValue {
  if (param.supportsIntelligent !== undefined && value === param.supportsIntelligent) return value;
  if (param.enum?.length && !param.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new RequestValidationError('Invalid parameter value', `${param.name} must be one of: ${param.enum.map(String).join(', ')}.`);
  if (param.type === 'boolean' && typeof value !== 'boolean') throw new RequestValidationError('Invalid parameter value', `${param.name} must be a boolean.`);
  if (param.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new RequestValidationError('Invalid parameter value', `${param.name} must be an integer.`);
    if (param.stepRule === '25 + 4n' && (value < 25 || (value - 25) % 4 !== 0)) throw new RequestValidationError('Invalid parameter value', `${param.name} must follow ${param.stepRule}.`);
    if (param.minimum !== undefined && value < param.minimum) throw new RequestValidationError('Invalid parameter value', `${param.name} must be >= ${param.minimum}.`);
    if (param.maximum !== undefined && value > param.maximum) throw new RequestValidationError('Invalid parameter value', `${param.name} must be <= ${param.maximum}.`);
  }
  if (param.type === 'number' && typeof value === 'number') {
    if (param.minimum !== undefined && value < param.minimum) throw new RequestValidationError('Invalid parameter value', `${param.name} must be >= ${param.minimum}.`);
    if (param.maximum !== undefined && value > param.maximum) throw new RequestValidationError('Invalid parameter value', `${param.name} must be <= ${param.maximum}.`);
  }
  if (param.type === 'string' && typeof value !== 'string') throw new RequestValidationError('Invalid parameter value', `${param.name} must be a string.`);
  return value;
}

function setCanonicalParameter(params: Record<string, CatalogValue>, model: ModelCatalogEntry, name: string, value: CatalogValue): void {
  const param = parameter(model, name);
  if (!param) return;
  params[name] = validateCatalogParamValue(param, value);
}

function isPrimaryImageAsset(media: StoredMediaAsset): boolean {
  return isImageContentType(media.contentType) && media.kind === 'image' && media.role === 'primary';
}

function syntheticDuration(model: ModelCatalogEntry): ParameterDescriptor {
  return { name: 'duration', type: 'integer', minimum: model.capabilities.durationSeconds?.minimum, maximum: model.capabilities.durationSeconds?.maximum, supportsIntelligent: model.capabilities.durationSeconds?.intelligent };
}

function parameter(model: ModelCatalogEntry, name: string): ParameterDescriptor | undefined {
  return model.parameters.find((param) => param.name === name);
}

function optionalParamRecord(value: unknown): Record<string, CatalogValue> {
  if (value === undefined || value === null) return {};
  const raw = record(value, 'params');
  const out: Record<string, CatalogValue> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!isCatalogValue(item)) throw new RequestValidationError('Invalid parameter value', `${key} must be JSON-compatible.`);
    out[key] = item;
  }
  return out;
}

function isCatalogValue(value: unknown): value is CatalogValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCatalogValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isCatalogValue);
  return false;
}

function validatePrompt(value: unknown, model: ModelCatalogEntry): string {
  const prompt = stringValue(value, 'prompt').trim();
  const promptParam = parameter(model, 'prompt');
  const maxWords = promptParam?.maxRecommendedWords;
  if (maxWords && countWords(prompt) > maxWords) throw new RequestValidationError('Prompt is too long', `The selected model recommends at most ${maxWords} words.`);
  return prompt;
}

function validateEnum(value: string, allowed: string[] | undefined, message: string, details: string): void {
  if (allowed?.length && !allowed.includes(value)) throw new RequestValidationError(message, details);
}

function outputMode(value: unknown): 'image' | 'video' {
  const mode = stringValue(value, 'mode');
  if (mode !== 'image' && mode !== 'video') throw new RequestValidationError('Invalid request', 'mode must be image or video.');
  return mode;
}

function videoReferenceIntent(value: unknown, label: string): VideoReferenceIntent {
  if (typeof value !== 'string' || !VIDEO_REFERENCE_INTENTS.includes(value as VideoReferenceIntent)) throw new RequestValidationError('Invalid reference intent', `${label} must be one of ${VIDEO_REFERENCE_INTENTS.join(', ')}.`);
  return value as VideoReferenceIntent;
}

function mediaKind(value: unknown, label: string): 'image' | 'video' | 'audio' {
  if (value !== 'image' && value !== 'video' && value !== 'audio') throw new RequestValidationError('Invalid reference media', `${label} must be image, video, or audio.`);
  return value;
}

function mediaRole(value: unknown, label: string): 'primary' | 'thumbnail' {
  if (value !== 'primary' && value !== 'thumbnail') throw new RequestValidationError('Invalid reference media', `${label} must be primary or thumbnail.`);
  return value;
}

function kindForContentType(contentType: string): 'image' | 'video' | 'audio' {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  return 'audio';
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('Invalid request', `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RequestValidationError('Invalid request', `${label} must be a non-empty string.`);
  return value;
}
function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RequestValidationError('Invalid request', `${label} must be a finite number.`);
  return value;
}
function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return numberValue(value, label);
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new RequestValidationError('Invalid request', `${label} must be a boolean.`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError('Invalid request', `${label} must be a string.`);
  return value;
}
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
