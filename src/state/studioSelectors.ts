import type { AppState, Generation, Project, Scene } from '../types';

export interface GenerationEntry {
  generation: Generation;
  scene: Scene;
  project: Project;
}

export interface PreviewNavigation {
  preview: GenerationEntry | null;
  previousGenerationId: string | null;
  nextGenerationId: string | null;
}

export function activeProject(state: AppState): Project | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? state.projects[0] ?? null;
}

export function activeScene(state: AppState): Scene | null {
  const project = activeProject(state);
  if (!project) return null;
  return project.scenes.find((scene) => scene.id === state.activeSceneId) ?? project.scenes[0] ?? null;
}

export function generationIndex(state: AppState): Map<string, GenerationEntry> {
  const map = new Map<string, GenerationEntry>();
  state.projects.forEach((project) => {
    project.scenes.forEach((scene) => {
      scene.gens.forEach((generation) => {
        map.set(generation.id, { generation, scene, project });
      });
    });
  });
  return map;
}

export function selectedReferenceGenerations(state: AppState, entries = generationIndex(state)): Generation[] {
  return state.refIds.map((id) => entries.get(id)?.generation).filter((item): item is Generation => Boolean(item));
}

export function previewNavigation(previewGenId: string | null, entries: Map<string, GenerationEntry>): PreviewNavigation {
  const preview = previewGenId ? entries.get(previewGenId) ?? null : null;
  const previewIndex = preview ? preview.scene.gens.findIndex((generation) => generation.id === preview.generation.id) : -1;
  const previousGenerationId = preview && previewIndex > 0 ? preview.scene.gens[previewIndex - 1]?.id ?? null : null;
  const nextGenerationId = preview && previewIndex >= 0 && previewIndex < preview.scene.gens.length - 1 ? preview.scene.gens[previewIndex + 1]?.id ?? null : null;
  return { preview, previousGenerationId, nextGenerationId };
}
