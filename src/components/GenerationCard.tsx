import { useEffect, type KeyboardEvent, type MouseEvent } from 'react';
import { Download, Orbit, Star, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { Generation, ModelCatalog } from '../types';
import type { ResolveMediaUrl } from '../app/useMediaUrls';
import type { GalleryViewMode } from '../state/uiReducer';
import { fmtDur, palStyle } from '../lib/data';
import { generationFailureLabel, generationProgressLabel, generationStatusLabel, previewAssetRole } from '../lib/generationMedia';
import { modelById, modelName } from '../lib/modelCatalog';
import { useRecoveringMediaUrl } from '../lib/useRecoveringMediaUrl';

interface GenerationCardProps {
  catalog: ModelCatalog | null;
  generation: Generation;
  sceneId: string;
  viewMode: GalleryViewMode;
  isRef: boolean;
  confirming: boolean;
  mediaUrl?: string;
  onResolveMediaUrl: ResolveMediaUrl;
  onPreview: (generationId: string) => void;
  onTogglePreferred: (sceneId: string, generationId: string) => void;
  onToggleReference: (generationId: string) => void;
  onAskDelete: (generationId: string) => void;
  onCancelDelete: () => void;
  onDelete: (sceneId: string, generationId: string) => void;
  onDownload: (generation: Generation) => void;
}

export function GenerationCard({
  catalog,
  generation,
  sceneId,
  viewMode,
  isRef,
  confirming,
  mediaUrl,
  onResolveMediaUrl,
  onPreview,
  onTogglePreferred,
  onToggleReference,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onDownload
}: GenerationCardProps) {
  const model = modelById(catalog, generation.modelId);
  const isVideo = generation.type === 'video';
  const isList = viewMode !== 'grid';
  const hasThumbnail = viewMode !== 'compact-list';
  const pending = generation.status === 'queued' || generation.status === 'running' || generation.status === 'uploading';
  const failed = generation.status === 'failed';
  const hasStatusOverlay = pending || failed;
  const pendingVideoList = isList && isVideo && pending;
  const previewRole = previewAssetRole(generation);
  const thumbnailMedia = useRecoveringMediaUrl(generation, mediaUrl, 'thumbnail', previewRole, onResolveMediaUrl);
  const progressLabel = generationProgressLabel(generation);
  const failureLabel = generationFailureLabel(generation);
  const imageStatusLabel = failed ? generationStatusLabel(generation.status) : pending ? progressLabel : generationStatusLabel(generation.status);
  const rowStatusLabel = failed ? failureLabel : progressLabel;
  const thumbnailStatusLabel = isList && failed ? 'Failed' : isList ? progressLabel : rowStatusLabel;

  useEffect(() => {
    if (hasThumbnail && generation.media && !mediaUrl) void onResolveMediaUrl(generation, 'thumbnail', previewRole);
  }, [generation.id, generation.media?.key, hasThumbnail, mediaUrl, onResolveMediaUrl, previewRole]);

  const openPreview = () => onPreview(generation.id);

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (isList && !confirming && !(event.target instanceof Element && event.target.closest('button'))) openPreview();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isList || confirming || event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPreview();
  };

  const thumbnail = hasThumbnail && (
    <button
      className="thumb"
      type="button"
      style={palStyle(generation.pal)}
      onClick={(event) => {
        event.stopPropagation();
        openPreview();
      }}
      aria-label="Preview generation"
    >
      {thumbnailMedia.visibleUrl && <img className="media-img" src={thumbnailMedia.visibleUrl} alt={generation.prompt} onError={thumbnailMedia.onError} />}
      {pendingVideoList && (
        <div className="status-overlay progress-only">
          <span className="status-spinner" aria-hidden="true" />
        </div>
      )}
      {!pendingVideoList && hasStatusOverlay && (
        <div className={failed ? 'status-overlay error' : 'status-overlay'}>
          <b>{thumbnailStatusLabel}</b>
          {pending && !isList && <i aria-hidden="true" />}
          {failed && isVideo && !isList && <span className="status-details-link">Show Details</span>}
        </div>
      )}
      {isVideo && !hasStatusOverlay && (
        <>
          <span className="duration">{fmtDur(generation.length)}</span>
          <i className="play" />
        </>
      )}
    </button>
  );

  const statusLine = isList && hasStatusOverlay && (
    <div className={`${failed ? 'gen-status-line failed' : 'gen-status-line'} ${pending ? 'in-progress' : ''}`}>
      {pendingVideoList && !hasThumbnail && <span className="status-spinner" aria-hidden="true" />}
      <span>{rowStatusLabel}</span>
      {failed && isVideo && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openPreview();
          }}
        >
          Show Details
        </button>
      )}
    </div>
  );

  const promptAndMeta = (
    <>
      <p>{generation.prompt}</p>
      <div className="meta">
        <span>{model?.displayName ?? modelName(catalog, generation.modelId)} · {generation.res}</span>
        {!isVideo && <b>{imageStatusLabel}</b>}
        {isVideo && (
          <b className="meta-icons">
            <span title={generation.camera ? 'Camera motion on' : 'Camera motion off'}>
              <Orbit size={13} className={generation.camera ? 'enabled' : 'disabled'} aria-label={generation.camera ? 'Camera motion on' : 'Camera motion off'} />
            </span>
            {generation.audio ? (
              <span title="Audio on"><Volume2 size={13} className="enabled" aria-label="Audio on" /></span>
            ) : (
              <span title="Audio off"><VolumeX size={13} className="disabled" aria-label="Audio off" /></span>
            )}
          </b>
        )}
      </div>
    </>
  );

  const body = (
    <div className="gen-body">
      {pendingVideoList && statusLine}
      {promptAndMeta}
      {!pendingVideoList && statusLine}
    </div>
  );

  const actions = (
    <div className="gen-actions" onClick={(event) => event.stopPropagation()}>
      <button className={generation.preferred ? 'active' : ''} type="button" title="Mark preferred" onClick={() => onTogglePreferred(sceneId, generation.id)}>
        <Star size={15} fill={generation.preferred ? 'currentColor' : 'none'} />
      </button>
      <button className={isRef ? 'active ref' : 'ref'} type="button" disabled={!generation.media} title={generation.media ? 'Use as reference' : 'Only completed stored media can be references'} onClick={() => onToggleReference(generation.id)}>
        REF
      </button>
      <button type="button" title="Download" disabled={!generation.media} onClick={() => onDownload(generation)}>
        <Download size={15} />
      </button>
      <button type="button" title={generation.preferred ? 'Unfavorite to delete' : 'Delete'} disabled={generation.preferred} onClick={() => onAskDelete(generation.id)}>
        <Trash2 size={15} />
      </button>
    </div>
  );

  return (
    <article
      className={`generation ${viewMode} ${pending ? 'pending' : ''} ${failed ? 'failed' : ''}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      tabIndex={isList && !confirming ? 0 : undefined}
      aria-label={isList && !confirming ? `Preview generation: ${generation.prompt}` : undefined}
    >
      {!confirming ? (
        <>
          {thumbnail}
          {body}
          {actions}
        </>
      ) : (
        <div className="delete-panel">
          <span>Delete this generation?</span>
          <div>
            <button type="button" onClick={onCancelDelete}>Cancel</button>
            <button type="button" className="danger" onClick={() => onDelete(sceneId, generation.id)}>Delete</button>
          </div>
        </div>
      )}
    </article>
  );
}
