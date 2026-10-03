import type { Generation, ModelCatalogEntry, VideoReferenceIntent } from '../types';
import { isImageAsset, isVideoAsset } from './generationMedia';

export function supportedReferenceIntents(model: ModelCatalogEntry | null): VideoReferenceIntent[] {
  return model?.modality === 'video' ? model.capabilities.referenceIntents ?? [] : [];
}

export function referenceIntentLabel(intent: VideoReferenceIntent): string {
  switch (intent) {
    case 'image_reference': return 'Image reference';
    case 'first_frame': return 'First frame';
    case 'last_frame': return 'Last frame';
    case 'source_video': return 'Source video';
    case 'audio_reference': return 'Audio reference';
    case 'sample_task': return 'Sample task';
  }
}

export function referenceIntentOptions(model: ModelCatalogEntry | null, generation: Generation): VideoReferenceIntent[] {
  const media = generation.media;
  if (!media) return [];
  if (model?.modality !== 'video') return isImageAsset(media) ? ['image_reference'] : [];

  const supported = supportedReferenceIntents(model);
  const options: VideoReferenceIntent[] = [];
  const hasPrimaryImage = isImageAsset(media);
  const hasThumbnailImage = isImageAsset(media.thumbnail);
  if (isVideoAsset(media) && supported.includes('source_video')) options.push('source_video');
  if (hasPrimaryImage && supported.includes('first_frame')) options.push('first_frame');
  for (const intent of ['last_frame', 'image_reference'] as const) {
    if ((hasPrimaryImage || hasThumbnailImage) && supported.includes(intent)) options.push(intent);
  }
  return options;
}

export function defaultReferenceIntent(model: ModelCatalogEntry | null, generation: Generation): VideoReferenceIntent | null {
  return referenceIntentOptions(model, generation)[0] ?? null;
}
