import type { CSSProperties } from 'react';
import type { AppState, CatalogValue, Generation, GenerationControls, GenerationMedia, Project, Scene } from '../types';

export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export const PALS = [
  ['#3b3656', '#191824'], ['#2d3a45', '#15191f'], ['#46392f', '#1f1813'], ['#33453b', '#161e1a'],
  ['#42344a', '#1d1722'], ['#2c3a4c', '#141a22'], ['#4a3a33', '#211712'], ['#383f54', '#181b24']
] as const;

export const defaultControls: GenerationControls = {
  mode: 'image',
  modelId: '',
  prompt: '',
  ratio: '16:9',
  res: '',
  length: 5,
  fps: 24,
  camera: false,
  audio: false,
  guidance: 7,
  seed: '',
  params: {}
};

export function fmtDur(sec: number): string {
  return `0:${String(sec).padStart(2, '0')}`;
}

export function palStyle(index: number): CSSProperties {
  const pal = PALS[index % PALS.length];
  return { background: `linear-gradient(135deg, ${pal[0]}, ${pal[1]})` };
}

export function makeId(prefix: string, seq: number): string {
  return `${prefix}${seq}`;
}

function gen(seq: { current: number }, data: Partial<Generation>): Generation {
  seq.current += 1;
  return {
    id: makeId('g', seq.current),
    type: 'image',
    prompt: '',
    modelId: '',
    ratio: '16:9',
    res: '',
    length: 5,
    fps: 24,
    camera: false,
    audio: false,
    guidance: 7,
    seed: Math.floor(Math.random() * 900000),
    params: {},
    pal: Math.floor(Math.random() * PALS.length),
    preferred: false,
    status: 'local',
    createdAt: new Date().toISOString(),
    ...data
  };
}

export function cloneControls(ctl: Partial<GenerationControls> = defaultControls): GenerationControls {
  return {
    ...defaultControls,
    ...ctl,
    params: isRecord(ctl?.params) ? { ...(ctl.params as Record<string, CatalogValue>) } : {}
  };
}

export function buildDefaultState(): AppState {
  const projectId = 'p1';
  const sceneId = 'sc1';
  const initialCtl = cloneControls(defaultControls);
  return {
    version: 1,
    seq: 1,
    projects: [{
      id: projectId,
      name: 'Untitled project',
      accent: '#6366f1',
      activeSceneId: sceneId,
      scenes: [{
        id: sceneId,
        name: 'Scene 1',
        gens: [],
        ctl: initialCtl,
        refIds: [],
        referenceSelections: []
      }]
    }],
    activeProjectId: projectId,
    activeSceneId: sceneId,
    refIds: [],
    uploadedReferences: [],
    referenceSelections: [],
    ctl: cloneControls(defaultControls)
  };
}

export function normalizeStoredState(stored: AppState): AppState {
  const fallbackCtl = cloneControls(stored.ctl);
  const fallbackRefIds = Array.isArray(stored.refIds) ? stored.refIds : [];
  const fallbackSelections = Array.isArray(stored.referenceSelections) ? stored.referenceSelections : [];
  const activeProjectId = stored.activeProjectId ?? stored.projects?.[0]?.id ?? null;
  const activeSceneId = stored.activeSceneId ?? stored.projects?.find((project) => project.id === activeProjectId)?.scenes?.[0]?.id ?? null;

  const projects = Array.isArray(stored.projects)
    ? stored.projects.map((project) => normalizeProject(project, project.id === activeProjectId ? activeSceneId : null, fallbackCtl, fallbackRefIds, fallbackSelections))
    : [];

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
  const activeScene = activeProject?.scenes.find((scene) => scene.id === (activeProject.activeSceneId ?? activeSceneId)) ?? activeProject?.scenes[0] ?? null;

  return {
    ...stored,
    projects,
    activeProjectId: activeProject?.id ?? null,
    activeSceneId: activeScene?.id ?? null,
    refIds: activeScene?.refIds ? [...activeScene.refIds] : fallbackRefIds,
    uploadedReferences: Array.isArray(stored.uploadedReferences) ? stored.uploadedReferences : [],
    referenceSelections: activeScene?.referenceSelections ? [...activeScene.referenceSelections] : fallbackSelections,
    ctl: activeScene?.ctl ? cloneControls(activeScene.ctl) : fallbackCtl
  };
}

function normalizeProject(
  project: Project,
  fallbackActiveSceneId: string | null,
  fallbackCtl: GenerationControls,
  fallbackRefIds: string[],
  fallbackSelections: AppState['referenceSelections']
): Project {
  const scenes = Array.isArray(project.scenes)
    ? project.scenes.map((scene): Scene => {
        const isFallbackActive = fallbackActiveSceneId !== null && scene.id === fallbackActiveSceneId;
        return {
          ...scene,
          gens: Array.isArray(scene.gens) ? scene.gens.map(normalizeGeneration) : [],
          ctl: scene.ctl ? cloneControls(scene.ctl) : isFallbackActive ? cloneControls(fallbackCtl) : cloneControls(defaultControls),
          refIds: Array.isArray(scene.refIds) ? scene.refIds : isFallbackActive ? [...fallbackRefIds] : [],
          referenceSelections: Array.isArray(scene.referenceSelections) ? scene.referenceSelections : isFallbackActive ? [...(fallbackSelections ?? [])] : []
        };
      })
    : [];
  const preferredSceneId = project.activeSceneId ?? fallbackActiveSceneId;
  const activeSceneId = scenes.some((scene) => scene.id === preferredSceneId) ? preferredSceneId : scenes[0]?.id ?? null;
  return {
    ...project,
    activeSceneId,
    scenes
  };
}

function normalizeGeneration(generation: Generation): Generation {
  if (!generation.media) return generation;
  const media: GenerationMedia = {
    ...generation.media,
    kind: generation.media.kind ?? (generation.type === 'video' ? 'video' : 'image'),
    role: 'primary'
  };
  if (generation.media.thumbnail) media.thumbnail = { ...generation.media.thumbnail, kind: 'image', role: 'thumbnail' };
  return { ...generation, media };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
