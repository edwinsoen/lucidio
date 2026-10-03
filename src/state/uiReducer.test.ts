import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialUiState, uiReducer } from './uiReducer';

describe('ui reducer', () => {
  it('defaults the gallery to grid view and switches modes transiently', () => {
    assert.equal(initialUiState.galleryViewMode, 'grid');

    const state = uiReducer(initialUiState, { type: 'gallery-view-mode', mode: 'compact-list' });

    assert.equal(state.galleryViewMode, 'compact-list');
    assert.equal(initialUiState.galleryViewMode, 'grid');
  });
});
