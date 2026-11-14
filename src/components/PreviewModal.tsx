import { useEffect } from 'react';
import { Download, Star, Trash2, X } from 'lucide-react';
import type { Generation, ModelCatalog, Project, Scene } from '../types';
import type { ResolveMediaUrl } from '../app/useMediaUrls';
import { fmtDur, palStyle } from '../lib/data';
import { generationFailureDetail, generationFailureLabel, generationProgressLabel, generationStatusLabel } from '../lib/generationMedia';
import { displayCatalogValue, modelById, modelName, parameterLabel } from '../lib/modelCatalog';
import { useRecoveringMediaUrl } from '../lib/useRecoveringMediaUrl';

export function PreviewModal({ catalog, entry, mediaUrl, posterUrl, previousGenerationId, nextGenerationId, confirmingDelete, onResolveMediaUrl, onNavigate, onClose, onFavorite, onAskDelete, onCancelDelete, onDelete, onDownload }: {
  catalog: ModelCatalog | null;
  entry: { generation: Generation; scene: Scene; project: Project };
  mediaUrl?: string;
  posterUrl?: string;
  previousGenerationId: string | null;
  nextGenerationId: string | null;
  confirmingDelete: boolean;
  onResolveMediaUrl: ResolveMediaUrl;
  onNavigate: (generationId: string) => void;
  onClose: () => void;
  onFavorite: (sceneId: string, generationId: string) => void;
  onAskDelete: (generationId: string) => void;
  onCancelDelete: () => void;
  onDelete: (sceneId: string, generationId: string) => void;
  onDownload: (generation: Generation) => void;
}) {
  const { generation, scene } = entry;
  const model = modelById(catalog, generation.modelId);
  const pending = generation.status === 'queued' || generation.status === 'running' || generation.status === 'uploading';
  const progressLabel = generationProgressLabel(generation);
  const failureLabel = generationFailureLabel(generation);
  const failureDetail = generationFailureDetail(generation);
  const primaryMedia = useRecoveringMediaUrl(generation, mediaUrl, 'preview', 'primary', onResolveMediaUrl);
  const posterMedia = useRecoveringMediaUrl(generation, posterUrl, 'thumbnail', 'thumbnail', onResolveMediaUrl);
  const previewFailed = Boolean(mediaUrl && !primaryMedia.visibleUrl);
  useEffect(() => {
    if (!generation.media) return;
    if (!mediaUrl) void onResolveMediaUrl(generation, 'preview', 'primary');
    if (generation.type === 'video' && generation.media.thumbnail && !posterUrl) void onResolveMediaUrl(generation, 'thumbnail', 'thumbnail');
  }, [generation.id, generation.media?.key, generation.media?.thumbnail?.key, generation.type, mediaUrl, posterUrl, onResolveMediaUrl]);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft' && previousGenerationId) {
        event.preventDefault();
        onNavigate(previousGenerationId);
      }
      if (event.key === 'ArrowRight' && nextGenerationId) {
        event.preventDefault();
        onNavigate(nextGenerationId);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextGenerationId, onNavigate, previousGenerationId]);
  const generationParams = Object.entries(generation.params ?? {}).map(([key, value]) => [parameterLabel(key), displayCatalogValue(value)]);
  const params = [
    ['Model', model?.displayName ?? modelName(catalog, generation.modelId)], ['Type', generation.type === 'video' ? 'Video' : 'Image'], ['Aspect ratio', generation.ratio], ['Resolution', generation.res],
    ...(generation.type === 'video' ? [['Duration', `${generation.length}s`], ['Frame rate', `${generation.fps} fps`], ['Camera motion', generation.camera ? 'On' : 'Off'], ['Audio', generation.audio ? 'On' : 'Off']] : [['Guidance', String(generation.guidance)]]),
    ...generationParams,
    ['Status', generationStatusLabel(generation.status)], ['Seed', `#${generation.seed || 'random'}`]
  ];
  return <div className={generation.type === 'video' ? 'modal video-modal' : 'modal'} onClick={onClose}><div className="preview" onClick={(event) => event.stopPropagation()}><div className="preview-media" style={palStyle(generation.pal)}>{primaryMedia.visibleUrl && generation.type === 'video' && <video className="media-video" src={primaryMedia.visibleUrl} poster={posterMedia.visibleUrl} onError={primaryMedia.onError} controls playsInline preload="auto" />}{primaryMedia.visibleUrl && generation.type !== 'video' && <img className="media-img" src={primaryMedia.visibleUrl} alt={generation.prompt} onError={primaryMedia.onError} />}{!primaryMedia.visibleUrl && posterMedia.visibleUrl && generation.type === 'video' && <img className="media-img" src={posterMedia.visibleUrl} alt={`${generation.prompt} thumbnail`} onError={posterMedia.onError} />}{!primaryMedia.visibleUrl && !posterMedia.visibleUrl && <div className={generation.status === 'failed' ? 'status-overlay error' : 'status-overlay'}><b>{previewFailed ? 'Preview unavailable' : generation.status === 'failed' ? failureLabel : progressLabel}</b>{pending && <i aria-hidden="true" />}</div>}{generation.type === 'video' && <span>{fmtDur(generation.media?.durationSeconds ?? generation.length)}</span>}<button className="preview-nav prev" disabled={!previousGenerationId} onClick={() => previousGenerationId && onNavigate(previousGenerationId)} aria-label="Previous generation">‹</button><button className="preview-nav next" disabled={!nextGenerationId} onClick={() => nextGenerationId && onNavigate(nextGenerationId)} aria-label="Next generation">›</button></div><aside><header><div><small>Preview</small><strong>{scene.name}</strong></div><button onClick={onClose} aria-label="Close preview"><X size={17} strokeWidth={2.2} /></button></header><div className="preview-scroll"><section><h3>Prompt</h3><p>{generation.prompt}</p></section><section><h3>Parameters</h3>{params.map(([key, value]) => <div className="param" key={key}><span>{key}</span><b>{value}</b></div>)}</section>{generation.status === 'failed' && <section className="preview-error"><h3>Error</h3><p>{failureDetail}</p></section>}</div><footer>{confirmingDelete ? <div className="preview-delete-panel"><span>Delete this generation?</span><button onClick={onCancelDelete}>Cancel</button><button className="danger" onClick={() => onDelete(scene.id, generation.id)}>Delete</button></div> : <><button className={generation.preferred ? 'fav active' : 'fav'} onClick={() => onFavorite(scene.id, generation.id)}><Star size={15} fill={generation.preferred ? 'currentColor' : 'none'} /> {generation.preferred ? 'Favorited' : 'Favorite'}</button><button title="Download" disabled={!generation.media} onClick={() => onDownload(generation)}><Download size={16} /></button><button title={generation.preferred ? 'Unfavorite to delete' : 'Delete'} disabled={generation.preferred} onClick={() => !generation.preferred && onAskDelete(generation.id)}><Trash2 size={16} /></button></>}</footer></aside></div></div>;
}
