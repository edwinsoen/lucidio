import { LayoutGrid, LayoutList, ListCollapse, Pencil } from 'lucide-react';
import type { Project } from '../types';
import type { GalleryViewMode } from '../state/uiReducer';

const galleryViewOptions: Array<{ mode: GalleryViewMode; label: string; icon: typeof LayoutGrid }> = [
  { mode: 'grid', label: 'Grid view', icon: LayoutGrid },
  { mode: 'list', label: 'List view with thumbnails', icon: LayoutList },
  { mode: 'compact-list', label: 'Compact list view', icon: ListCollapse }
];

export function WorkspaceHeader({ project, editingProjectId, projectEditValue, galleryViewMode, onGalleryViewMode, onEdit, onEditValue, onCommitEdit, onCancelEdit }: {
  project: Project;
  editingProjectId: string | null;
  projectEditValue: string;
  galleryViewMode: GalleryViewMode;
  onGalleryViewMode: (mode: GalleryViewMode) => void;
  onEdit: () => void;
  onEditValue: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}) {
  const isEditing = editingProjectId === project.id;
  return <div className="workspace-header">
    <div className="workspace-title-group">
      {isEditing ? (
        <input
          className="project-title-edit"
          autoFocus
          value={projectEditValue}
          onChange={(event) => onEditValue(event.target.value)}
          onBlur={onCommitEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommitEdit();
            if (event.key === 'Escape') onCancelEdit();
          }}
        />
      ) : (
        <>
          <h1>{project.name}</h1>
          <button className="icon-button project-edit" title="Rename project" onClick={onEdit}><Pencil size={15} strokeWidth={2.1} /></button>
        </>
      )}
    </div>
    <div className="gallery-view-switch" role="group" aria-label="Gallery view">
      {galleryViewOptions.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          className={galleryViewMode === mode ? 'active' : ''}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={galleryViewMode === mode}
          onClick={() => onGalleryViewMode(mode)}
        >
          <Icon size={15} strokeWidth={2.1} />
        </button>
      ))}
    </div>
  </div>;
}
