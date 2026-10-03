import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import type { Generation, GenerationControls, OutputMode, VideoReferenceIntent } from '../types';
import type { GalleryViewMode } from '../state/uiReducer';
import { buildDefaultState, makeId } from '../lib/data';
import { firstModel, modelById, type ParamPatch } from '../lib/modelCatalog';
import { deleteGenerationThumbnails } from '../lib/thumbnailCache';
import { activeProject, activeScene, generationIndex, previewNavigation, selectedReferenceGenerations } from '../state/studioSelectors';
import { nextSequence, studioReducer } from '../state/studioReducer';
import { initialUiState, uiReducer } from '../state/uiReducer';
import { useGenerationJobs } from './useGenerationJobs';
import { useMediaUrls } from './useMediaUrls';
import { useStudioBootstrap } from './useStudioBootstrap';

export function useStudio() {
  const [state, dispatchStudio] = useReducer(studioReducer, undefined, buildDefaultState);
  const [ui, dispatchUi] = useReducer(uiReducer, initialUiState);
  const modelCatalog = useStudioBootstrap({ state, hydrated: ui.hydrated, dispatchStudio, dispatchUi });
  const currentModel = modelById(modelCatalog, state.ctl.modelId);
  const project = activeProject(state);
  const scene = activeScene(state);
  const genIndex = useMemo(() => generationIndex(state), [state]);
  const refs = useMemo(() => selectedReferenceGenerations(state, genIndex), [state, genIndex]);
  const preview = useMemo(() => previewNavigation(ui.previewGenId, genIndex), [ui.previewGenId, genIndex]);
  const { mediaUrls, ensureMediaUrl, download } = useMediaUrls(dispatchUi);
  const { generate, toggleReference } = useGenerationJobs({ state, modelCatalog, genIndex, hydrated: ui.hydrated, dispatchStudio, dispatchUi });

  const setReferenceIntent = useCallback((generationId: string, intent: VideoReferenceIntent) => {
    dispatchStudio({ type: 'set-reference-intent', generationId, intent });
  }, []);

  const setControls = useCallback((patch: Partial<GenerationControls> & { params?: ParamPatch }) => {
    dispatchStudio({ type: 'set-controls', catalog: modelCatalog, patch });
  }, [modelCatalog]);

  const setMode = useCallback((mode: OutputMode) => {
    const selected = firstModel(modelCatalog, mode);
    dispatchStudio({ type: 'set-mode', catalog: modelCatalog, mode, modelId: selected?.id ?? '' });
  }, [modelCatalog]);

  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);

  const runGenerate = useCallback(async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    try {
      if (await generate()) dispatchUi({ type: 'close-composer' });
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }, [generate]);

  const newProject = useCallback(() => {
    const seqScene = nextSequence(state);
    const seqProject = seqScene + 1;
    dispatchStudio({ type: 'new-project', sceneId: makeId('sc', seqScene), projectId: makeId('p', seqProject), seq: seqProject });
  }, [state]);

  const addScene = useCallback(() => {
    const seq = nextSequence(state);
    dispatchStudio({ type: 'add-scene', sceneId: makeId('sc', seq), seq });
  }, [state]);

  const commitProjectName = useCallback(() => {
    if (!ui.editingProjectId) return;
    dispatchStudio({ type: 'rename-project', projectId: ui.editingProjectId, name: ui.projectEditValue });
    dispatchUi({ type: 'clear-project-edit' });
  }, [ui.editingProjectId, ui.projectEditValue]);

  const commitSceneName = useCallback(() => {
    if (!ui.editingSceneId) return;
    dispatchStudio({ type: 'rename-scene', sceneId: ui.editingSceneId, name: ui.editValue });
    dispatchUi({ type: 'clear-scene-edit' });
  }, [ui.editValue, ui.editingSceneId]);

  const deleteScene = useCallback((sceneId: string) => {
    const sceneToDelete = project?.scenes.find((item) => item.id === sceneId);
    if (sceneToDelete) void Promise.allSettled(sceneToDelete.gens.map((generation) => deleteGenerationThumbnails(generation)));
    dispatchStudio({ type: 'delete-scene', sceneId });
    dispatchUi({ type: 'clear-delete-scene' });
  }, [project]);

  const deleteGeneration = useCallback((sceneId: string, generationId: string) => {
    void deleteGenerationThumbnails(genIndex.get(generationId)?.generation);
    dispatchStudio({ type: 'delete-generation', sceneId, generationId });
    dispatchUi({ type: 'generation-deleted', generationId });
  }, [genIndex]);

  const closeProject = useCallback(() => {
    if (!ui.confirmDeleteProjectId) return;
    const projectToDelete = state.projects.find((item) => item.id === ui.confirmDeleteProjectId);
    if (projectToDelete) {
      const generations = projectToDelete.scenes.flatMap((sceneItem) => sceneItem.gens);
      void Promise.allSettled(generations.map((generation) => deleteGenerationThumbnails(generation)));
    }
    dispatchStudio({ type: 'delete-project', projectId: ui.confirmDeleteProjectId });
    dispatchUi({ type: 'clear-delete-project' });
  }, [state.projects, ui.confirmDeleteProjectId]);

  const onDownload = useCallback((generation: Generation) => {
    void download(generation);
  }, [download]);

  return {
    headerProps: {
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      openProjectMenuId: ui.openProjectMenuId,
      projectMenuAnchor: ui.projectMenuAnchor,
      catalog: modelCatalog,
      onSelectProject: (projectId: string) => dispatchStudio({ type: 'set-active-project', projectId }),
      onToggleProjectMenu: (projectId: string, anchor: { top: number; right: number }) => dispatchUi({ type: 'toggle-project-menu', projectId, anchor }),
      onRequestDeleteProject: (projectId: string) => dispatchUi({ type: 'request-delete-project', projectId }),
      onNewProject: newProject
    },
    sidebarProps: {
      catalog: modelCatalog,
      controls: state.ctl,
      currentModel,
      references: refs,
      referenceSelections: state.referenceSelections ?? [],
      mediaUrls,
      apiStatus: ui.apiStatus,
      canGenerate: Boolean(project && scene && currentModel),
      generating,
      composerOpen: ui.composerOpen,
      onCloseComposer: () => dispatchUi({ type: 'close-composer' }),
      onSetMode: setMode,
      onControls: setControls,
      onReferenceIntent: setReferenceIntent,
      onRemoveRef: toggleReference,
      onGenerate: runGenerate,
      onResolveMediaUrl: ensureMediaUrl
    },
    workspaceProps: {
      catalog: modelCatalog,
      project,
      scene,
      refIds: state.refIds,
      ui,
      mediaUrls,
      onEditProject: () => project && dispatchUi({ type: 'edit-project', projectId: project.id, value: project.name }),
      onProjectEditValue: (value: string) => dispatchUi({ type: 'project-edit-value', value }),
      onCommitProjectEdit: commitProjectName,
      onCancelProjectEdit: () => dispatchUi({ type: 'clear-project-edit' }),
      onGalleryViewMode: (mode: GalleryViewMode) => dispatchUi({ type: 'gallery-view-mode', mode }),
      onSetActiveScene: (sceneId: string) => dispatchStudio({ type: 'set-active-scene', sceneId }),
      onEditScene: (sceneItem: { id: string; name: string }) => dispatchUi({ type: 'edit-scene', sceneId: sceneItem.id, value: sceneItem.name }),
      onSceneEditValue: (value: string) => dispatchUi({ type: 'scene-edit-value', value }),
      onCommitSceneEdit: commitSceneName,
      onCancelSceneEdit: () => dispatchUi({ type: 'clear-scene-edit' }),
      onAskDeleteScene: (sceneId: string) => dispatchUi({ type: 'request-delete-scene', sceneId }),
      onCancelDeleteScene: () => dispatchUi({ type: 'clear-delete-scene' }),
      onConfirmDeleteScene: deleteScene,
      onDragSceneStart: (sceneId: string) => dispatchUi({ type: 'drag-scene', sceneId }),
      onDragSceneEnd: () => dispatchUi({ type: 'drag-scene', sceneId: null }),
      onDragSceneOver: (sceneId: string) => ui.draggingSceneId && dispatchStudio({ type: 'move-scene', fromId: ui.draggingSceneId, toId: sceneId }),
      onPreview: (generationId: string) => dispatchUi({ type: 'preview', generationId }),
      onTogglePreferred: (sceneId: string, generationId: string) => dispatchStudio({ type: 'toggle-preferred', sceneId, generationId }),
      onToggleReference: toggleReference,
      onAskDeleteGeneration: (generationId: string) => dispatchUi({ type: 'request-delete-generation', generationId }),
      onCancelDeleteGeneration: () => dispatchUi({ type: 'clear-delete-generation' }),
      onDeleteGeneration: deleteGeneration,
      onDownload,
      onResolveMediaUrl: ensureMediaUrl,
      onAddScene: addScene,
      onCreateInScene: (sceneId: string) => { dispatchStudio({ type: 'set-active-scene', sceneId }); dispatchUi({ type: 'open-composer' }); }
    },
    overlayProps: {
      catalog: modelCatalog,
      projects: state.projects,
      confirmDeleteProjectId: ui.confirmDeleteProjectId,
      preview: preview.preview,
      mediaUrls,
      previousGenerationId: preview.previousGenerationId,
      nextGenerationId: preview.nextGenerationId,
      confirmingDeleteGenerationId: ui.confirmDeleteGenId,
      onCancelDeleteProject: () => dispatchUi({ type: 'clear-delete-project' }),
      onConfirmDeleteProject: closeProject,
      onResolveMediaUrl: ensureMediaUrl,
      onNavigatePreview: (generationId: string) => dispatchUi({ type: 'navigate-preview', generationId }),
      onClosePreview: () => dispatchUi({ type: 'close-preview' }),
      onTogglePreferred: (sceneId: string, generationId: string) => dispatchStudio({ type: 'toggle-preferred', sceneId, generationId }),
      onAskDeleteGeneration: (generationId: string) => dispatchUi({ type: 'request-delete-generation', generationId }),
      onCancelDeleteGeneration: () => dispatchUi({ type: 'clear-delete-generation' }),
      onDeleteGeneration: deleteGeneration,
      onDownload
    }
  };
}
