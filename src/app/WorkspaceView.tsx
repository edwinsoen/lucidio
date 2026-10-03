import type { Generation, ModelCatalog, PresignAssetRole, Project, Scene } from '../types';
import type { MediaUrlCache } from './useMediaUrls';
import type { GalleryViewMode, UiState } from '../state/uiReducer';
import { WorkspaceHeader } from '../components/WorkspaceHeader';
import { SceneBlock } from '../components/SceneBlock';

export interface WorkspaceViewProps {
  catalog: ModelCatalog | null;
  project: Project | null;
  scene: Scene | null;
  refIds: string[];
  ui: Pick<UiState, 'galleryViewMode' | 'editingProjectId' | 'projectEditValue' | 'editingSceneId' | 'editValue' | 'confirmDeleteSceneId' | 'confirmDeleteGenId' | 'draggingSceneId'>;
  mediaUrls: MediaUrlCache;
  onEditProject: () => void;
  onProjectEditValue: (value: string) => void;
  onCommitProjectEdit: () => void;
  onCancelProjectEdit: () => void;
  onGalleryViewMode: (mode: GalleryViewMode) => void;
  onSetActiveScene: (sceneId: string) => void;
  onEditScene: (scene: Scene) => void;
  onSceneEditValue: (value: string) => void;
  onCommitSceneEdit: () => void;
  onCancelSceneEdit: () => void;
  onAskDeleteScene: (sceneId: string) => void;
  onCancelDeleteScene: () => void;
  onConfirmDeleteScene: (sceneId: string) => void;
  onDragSceneStart: (sceneId: string) => void;
  onDragSceneEnd: () => void;
  onDragSceneOver: (sceneId: string) => void;
  onPreview: (generationId: string) => void;
  onTogglePreferred: (sceneId: string, generationId: string) => void;
  onToggleReference: (generationId: string) => void;
  onAskDeleteGeneration: (generationId: string) => void;
  onCancelDeleteGeneration: () => void;
  onDeleteGeneration: (sceneId: string, generationId: string) => void;
  onDownload: (generation: Generation) => void;
  onResolveMediaUrl: (generation: Generation, purpose?: 'thumbnail' | 'preview' | 'download', role?: PresignAssetRole) => Promise<string | null>;
  onAddScene: () => void;
  onCreateInScene: (sceneId: string) => void;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { catalog, project, scene, refIds, ui, mediaUrls } = props;
  return (
    <main className="workspace">
      {project ? <>
        <WorkspaceHeader
          project={project}
          editingProjectId={ui.editingProjectId}
          projectEditValue={ui.projectEditValue}
          galleryViewMode={ui.galleryViewMode}
          onGalleryViewMode={props.onGalleryViewMode}
          onEdit={props.onEditProject}
          onEditValue={props.onProjectEditValue}
          onCommitEdit={props.onCommitProjectEdit}
          onCancelEdit={props.onCancelProjectEdit}
        />
        <div className="scene-scroll">
          {project.scenes.map((item, index) => (
            <SceneBlock
              key={item.id}
              catalog={catalog}
              scene={item}
              index={index}
              active={item.id === scene?.id}
              refs={refIds}
              confirmDeleteSceneId={ui.confirmDeleteSceneId}
              confirmDeleteGenId={ui.confirmDeleteGenId}
              editingSceneId={ui.editingSceneId}
              editValue={ui.editValue}
              draggingSceneId={ui.draggingSceneId}
              galleryViewMode={ui.galleryViewMode}
              onSetActive={() => props.onSetActiveScene(item.id)}
              onCreate={() => props.onCreateInScene(item.id)}
              onEdit={() => props.onEditScene(item)}
              onEditValue={props.onSceneEditValue}
              onCommitEdit={props.onCommitSceneEdit}
              onCancelEdit={props.onCancelSceneEdit}
              onAskDeleteScene={() => props.onAskDeleteScene(item.id)}
              onCancelDeleteScene={props.onCancelDeleteScene}
              onConfirmDeleteScene={() => props.onConfirmDeleteScene(item.id)}
              onDragStart={() => props.onDragSceneStart(item.id)}
              onDragEnd={props.onDragSceneEnd}
              onDragOver={() => props.onDragSceneOver(item.id)}
              onPreview={props.onPreview}
              onTogglePreferred={props.onTogglePreferred}
              onToggleReference={props.onToggleReference}
              onAskDeleteGen={props.onAskDeleteGeneration}
              onCancelDeleteGen={props.onCancelDeleteGeneration}
              onDeleteGen={props.onDeleteGeneration}
              onDownload={props.onDownload}
              mediaUrls={mediaUrls}
              onResolveMediaUrl={props.onResolveMediaUrl}
            />
          ))}
          <button className="add-scene" onClick={props.onAddScene}><span>+</span> Add scene</button>
        </div>
      </> : <div className="empty-workspace" aria-label="No project open" />}
    </main>
  );
}
