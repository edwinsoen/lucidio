import { Pencil, Sparkles, Trash2 } from 'lucide-react';
import type { Generation, ModelCatalog, PresignAssetRole, Scene } from '../types';
import type { GalleryViewMode } from '../state/uiReducer';
import type { MediaUrlCache } from '../app/useMediaUrls';
import { mediaUrlCacheKey, previewAssetRole } from '../lib/generationMedia';
import { GenerationCard } from './GenerationCard';

export function SceneBlock(props: {
  catalog: ModelCatalog | null;
  scene: Scene;
  index: number;
  active: boolean;
  refs: string[];
  confirmDeleteSceneId: string | null;
  confirmDeleteGenId: string | null;
  editingSceneId: string | null;
  editValue: string;
  draggingSceneId: string | null;
  galleryViewMode: GalleryViewMode;
  onSetActive: () => void;
  onCreate: () => void;
  onEdit: () => void;
  onEditValue: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onAskDeleteScene: () => void;
  onCancelDeleteScene: () => void;
  onConfirmDeleteScene: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onPreview: (generationId: string) => void;
  onTogglePreferred: (sceneId: string, generationId: string) => void;
  onToggleReference: (generationId: string) => void;
  onAskDeleteGen: (generationId: string) => void;
  onCancelDeleteGen: () => void;
  onDeleteGen: (sceneId: string, generationId: string) => void;
  onDownload: (generation: Generation) => void;
  mediaUrls: MediaUrlCache;
  onResolveMediaUrl: (generation: Generation, purpose?: 'thumbnail' | 'preview' | 'download', role?: PresignAssetRole) => Promise<string | null>;
}) {
  return (
    <section className={`scene ${props.active ? 'active' : ''} ${props.draggingSceneId === props.scene.id ? 'dragging' : ''}`} onClick={props.onSetActive} onDragOver={(event) => { event.preventDefault(); props.onDragOver(); }} onDrop={props.onDragEnd}>
      <div className="scene-title"><button className="drag" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; props.onDragStart(); }} onDragEnd={props.onDragEnd}>⠿</button><span className="idx">{String(props.index + 1).padStart(2, '0')}</span>{props.editingSceneId === props.scene.id ? <input className="title-edit" autoFocus value={props.editValue} onClick={(event) => event.stopPropagation()} onChange={(event) => props.onEditValue(event.target.value)} onBlur={props.onCommitEdit} onKeyDown={(event) => { if (event.key === 'Enter') props.onCommitEdit(); if (event.key === 'Escape') props.onCancelEdit(); }} /> : <><h2>{props.scene.name}</h2><button className="icon-button" title="Rename scene" onClick={(event) => { event.stopPropagation(); props.onEdit(); }}><Pencil size={14} strokeWidth={2.1} /></button>{props.confirmDeleteSceneId === props.scene.id ? <div className="confirm"><span>Delete this scene?</span><button onClick={(event) => { event.stopPropagation(); props.onCancelDeleteScene(); }}>Cancel</button><button className="danger" onClick={(event) => { event.stopPropagation(); props.onConfirmDeleteScene(); }}>Delete</button></div> : <button className="icon-button danger-text" title="Delete scene" onClick={(event) => { event.stopPropagation(); props.onAskDeleteScene(); }}><Trash2 size={14} strokeWidth={2.1} /></button>}</>}<button className="scene-create" onClick={(event) => { event.stopPropagation(); props.onCreate(); }}><Sparkles size={14} strokeWidth={2.2} /> Create</button></div>
      <div className={`gen-grid ${props.galleryViewMode}`}>{props.scene.gens.map((generation) => <GenerationCard key={generation.id} catalog={props.catalog} generation={generation} sceneId={props.scene.id} viewMode={props.galleryViewMode} isRef={props.refs.includes(generation.id)} confirming={props.confirmDeleteGenId === generation.id} mediaUrl={props.mediaUrls[mediaUrlCacheKey(generation, previewAssetRole(generation), 'thumbnail')]?.url} onResolveMediaUrl={props.onResolveMediaUrl} onPreview={props.onPreview} onTogglePreferred={props.onTogglePreferred} onToggleReference={props.onToggleReference} onAskDelete={props.onAskDeleteGen} onCancelDelete={props.onCancelDeleteGen} onDelete={props.onDeleteGen} onDownload={props.onDownload} />)}</div>
    </section>
  );
}
