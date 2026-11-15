/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDefaultState } from '../lib/data';
import { normalizeControls, supportsLocalReferenceUpload } from '../lib/modelCatalog';
import type { AppState, Generation, GenerationMedia, ModelCatalog } from '../types';
import { nextSequence, queuedGenerationFromControls, studioReducer } from './studioReducer';
import { activeProject, activeScene, generationIndex, previewNavigation, selectedReferenceGenerations } from './studioSelectors';

const imageMedia: GenerationMedia = {
  provider: 'byteplus-tos',
  key: 'generations/token/job/gen.jpg',
  contentType: 'image/jpeg',
  size: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'image',
  role: 'primary'
};

function generation(id: string, patch: Partial<Generation> = {}): Generation {
  return {
    id,
    type: 'image',
    prompt: id,
    modelId: 'model',
    ratio: '16:9',
    res: '2K',
    length: 5,
    fps: 24,
    camera: false,
    audio: false,
    guidance: 7,
    seed: '',
    params: {},
    pal: 0,
    preferred: false,
    status: 'complete',
    media: imageMedia,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch
  };
}

function populatedState(): AppState {
  const state = buildDefaultState();
  return {
    ...state,
    projects: [{
      ...state.projects[0],
      scenes: [
        { id: 'sc1', name: 'Scene 1', gens: [generation('g3'), generation('g2'), generation('g1')] },
        { id: 'sc2', name: 'Scene 2', gens: [] }
      ]
    }],
    activeProjectId: 'p1',
    activeSceneId: 'sc1',
    refIds: ['g2'],
    referenceSelections: [{ generationId: 'g2', intent: 'image_reference' }]
  };
}

describe('studio selectors', () => {
  it('derives active project, scene, references, and preview navigation', () => {
    const state = populatedState();
    const index = generationIndex(state);

    assert.equal(activeProject({ ...state, activeProjectId: 'missing' })?.id, 'p1');
    assert.equal(activeScene({ ...state, activeSceneId: 'missing' })?.id, 'sc1');
    assert.deepEqual(selectedReferenceGenerations(state, index).map((item) => item.id), ['g2']);

    const preview = previewNavigation('g2', index);
    assert.equal(preview.preview?.generation.id, 'g2');
    assert.equal(preview.previousGenerationId, 'g3');
    assert.equal(preview.nextGenerationId, 'g1');
  });
});

describe('studio reducer', () => {
  it('creates and removes projects without blocking an empty workspace', () => {
    const state = buildDefaultState();
    const created = studioReducer(state, { type: 'new-project', projectId: 'p3', sceneId: 'sc2', seq: 3 });
    assert.equal(created.projects[created.projects.length - 1]?.id, 'p3');
    assert.equal(created.activeProjectId, 'p3');
    assert.equal(created.activeSceneId, 'sc2');

    const afterFirstDelete = studioReducer(created, { type: 'delete-project', projectId: 'p3' });
    assert.equal(afterFirstDelete.activeProjectId, 'p1');

    const empty = studioReducer(afterFirstDelete, { type: 'delete-project', projectId: 'p1' });
    assert.equal(empty.projects.length, 0);
    assert.equal(empty.activeProjectId, null);
    assert.equal(empty.activeSceneId, null);
  });

  it('renames, reorders, and deletes scenes while preserving active-scene fallback', () => {
    const state = populatedState();
    const renamed = studioReducer(state, { type: 'rename-scene', sceneId: 'sc1', name: ' Opening ' });
    assert.equal(renamed.projects[0].scenes[0].name, 'Opening');

    const moved = studioReducer(renamed, { type: 'move-scene', fromId: 'sc2', toId: 'sc1' });
    assert.deepEqual(moved.projects[0].scenes.map((scene) => scene.id), ['sc2', 'sc1']);

    const deleted = studioReducer(moved, { type: 'delete-scene', sceneId: 'sc1' });
    assert.deepEqual(deleted.projects[0].scenes.map((scene) => scene.id), ['sc2']);
    assert.equal(deleted.activeSceneId, 'sc2');
  });

  it('keeps one preferred generation per scene and clears deleted references', () => {
    const state = populatedState();
    const preferred = studioReducer(state, { type: 'toggle-preferred', sceneId: 'sc1', generationId: 'g2' });
    assert.equal(preferred.projects[0].scenes[0].gens.find((item) => item.id === 'g2')?.preferred, true);
    assert.equal(preferred.projects[0].scenes[0].gens.find((item) => item.id === 'g3')?.preferred, false);

    const deleted = studioReducer(preferred, { type: 'delete-generation', sceneId: 'sc1', generationId: 'g2' });
    assert.deepEqual(deleted.refIds, []);
    assert.deepEqual(deleted.referenceSelections, []);
    assert.equal(generationIndex(deleted).has('g2'), false);
  });

  it('drops references to generations removed with their scene or project', () => {
    const state = populatedState();

    const sceneDeleted = studioReducer(state, { type: 'delete-scene', sceneId: 'sc1' });
    assert.deepEqual(sceneDeleted.refIds, []);
    assert.deepEqual(sceneDeleted.referenceSelections, []);

    const projectDeleted = studioReducer(state, { type: 'delete-project', projectId: 'p1' });
    assert.deepEqual(projectDeleted.refIds, []);
    assert.deepEqual(projectDeleted.referenceSelections, []);

    const hydrated = studioReducer(state, { type: 'hydrate', state: { ...state, refIds: ['g2', 'ghost'], referenceSelections: [{ generationId: 'ghost', intent: 'image_reference' }] } });
    assert.deepEqual(hydrated.refIds, ['g2']);
    assert.deepEqual(hydrated.referenceSelections, []);
  });

  it('derives the next sequence from existing ids so generation ids stay unique', () => {
    const state = populatedState();
    assert.equal(nextSequence(state), 4);
    assert.equal(nextSequence({ ...state, seq: 9 }), 10);
  });

  it('builds queued generation snapshots outside the reducer', () => {
    const state = buildDefaultState();
    const queued = queuedGenerationFromControls({ ...state, ctl: { ...state.ctl, prompt: 'A sunrise', modelId: 'seedream' } }, 'job_1', 2, 3, '2026-01-01T00:00:00.000Z');

    assert.equal(queued?.id, 'g2');
    assert.equal(queued?.prompt, 'A sunrise');
    assert.equal(queued?.jobId, 'job_1');
    assert.equal(queued?.status, 'queued');
    assert.equal(queued?.pal, 3);
  });

  it('coerces output_format to png when Seedream 5.5 background is transparent and enables local reference uploads', () => {
    const catalog: ModelCatalog = {
      provider: 'byteplus',
      updated: '2026-11-14',
      sourceDocs: [],
      models: [{
        id: 'dola-seedream-5-5-261028',
        displayName: 'Seedream 5.5',
        provider: 'byteplus',
        family: 'seedream',
        modality: 'image',
        endpoint: '/api/v3/images/generations',
        capabilities: {
          tasks: ['text-to-image'],
          resolutions: ['1K', '1.5K', '2K'],
          aspectRatios: ['1:1', '16:9'],
          outputFormats: ['jpeg', 'png'],
          maxReferenceImages: 10,
          maxOutputImages: 1
        },
        parameters: [
          { name: 'output_format', type: 'string', enum: ['png', 'jpeg'], default: 'jpeg' },
          { name: 'background', type: 'string', enum: ['auto', 'transparent', 'opaque'], default: 'auto' }
        ]
      }]
    };
    const state = buildDefaultState();
    assert.equal(supportsLocalReferenceUpload(catalog.models[0]), true);
    const initial = normalizeControls(catalog, state.ctl, { modelId: 'dola-seedream-5-5-261028' });
    assert.equal(initial.params.background, 'auto');
    assert.equal(initial.params.output_format, 'jpeg');

    const transparent = normalizeControls(catalog, initial, { params: { background: 'transparent' } });
    assert.equal(transparent.params.background, 'transparent');
    assert.equal(transparent.params.output_format, 'png');
  });

  it('scopes generation controls and references to each scene, copies settings on add-scene, and resets on new-project', () => {
    let state = populatedState();
    state = studioReducer(state, { type: 'set-controls', catalog: null, patch: { prompt: 'image of a rabbit', ratio: '9:16', res: '4K', seed: 42 } });
    assert.equal(state.ctl.prompt, 'image of a rabbit');
    assert.deepEqual(state.refIds, ['g2']);

    // Creating a new scene copies active settings but empties prompt and references
    state = studioReducer(state, { type: 'add-scene', sceneId: 'sc3', seq: 5 });
    assert.equal(state.activeSceneId, 'sc3');
    assert.equal(state.ctl.prompt, '');
    assert.equal(state.ctl.ratio, '9:16');
    assert.equal(state.ctl.res, '4K');
    assert.equal(state.ctl.seed, 42);
    assert.deepEqual(state.refIds, []);
    assert.deepEqual(state.referenceSelections, []);

    // Edit Scene 3 controls and reference g1 from Scene 1
    state = studioReducer(state, { type: 'set-controls', catalog: null, patch: { prompt: 'fox in forest', ratio: '21:9' } });
    state = studioReducer(state, { type: 'toggle-reference', generationId: 'g1', intent: 'image_reference' });
    assert.deepEqual(state.refIds, ['g1']);

    // Switch back to Scene 1: restores Scene 1 prompt, ratio, and references
    state = studioReducer(state, { type: 'set-active-scene', sceneId: 'sc1' });
    assert.equal(state.ctl.prompt, 'image of a rabbit');
    assert.equal(state.ctl.ratio, '9:16');
    assert.deepEqual(state.refIds, ['g2']);

    // Switch back to Scene 3: restores Scene 3 prompt, ratio, and references
    state = studioReducer(state, { type: 'set-active-scene', sceneId: 'sc3' });
    assert.equal(state.ctl.prompt, 'fox in forest');
    assert.equal(state.ctl.ratio, '21:9');
    assert.deepEqual(state.refIds, ['g1']);

    // Creating a new project resets everything to defaults
    state = studioReducer(state, { type: 'new-project', projectId: 'p2', sceneId: 'sc4', seq: 6 });
    assert.equal(state.activeProjectId, 'p2');
    assert.equal(state.activeSceneId, 'sc4');
    assert.equal(state.ctl.prompt, '');
    assert.equal(state.ctl.ratio, '16:9');
    assert.equal(state.ctl.seed, '');
    assert.deepEqual(state.refIds, []);

    // Switching back to Project 1 restores its last active scene (sc3) and its controls
    state = studioReducer(state, { type: 'set-active-project', projectId: 'p1' });
    assert.equal(state.activeProjectId, 'p1');
    assert.equal(state.activeSceneId, 'sc3');
    assert.equal(state.ctl.prompt, 'fox in forest');
    assert.equal(state.ctl.ratio, '21:9');
    assert.deepEqual(state.refIds, ['g1']);
  });
});
