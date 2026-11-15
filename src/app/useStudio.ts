import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import type { Generation, GenerationControls, OutputMode, VideoReferenceIntent } from '../types';
import type { GalleryViewMode } from '../state/uiReducer';
import { buildDefaultState, makeId } from '../lib/data';
import { firstModel, modelById, supportsLocalReferenceUpload, type ParamPatch } from '../lib/modelCatalog';
import { deleteGenerationThumbnails } from '../lib/thumbnailCache';
import { activeProject, activeScene, generationIndex, previewNavigation, selectedReferenceGenerations } from '../state/studioSelectors';
import { nextSequence, studioReducer, type StudioAction } from '../state/studioReducer';
import { initialUiState, uiReducer } from '../state/uiReducer';
import { useGenerationJobs } from './useGenerationJobs';
import { useMediaUrls } from './useMediaUrls';
import { useStudioBootstrap } from './useStudioBootstrap';
import { api } from '../lib/api';

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

  const dispatchUserStudio = useCallback((action: StudioAction) => {
    dispatchUi({ type: 'api-status', apiStatus: '' });
    dispatchStudio(action);
  }, []);

  const setReferenceIntent = useCallback((generationId: string, intent: VideoReferenceIntent) => {
    dispatchUserStudio({ type: 'set-reference-intent', generationId, intent });
  }, [dispatchUserStudio]);

  const setControls = useCallback((patch: Partial<GenerationControls> & { params?: ParamPatch }) => {
    dispatchUserStudio({ type: 'set-controls', catalog: modelCatalog, patch });
  }, [dispatchUserStudio, modelCatalog]);

  const setMode = useCallback((mode: OutputMode) => {
    const selected = firstModel(modelCatalog, mode);
    dispatchUserStudio({ type: 'set-mode', catalog: modelCatalog, mode, modelId: selected?.id ?? '' });
  }, [dispatchUserStudio, modelCatalog]);

  const [generating, setGenerating] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const uploadingReferenceRef = useRef(false);
  const uploadReference = useCallback(async (file: File) => {
    if (uploadingReferenceRef.current || !project || !scene || !currentModel || !supportsLocalReferenceUpload(currentModel)) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 30 * 1024 * 1024) {
      dispatchUi({ type: 'api-status', apiStatus: 'Choose a JPEG, PNG, or WebP image up to 30 MB.' });
      return;
    }
    const selectedCount = refs.length + (state.uploadedReferences ?? []).filter((reference) => reference.projectId === project.id && (!reference.sceneId || reference.sceneId === scene.id)).length;
    const maxReferences = currentModel.capabilities.maxReferenceImages ?? 10;
    if (selectedCount >= maxReferences) {
      dispatchUi({ type: 'api-status', apiStatus: `${currentModel.displayName} supports at most ${maxReferences} reference images.` });
      return;
    }
    uploadingReferenceRef.current = true;
    setUploadingReference(true);
    dispatchUi({ type: 'api-status', apiStatus: '' });
    try {
      const media = await api.uploadReference(currentModel.id, file);
      dispatchStudio({ type: 'add-uploaded-reference', reference: { id: crypto.randomUUID(), projectId: project.id, sceneId: scene.id, name: file.name, media } });
    } catch (error) {
      dispatchUi({ type: 'api-status', apiStatus: `Reference upload failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      uploadingReferenceRef.current = false;
      setUploadingReference(false);
    }
  }, [currentModel, project, scene, refs.length, state.uploadedReferences]);
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
    dispatchUserStudio({ type: 'new-project', sceneId: makeId('sc', seqScene), projectId: makeId('p', seqProject), seq: seqProject, catalog: modelCatalog });
  }, [dispatchUserStudio, modelCatalog, state]);

  const addScene = useCallback(() => {
    const seq = nextSequence(state);
    dispatchUserStudio({ type: 'add-scene', sceneId: makeId('sc', seq), seq });
  }, [dispatchUserStudio, state]);

  const commitProjectName = useCallback(() => {
    if (!ui.editingProjectId) return;
    dispatchUserStudio({ type: 'rename-project', projectId: ui.editingProjectId, name: ui.projectEditValue });
    dispatchUi({ type: 'clear-project-edit' });
  }, [dispatchUserStudio, ui.editingProjectId, ui.projectEditValue]);

  const commitSceneName = useCallback(() => {
    if (!ui.editingSceneId) return;
    dispatchUserStudio({ type: 'rename-scene', sceneId: ui.editingSceneId, name: ui.editValue });
    dispatchUi({ type: 'clear-scene-edit' });
  }, [dispatchUserStudio, ui.editValue, ui.editingSceneId]);

  const deleteScene = useCallback((sceneId: string) => {
    const sceneToDelete = project?.scenes.find((item) => item.id === sceneId);
    if (sceneToDelete) void Promise.allSettled(sceneToDelete.gens.map((generation) => deleteGenerationThumbnails(generation)));
    dispatchUserStudio({ type: 'delete-scene', sceneId });
    dispatchUi({ type: 'clear-delete-scene' });
  }, [dispatchUserStudio, project]);

  const deleteGeneration = useCallback((sceneId: string, generationId: string) => {
    void deleteGenerationThumbnails(genIndex.get(generationId)?.generation);
    dispatchUserStudio({ type: 'delete-generation', sceneId, generationId });
    dispatchUi({ type: 'generation-deleted', generationId });
  }, [dispatchUserStudio, genIndex]);

  const closeProject = useCallback(() => {
    if (!ui.confirmDeleteProjectId) return;
    const projectToDelete = state.projects.find((item) => item.id === ui.confirmDeleteProjectId);
    if (projectToDelete) {
      const generations = projectToDelete.scenes.flatMap((sceneItem) => sceneItem.gens);
      void Promise.allSettled(generations.map((generation) => deleteGenerationThumbnails(generation)));
    }
    dispatchUserStudio({ type: 'delete-project', projectId: ui.confirmDeleteProjectId });
    dispatchUi({ type: 'clear-delete-project' });
  }, [dispatchUserStudio, state.projects, ui.confirmDeleteProjectId]);

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
      onSelectProject: (projectId: string) => dispatchUserStudio({ type: 'set-active-project', projectId }),
      onToggleProjectMenu: (projectId: string, anchor: { top: number; right: number }) => dispatchUi({ type: 'toggle-project-menu', projectId, anchor }),
      onRequestDeleteProject: (projectId: string) => dispatchUi({ type: 'request-delete-project', projectId }),
      onNewProject: newProject
    },
    sidebarProps: {
      catalog: modelCatalog,
      controls: state.ctl,
      currentModel,
      references: refs,
      uploadedReferences: supportsLocalReferenceUpload(currentModel)
        ? (state.uploadedReferences ?? []).filter((reference) => reference.projectId === project?.id && (!reference.sceneId || reference.sceneId === scene?.id))
        : [],
      uploadingReference,
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
      onUploadReference: uploadReference,
      onRemoveUploadedReference: (referenceId: string) => dispatchUserStudio({ type: 'remove-uploaded-reference', referenceId }),
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
      onSetActiveScene: (sceneId: string) => dispatchUserStudio({ type: 'set-active-scene', sceneId }),
      onEditScene: (sceneItem: { id: string; name: string }) => dispatchUi({ type: 'edit-scene', sceneId: sceneItem.id, value: sceneItem.name }),
      onSceneEditValue: (value: string) => dispatchUi({ type: 'scene-edit-value', value }),
      onCommitSceneEdit: commitSceneName,
      onCancelSceneEdit: () => dispatchUi({ type: 'clear-scene-edit' }),
      onAskDeleteScene: (sceneId: string) => dispatchUi({ type: 'request-delete-scene', sceneId }),
      onCancelDeleteScene: () => dispatchUi({ type: 'clear-delete-scene' }),
      onConfirmDeleteScene: deleteScene,
      onDragSceneStart: (sceneId: string) => dispatchUi({ type: 'drag-scene', sceneId }),
      onDragSceneEnd: () => dispatchUi({ type: 'drag-scene', sceneId: null }),
      onDragSceneOver: (sceneId: string) => ui.draggingSceneId && dispatchUserStudio({ type: 'move-scene', fromId: ui.draggingSceneId, toId: sceneId }),
      onPreview: (generationId: string) => dispatchUi({ type: 'preview', generationId }),
      onTogglePreferred: (sceneId: string, generationId: string) => dispatchUserStudio({ type: 'toggle-preferred', sceneId, generationId }),
      onToggleReference: toggleReference,
      onAskDeleteGeneration: (generationId: string) => dispatchUi({ type: 'request-delete-generation', generationId }),
      onCancelDeleteGeneration: () => dispatchUi({ type: 'clear-delete-generation' }),
      onDeleteGeneration: deleteGeneration,
      onDownload,
      onResolveMediaUrl: ensureMediaUrl,
      onAddScene: addScene,
      onCreateInScene: (sceneId: string) => { dispatchUserStudio({ type: 'set-active-scene', sceneId }); dispatchUi({ type: 'open-composer' }); }
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
      onTogglePreferred: (sceneId: string, generationId: string) => dispatchUserStudio({ type: 'toggle-preferred', sceneId, generationId }),
      onAskDeleteGeneration: (generationId: string) => dispatchUi({ type: 'request-delete-generation', generationId }),
      onCancelDeleteGeneration: () => dispatchUi({ type: 'clear-delete-generation' }),
      onDeleteGeneration: deleteGeneration,
      onDownload
    }
  };
}
