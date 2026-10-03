import type { Generation, ModelCatalog, PresignAssetRole, Project } from '../types';
import type { GenerationEntry } from '../state/studioSelectors';
import { mediaUrlCacheKey } from '../lib/generationMedia';
import type { MediaUrlCache } from './useMediaUrls';
import { ProjectDeleteDialog } from '../components/ProjectDeleteDialog';
import { PreviewModal } from '../components/PreviewModal';

export interface StudioOverlaysProps {
  catalog: ModelCatalog | null;
  projects: Project[];
  confirmDeleteProjectId: string | null;
  preview: GenerationEntry | null;
  mediaUrls: MediaUrlCache;
  previousGenerationId: string | null;
  nextGenerationId: string | null;
  confirmingDeleteGenerationId: string | null;
  onCancelDeleteProject: () => void;
  onConfirmDeleteProject: () => void;
  onResolveMediaUrl: (generation: Generation, purpose?: 'thumbnail' | 'preview' | 'download', role?: PresignAssetRole) => Promise<string | null>;
  onNavigatePreview: (generationId: string) => void;
  onClosePreview: () => void;
  onTogglePreferred: (sceneId: string, generationId: string) => void;
  onAskDeleteGeneration: (generationId: string) => void;
  onCancelDeleteGeneration: () => void;
  onDeleteGeneration: (sceneId: string, generationId: string) => void;
  onDownload: (generation: Generation) => void;
}

export function StudioOverlays(props: StudioOverlaysProps) {
  const project = props.projects.find((item) => item.id === props.confirmDeleteProjectId) ?? null;
  return (
    <>
      {props.confirmDeleteProjectId && <ProjectDeleteDialog
        project={project}
        onCancel={props.onCancelDeleteProject}
        onConfirm={props.onConfirmDeleteProject}
      />}
      {props.preview && <PreviewModal
        catalog={props.catalog}
        entry={props.preview}
        mediaUrl={props.mediaUrls[mediaUrlCacheKey(props.preview.generation, 'primary')]?.url}
        posterUrl={props.mediaUrls[mediaUrlCacheKey(props.preview.generation, 'thumbnail', 'thumbnail')]?.url}
        previousGenerationId={props.previousGenerationId}
        nextGenerationId={props.nextGenerationId}
        confirmingDelete={props.confirmingDeleteGenerationId === props.preview.generation.id}
        onResolveMediaUrl={props.onResolveMediaUrl}
        onNavigate={props.onNavigatePreview}
        onClose={props.onClosePreview}
        onFavorite={props.onTogglePreferred}
        onAskDelete={props.onAskDeleteGeneration}
        onCancelDelete={props.onCancelDeleteGeneration}
        onDelete={props.onDeleteGeneration}
        onDownload={props.onDownload}
      />}
    </>
  );
}
