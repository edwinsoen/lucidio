export type GalleryViewMode = 'grid' | 'list' | 'compact-list';

export interface UiState {
  hydrated: boolean;
  galleryViewMode: GalleryViewMode;
  editingProjectId: string | null;
  projectEditValue: string;
  editingSceneId: string | null;
  editValue: string;
  confirmDeleteSceneId: string | null;
  confirmDeleteGenId: string | null;
  openProjectMenuId: string | null;
  projectMenuAnchor: { top: number; right: number } | null;
  confirmDeleteProjectId: string | null;
  previewGenId: string | null;
  draggingSceneId: string | null;
  composerOpen: boolean;
  apiStatus: string;
}

export const initialUiState: UiState = {
  hydrated: false,
  galleryViewMode: 'grid',
  editingProjectId: null,
  projectEditValue: '',
  editingSceneId: null,
  editValue: '',
  confirmDeleteSceneId: null,
  confirmDeleteGenId: null,
  openProjectMenuId: null,
  projectMenuAnchor: null,
  confirmDeleteProjectId: null,
  previewGenId: null,
  draggingSceneId: null,
  composerOpen: false,
  apiStatus: 'Loading model catalog…'
};

export type UiAction =
  | { type: 'hydrate'; apiStatus: string }
  | { type: 'api-status'; apiStatus: string }
  | { type: 'gallery-view-mode'; mode: GalleryViewMode }
  | { type: 'edit-project'; projectId: string; value: string }
  | { type: 'project-edit-value'; value: string }
  | { type: 'clear-project-edit' }
  | { type: 'edit-scene'; sceneId: string; value: string }
  | { type: 'scene-edit-value'; value: string }
  | { type: 'clear-scene-edit' }
  | { type: 'toggle-project-menu'; projectId: string; anchor: { top: number; right: number } }
  | { type: 'request-delete-project'; projectId: string }
  | { type: 'clear-delete-project' }
  | { type: 'request-delete-scene'; sceneId: string }
  | { type: 'clear-delete-scene' }
  | { type: 'request-delete-generation'; generationId: string }
  | { type: 'clear-delete-generation' }
  | { type: 'preview'; generationId: string | null }
  | { type: 'navigate-preview'; generationId: string }
  | { type: 'close-preview' }
  | { type: 'drag-scene'; sceneId: string | null }
  | { type: 'open-composer' }
  | { type: 'close-composer' }
  | { type: 'generation-deleted'; generationId: string };

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'hydrate':
      return { ...state, hydrated: true, apiStatus: action.apiStatus };
    case 'api-status':
      return { ...state, apiStatus: action.apiStatus };
    case 'gallery-view-mode':
      return { ...state, galleryViewMode: action.mode };
    case 'edit-project':
      return { ...state, editingProjectId: action.projectId, projectEditValue: action.value };
    case 'project-edit-value':
      return { ...state, projectEditValue: action.value };
    case 'clear-project-edit':
      return { ...state, editingProjectId: null, projectEditValue: '' };
    case 'edit-scene':
      return { ...state, editingSceneId: action.sceneId, editValue: action.value };
    case 'scene-edit-value':
      return { ...state, editValue: action.value };
    case 'clear-scene-edit':
      return { ...state, editingSceneId: null, editValue: '' };
    case 'toggle-project-menu':
      return {
        ...state,
        openProjectMenuId: state.openProjectMenuId === action.projectId ? null : action.projectId,
        projectMenuAnchor: state.openProjectMenuId === action.projectId ? null : action.anchor
      };
    case 'request-delete-project':
      return { ...state, openProjectMenuId: null, projectMenuAnchor: null, confirmDeleteProjectId: action.projectId };
    case 'clear-delete-project':
      return { ...state, confirmDeleteProjectId: null };
    case 'request-delete-scene':
      return { ...state, confirmDeleteSceneId: action.sceneId };
    case 'clear-delete-scene':
      return { ...state, confirmDeleteSceneId: null };
    case 'request-delete-generation':
      return { ...state, confirmDeleteGenId: action.generationId };
    case 'clear-delete-generation':
      return { ...state, confirmDeleteGenId: null };
    case 'preview':
      return { ...state, previewGenId: action.generationId };
    case 'navigate-preview':
      return { ...state, previewGenId: action.generationId, confirmDeleteGenId: null };
    case 'close-preview':
      return { ...state, previewGenId: null, confirmDeleteGenId: null };
    case 'drag-scene':
      return { ...state, draggingSceneId: action.sceneId };
    case 'open-composer':
      return { ...state, composerOpen: true };
    case 'close-composer':
      return { ...state, composerOpen: false };
    case 'generation-deleted':
      return { ...state, confirmDeleteGenId: null, previewGenId: state.previewGenId === action.generationId ? null : state.previewGenId };
  }
}
