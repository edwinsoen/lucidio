import { Trash2 } from 'lucide-react';
import type { Project } from '../types';

export function ProjectDeleteDialog({ project, onCancel, onConfirm }: { project: Project | null; onCancel: () => void; onConfirm: () => void }) {
  if (!project) return null;
  return <div className="confirm-modal" onClick={onCancel}>
    <div className="confirm-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
      <div className="confirm-dialog-icon"><Trash2 size={18} /></div>
      <div className="confirm-dialog-copy">
        <h2 id="delete-project-title">Delete project?</h2>
        <p>This will remove <strong>{project.name}</strong> and all of its scenes and generations from this browser. If this is the last project, the workspace will be empty.</p>
      </div>
      <div className="confirm-dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="danger" onClick={onConfirm}>Delete project</button>
      </div>
    </div>
  </div>;
}
