import type { CSSProperties } from 'react';
import type { AppState, CatalogValue, Generation, GenerationControls, GenerationMedia, Project } from '../types';

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

export function buildDefaultState(): AppState {
  const projectId = 'p1';
  const sceneId = 'sc1';
  return {
    version: 1,
    seq: 1,
    projects: [{
      id: projectId,
      name: 'Untitled project',
      accent: '#6366f1',
      scenes: [{ id: sceneId, name: 'Scene 1', gens: [] }]
    }],
    activeProjectId: projectId,
    activeSceneId: sceneId,
    refIds: [],
    uploadedReferences: [],
    referenceSelections: [],
    ctl: { ...defaultControls }
  };
}

export function normalizeStoredState(stored: AppState): AppState {
  return {
    ...stored,
    projects: Array.isArray(stored.projects) ? stored.projects.map(normalizeProject) : [],
    refIds: Array.isArray(stored.refIds) ? stored.refIds : [],
    uploadedReferences: Array.isArray(stored.uploadedReferences) ? stored.uploadedReferences : [],
    referenceSelections: Array.isArray(stored.referenceSelections) ? stored.referenceSelections : [],
    ctl: {
      ...defaultControls,
      ...stored.ctl,
      params: isRecord(stored.ctl?.params) ? stored.ctl.params as Record<string, CatalogValue> : {}
    }
  };
}

function normalizeProject(project: Project): Project {
  return {
    ...project,
    scenes: Array.isArray(project.scenes)
      ? project.scenes.map((scene) => ({ ...scene, gens: Array.isArray(scene.gens) ? scene.gens.map(normalizeGeneration) : [] }))
      : []
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
