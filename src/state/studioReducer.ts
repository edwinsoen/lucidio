import type { AppState, Generation, GenerationControls, GenerationProgress, GenerationReferenceSelection, ModelCatalog, OutputMode, Project, UploadedReference, VideoReferenceIntent } from '../types';
import { defaultControls } from '../lib/data';
import { normalizeControls, normalizeStateForCatalog, type ParamPatch } from '../lib/modelCatalog';
import { activeProject } from './studioSelectors';

export type StudioAction =
  | { type: 'hydrate'; state: AppState }
  | { type: 'normalize-for-catalog'; catalog: ModelCatalog | null }
  | { type: 'set-controls'; catalog: ModelCatalog | null; patch: Partial<GenerationControls> & { params?: ParamPatch } }
  | { type: 'set-mode'; catalog: ModelCatalog | null; mode: OutputMode; modelId: string }
  | { type: 'set-active-project'; projectId: string }
  | { type: 'set-active-scene'; sceneId: string | null }
  | { type: 'new-project'; projectId: string; sceneId: string; seq: number }
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
  | { type: 'insert-generation'; generation: Generation; seq: number }
  | { type: 'patch-generation'; generationId: string; patch: Partial<Generation> }
  | { type: 'delete-generation'; sceneId: string; generationId: string };

export function studioReducer(state: AppState, action: StudioAction): AppState {
  switch (action.type) {
    case 'hydrate':
      return pruneReferences(action.state);
    case 'normalize-for-catalog':
      return normalizeStateForCatalog(state, action.catalog);
    case 'set-controls':
      return { ...state, ctl: normalizeControls(action.catalog, state.ctl, action.patch) };
    case 'set-mode':
      return { ...state, ctl: normalizeControls(action.catalog, state.ctl, { mode: action.mode, modelId: action.modelId }) };
    case 'set-active-project': {
      const selected = state.projects.find((project) => project.id === action.projectId);
      if (!selected) return state;
      return { ...state, activeProjectId: action.projectId, activeSceneId: selected.scenes[0]?.id ?? null };
    }
    case 'set-active-scene':
      return { ...state, activeSceneId: action.sceneId };
    case 'new-project': {
      const nextProject: Project = { id: action.projectId, name: 'Untitled project', accent: '#6366f1', scenes: [{ id: action.sceneId, name: 'Scene 1', gens: [] }] };
      return { ...state, seq: action.seq, projects: [...state.projects, nextProject], activeProjectId: action.projectId, activeSceneId: action.sceneId };
    }
    case 'delete-project': {
      const projects = state.projects.filter((item) => item.id !== action.projectId);
      const uploadedReferences = (state.uploadedReferences ?? []).filter((reference) => reference.projectId !== action.projectId);
      if (state.activeProjectId !== action.projectId) return pruneReferences({ ...state, projects, uploadedReferences });
      const next = projects[0] ?? null;
      return pruneReferences({ ...state, projects, uploadedReferences, activeProjectId: next?.id ?? null, activeSceneId: next?.scenes[0]?.id ?? null });
    }
    case 'add-scene':
      return {
        ...updateActiveProject(state, (project) => ({ ...project, scenes: [...project.scenes, { id: action.sceneId, name: 'New scene', gens: [] }] })),
        seq: action.seq,
        activeSceneId: action.sceneId
      };
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
      const project = activeProject(state);
      if (!project) return state;
      const scenes = project.scenes.filter((scene) => scene.id !== action.sceneId);
      const nextActiveScene = state.activeSceneId === action.sceneId ? scenes[0]?.id ?? null : state.activeSceneId;
      return pruneReferences({ ...updateActiveProject(state, (item) => ({ ...item, scenes })), activeSceneId: nextActiveScene });
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
      return setReferenceIntent(state, action.generationId, action.intent);
    case 'prune-references':
      return pruneReferences(state);
    case 'add-uploaded-reference':
      return { ...state, uploadedReferences: [...(state.uploadedReferences ?? []), action.reference] };
    case 'remove-uploaded-reference':
      return { ...state, uploadedReferences: (state.uploadedReferences ?? []).filter((reference) => reference.id !== action.referenceId) };
    case 'toggle-reference':
      return state.refIds.includes(action.generationId)
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
    case 'toggle-preferred':
      return updateActiveProject(state, (project) => ({
        ...project,
        scenes: project.scenes.map((scene) => scene.id !== action.sceneId ? scene : {
          ...scene,
          gens: scene.gens.map((generation) => ({ ...generation, preferred: generation.id === action.generationId ? !generation.preferred : false }))
        })
      }));
    case 'insert-generation':
      return {
        ...updateActiveProject(state, (project) => ({
          ...project,
          scenes: project.scenes.map((scene) => scene.id === state.activeSceneId ? { ...scene, gens: [action.generation, ...scene.gens] } : scene)
        })),
        seq: action.seq
      };
    case 'patch-generation':
      return updateGeneration(state, action.generationId, action.patch);
    case 'delete-generation':
      return {
        ...updateActiveProject(state, (project) => ({
          ...project,
          scenes: project.scenes.map((scene) => scene.id === action.sceneId ? { ...scene, gens: scene.gens.filter((generation) => generation.id !== action.generationId) } : scene)
        })),
        refIds: state.refIds.filter((id) => id !== action.generationId),
        referenceSelections: (state.referenceSelections ?? []).filter((selection) => selection.generationId !== action.generationId)
      };
  }
}

export function pruneReferences(state: AppState): AppState {
  const ids = new Set<string>();
  state.projects.forEach((project) => project.scenes.forEach((scene) => scene.gens.forEach((generation) => ids.add(generation.id))));
  const refIds = (state.refIds ?? []).filter((id) => ids.has(id));
  const referenceSelections = (state.referenceSelections ?? []).filter((selection) => ids.has(selection.generationId));
  if (refIds.length === (state.refIds ?? []).length && referenceSelections.length === (state.referenceSelections ?? []).length) return state;
  return { ...state, refIds, referenceSelections };
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
