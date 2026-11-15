import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialUiState, uiReducer } from './uiReducer';

describe('ui reducer', () => {
  it('defaults the gallery to grid view and switches modes transiently', () => {
    assert.equal(initialUiState.galleryViewMode, 'grid');
    assert.equal(initialUiState.apiStatus, '');

    const withError = uiReducer(initialUiState, { type: 'api-status', apiStatus: 'Generation rejected' });
    assert.equal(withError.apiStatus, 'Generation rejected');

    const state = uiReducer(withError, { type: 'gallery-view-mode', mode: 'compact-list' });

    assert.equal(state.galleryViewMode, 'compact-list');
    assert.equal(state.apiStatus, '');
    assert.equal(initialUiState.galleryViewMode, 'grid');
  });
});
