import type { AppState, Generation, GenerationControls, GenerationProgress, GenerationReferenceSelection, ModelCatalog, OutputMode, Project, Scene, UploadedReference, VideoReferenceIntent } from '../types';
import { cloneControls, defaultControls } from '../lib/data';
import { normalizeControls, normalizeStateForCatalog, type ParamPatch } from '../lib/modelCatalog';
import { activeProject } from './studioSelectors';

export type StudioAction =
  | { type: 'hydrate'; state: AppState }
  | { type: 'normalize-for-catalog'; catalog: ModelCatalog | null }
  | { type: 'set-controls'; catalog: ModelCatalog | null; patch: Partial<GenerationControls> & { params?: ParamPatch } }
  | { type: 'set-mode'; catalog: ModelCatalog | null; mode: OutputMode; modelId: string }
  | { type: 'set-active-project'; projectId: string }
  | { type: 'set-active-scene'; sceneId: string | null }
  | { type: 'new-project'; projectId: string; sceneId: string; seq: number; catalog?: ModelCatalog | null }
  | { type: 'delete-project'; projectId: string }
  | { type: 'add-scene'; sceneId: string; seq: number }
  | { type: 'rename-project'; projectId: string; name: string }
  | { type: 'rename-scene'; sceneId: string; name: string }
  | { type: 'delete-scene'; sceneId: string }
  | { type: 'move-scene'; fromId: string; toId: string }
  | { type: 'set-reference-intent'; generationId: string; intent: VideoReferenceIntent }
  | { type: 'prune-references' }
  | { type: 'add-uploaded-reference'; reference: UploadedReference }
  | { type: 'remove-uploaded-reference'; referenceId: string }
  | { type: 'toggle-reference'; generationId: string; intent: VideoReferenceIntent }
  | { type: 'toggle-preferred'; sceneId: string; generationId: string }
  | { type: 'insert-generation'; generation: Generation; seq: number; projectId?: string | null; sceneId?: string | null }
  | { type: 'patch-generation'; generationId: string; patch: Partial<Generation> }
  | { type: 'delete-generation'; sceneId: string; generationId: string };

export function studioReducer(state: AppState, action: StudioAction): AppState {
  switch (action.type) {
    case 'hydrate':
      return pruneReferences(syncActiveSceneIntoProjects(action.state));
    case 'normalize-for-catalog':
      return normalizeStateForCatalog(syncActiveSceneIntoProjects(state), action.catalog);
    case 'set-controls':
      return syncActiveSceneIntoProjects({ ...state, ctl: normalizeControls(action.catalog, state.ctl, action.patch) });
    case 'set-mode':
      return syncActiveSceneIntoProjects({ ...state, ctl: normalizeControls(action.catalog, state.ctl, { mode: action.mode, modelId: action.modelId }) });
    case 'set-active-project': {
      const synced = syncActiveSceneIntoProjects(state);
      const selected = synced.projects.find((project) => project.id === action.projectId);
      if (!selected) return state;
      const targetScene = selected.scenes.find((scene) => scene.id === selected.activeSceneId) ?? selected.scenes[0] ?? null;
      return loadSceneIntoTopLevel({ ...synced, activeProjectId: action.projectId, activeSceneId: targetScene?.id ?? null }, targetScene);
    }
    case 'set-active-scene': {
      const synced = syncActiveSceneIntoProjects(state);
      const project = activeProject(synced);
      const targetScene = project?.scenes.find((scene) => scene.id === action.sceneId) ?? null;
      const withProjectScene = updateActiveProject(synced, (item) => ({ ...item, activeSceneId: action.sceneId }));
      return loadSceneIntoTopLevel({ ...withProjectScene, activeSceneId: action.sceneId }, targetScene);
    }
    case 'new-project': {
      const synced = syncActiveSceneIntoProjects(state);
      const freshCtl = normalizeControls(action.catalog ?? null, cloneControls(defaultControls));
      const nextScene: Scene = {
        id: action.sceneId,
        name: 'Scene 1',
        gens: [],
        ctl: freshCtl,
        refIds: [],
        referenceSelections: []
      };
      const nextProject: Project = {
        id: action.projectId,
        name: 'Untitled project',
        accent: '#6366f1',
        activeSceneId: action.sceneId,
        scenes: [nextScene]
      };
      return {
        ...synced,
        seq: action.seq,
        projects: [...synced.projects, nextProject],
        activeProjectId: action.projectId,
        activeSceneId: action.sceneId,
        ctl: cloneControls(freshCtl),
        refIds: [],
        referenceSelections: []
      };
    }
    case 'delete-project': {
      const synced = syncActiveSceneIntoProjects(state);
      const projects = synced.projects.filter((item) => item.id !== action.projectId);
      const uploadedReferences = (synced.uploadedReferences ?? []).filter((reference) => reference.projectId !== action.projectId);
      if (synced.activeProjectId !== action.projectId) return pruneReferences({ ...synced, projects, uploadedReferences });
      const next = projects[0] ?? null;
      const nextScene = next?.scenes.find((scene) => scene.id === next.activeSceneId) ?? next?.scenes[0] ?? null;
      return pruneReferences(loadSceneIntoTopLevel({
        ...synced,
        projects,
        uploadedReferences,
        activeProjectId: next?.id ?? null,
        activeSceneId: nextScene?.id ?? null
      }, nextScene));
    }
    case 'add-scene': {
      const synced = syncActiveSceneIntoProjects(state);
      const copiedCtl: GenerationControls = { ...cloneControls(synced.ctl), prompt: '' };
      const newScene: Scene = {
        id: action.sceneId,
        name: 'New scene',
        gens: [],
        ctl: copiedCtl,
        refIds: [],
        referenceSelections: []
      };
      return {
        ...updateActiveProject(synced, (project) => ({
          ...project,
          activeSceneId: action.sceneId,
          scenes: [...project.scenes, newScene]
        })),
        seq: action.seq,
        activeSceneId: action.sceneId,
        ctl: cloneControls(copiedCtl),
        refIds: [],
        referenceSelections: []
      };
    }
    case 'rename-project': {
      const name = action.name.trim();
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.projectId ? { ...project, name: name || project.name } : project)
      };
    }
    case 'rename-scene': {
      const name = action.name.trim();
      return updateActiveProject(state, (project) => ({
        ...project,
        scenes: project.scenes.map((scene) => scene.id === action.sceneId ? { ...scene, name: name || scene.name } : scene)
      }));
    }
    case 'delete-scene': {
      const synced = syncActiveSceneIntoProjects(state);
      const project = activeProject(synced);
      if (!project) return state;
      const scenes = project.scenes.filter((scene) => scene.id !== action.sceneId);
      const uploadedReferences = (synced.uploadedReferences ?? []).filter((reference) => reference.sceneId !== action.sceneId);
      const nextActiveSceneId = synced.activeSceneId === action.sceneId ? scenes[0]?.id ?? null : synced.activeSceneId;
      const nextScene = scenes.find((scene) => scene.id === nextActiveSceneId) ?? null;
      return pruneReferences(loadSceneIntoTopLevel({
        ...updateActiveProject(synced, (item) => ({ ...item, activeSceneId: nextActiveSceneId, scenes })),
        uploadedReferences,
        activeSceneId: nextActiveSceneId
      }, nextScene));
    }
    case 'move-scene': {
      if (!action.fromId || action.fromId === action.toId) return state;
      return updateActiveProject(state, (project) => {
        const scenes = [...project.scenes];
        const fromIndex = scenes.findIndex((scene) => scene.id === action.fromId);
        const toIndex = scenes.findIndex((scene) => scene.id === action.toId);
        if (fromIndex < 0 || toIndex < 0) return project;
        const [moved] = scenes.splice(fromIndex, 1);
        scenes.splice(toIndex, 0, moved);
        return { ...project, scenes };
      });
    }
    case 'set-reference-intent':
      return syncActiveSceneIntoProjects(setReferenceIntent(state, action.generationId, action.intent));
    case 'prune-references':
      return pruneReferences(syncActiveSceneIntoProjects(state));
    case 'add-uploaded-reference':
      return { ...state, uploadedReferences: [...(state.uploadedReferences ?? []), action.reference] };
    case 'remove-uploaded-reference':
      return { ...state, uploadedReferences: (state.uploadedReferences ?? []).filter((reference) => reference.id !== action.referenceId) };
    case 'toggle-reference': {
      const nextState = state.refIds.includes(action.generationId)
        ? {
            ...state,
            refIds: state.refIds.filter((id) => id !== action.generationId),
            referenceSelections: (state.referenceSelections ?? []).filter((selection) => selection.generationId !== action.generationId)
          }
        : {
            ...state,
            refIds: [...state.refIds, action.generationId],
            referenceSelections: [...(state.referenceSelections ?? []).filter((selection) => selection.generationId !== action.generationId), { generationId: action.generationId, intent: action.intent }]
          };
      return syncActiveSceneIntoProjects(nextState);
    }
    case 'toggle-preferred':
      return updateActiveProject(state, (project) => ({
        ...project,
        scenes: project.scenes.map((scene) => scene.id !== action.sceneId ? scene : {
          ...scene,
          gens: scene.gens.map((generation) => ({ ...generation, preferred: generation.id === action.generationId ? !generation.preferred : false }))
        })
      }));
    case 'insert-generation': {
      const targetProjectId = action.projectId ?? state.activeProjectId;
      const targetSceneId = action.sceneId ?? state.activeSceneId;
      return {
        ...state,
        projects: state.projects.map((project) => project.id !== targetProjectId ? project : {
          ...project,
          scenes: project.scenes.map((scene) => scene.id === targetSceneId ? { ...scene, gens: [action.generation, ...scene.gens] } : scene)
        }),
        seq: action.seq
      };
    }
    case 'patch-generation':
      return updateGeneration(state, action.generationId, action.patch);
    case 'delete-generation':
      return pruneReferences(syncActiveSceneIntoProjects({
        ...updateActiveProject(state, (project) => ({
          ...project,
          scenes: project.scenes.map((scene) => scene.id === action.sceneId ? { ...scene, gens: scene.gens.filter((generation) => generation.id !== action.generationId) } : scene)
        })),
        refIds: state.refIds.filter((id) => id !== action.generationId),
        referenceSelections: (state.referenceSelections ?? []).filter((selection) => selection.generationId !== action.generationId)
      }));
  }
}

function syncActiveSceneIntoProjects(state: AppState): AppState {
  if (!state.activeProjectId || !state.activeSceneId) return state;
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== state.activeProjectId ? project : {
      ...project,
      activeSceneId: state.activeSceneId,
      scenes: project.scenes.map((scene) => scene.id !== state.activeSceneId ? scene : {
        ...scene,
        ctl: cloneControls(state.ctl),
        refIds: [...state.refIds],
        referenceSelections: [...(state.referenceSelections ?? [])]
      })
    })
  };
}

function loadSceneIntoTopLevel(state: AppState, scene: Scene | null): AppState {
  if (!scene) {
    return {
      ...state,
      ctl: cloneControls(defaultControls),
      refIds: [],
      referenceSelections: []
    };
  }
  const ctl = scene.ctl ? cloneControls(scene.ctl) : cloneControls(defaultControls);
  const refIds = Array.isArray(scene.refIds) ? [...scene.refIds] : [];
  const referenceSelections = Array.isArray(scene.referenceSelections) ? [...scene.referenceSelections] : [];
  return syncActiveSceneIntoProjects({
    ...state,
    ctl,
    refIds,
    referenceSelections
  });
}

export function pruneReferences(state: AppState): AppState {
  const ids = new Set<string>();
  state.projects.forEach((project) => project.scenes.forEach((scene) => scene.gens.forEach((generation) => ids.add(generation.id))));
  const refIds = (state.refIds ?? []).filter((id) => ids.has(id));
  const referenceSelections = (state.referenceSelections ?? []).filter((selection) => ids.has(selection.generationId));
  const projects = state.projects.map((project) => ({
    ...project,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      refIds: scene.refIds ? scene.refIds.filter((id) => ids.has(id)) : scene.refIds,
      referenceSelections: scene.referenceSelections ? scene.referenceSelections.filter((selection) => ids.has(selection.generationId)) : scene.referenceSelections
    }))
  }));
  return { ...state, projects, refIds, referenceSelections };
}

export function nextSequence(state: AppState): number {
  const suffix = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  let max = state.seq;
  state.projects.forEach((project) => {
    max = Math.max(max, suffix(project.id));
    project.scenes.forEach((scene) => {
      max = Math.max(max, suffix(scene.id));
      scene.gens.forEach((generation) => { max = Math.max(max, suffix(generation.id)); });
    });
  });
  return max + 1;
}

export function updateActiveProject(state: AppState, update: (project: Project) => Project): AppState {
  if (!state.activeProjectId) return state;
  return { ...state, projects: state.projects.map((project) => project.id === state.activeProjectId ? update(project) : project) };
}

export function updateGeneration(state: AppState, generationId: string, patch: Partial<Generation>): AppState {
  return {
    ...state,
    projects: state.projects.map((project) => ({
      ...project,
      scenes: project.scenes.map((scene) => ({
        ...scene,
        gens: scene.gens.map((generation) => generation.id === generationId ? { ...generation, ...patch } : generation)
      }))
    }))
  };
}

export function setReferenceIntent(state: AppState, generationId: string, intent: VideoReferenceIntent): AppState {
  const selections = state.referenceSelections ?? [];
  return {
    ...state,
    referenceSelections: selections.some((selection) => selection.generationId === generationId)
      ? selections.map((selection) => selection.generationId === generationId ? { generationId, intent } : selection)
      : [...selections, { generationId, intent }]
  };
}

export function queuedGenerationFromControls(state: AppState, jobId: string, seq: number, pal: number, createdAt: string): Generation | null {
  if (!state.activeProjectId || !state.activeSceneId) return null;
  const ctl = state.ctl;
  return {
    id: `g${seq}`,
    type: ctl.mode,
    prompt: ctl.prompt || 'Untitled generation',
    modelId: ctl.modelId,
    ratio: ctl.ratio,
    res: ctl.res,
    length: ctl.length,
    fps: ctl.fps,
    camera: ctl.camera,
    audio: ctl.audio,
    guidance: ctl.guidance,
    seed: ctl.seed,
    params: { ...ctl.params },
    pal,
    preferred: false,
    jobId,
    status: 'queued',
    progress: { label: 'Queued' } satisfies GenerationProgress,
    createdAt
  };
}

export function blankStateWithControls(state: AppState): AppState {
  return { ...state, ctl: { ...defaultControls } };
}
