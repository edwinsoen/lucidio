import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import type { ModelCatalog, Project } from '../types';
import { UsageMeter } from './UsageMeter';

export function Header({ projects, activeProjectId, openProjectMenuId, projectMenuAnchor, catalog, onSelectProject, onToggleProjectMenu, onRequestDeleteProject, onNewProject }: {
  projects: Project[];
  activeProjectId: string | null;
  openProjectMenuId: string | null;
  projectMenuAnchor: { top: number; right: number } | null;
  catalog: ModelCatalog | null;
  onSelectProject: (id: string) => void;
  onToggleProjectMenu: (id: string, anchor: { top: number; right: number }) => void;
  onRequestDeleteProject: (id: string) => void;
  onNewProject: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  useEffect(() => {
    if (!pickerOpen) return;
    function handlePointer(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false);
    }
    window.addEventListener('mousedown', handlePointer);
    return () => window.removeEventListener('mousedown', handlePointer);
  }, [pickerOpen]);
  return (
    <header className="topbar">
      <div className="brand"><div className="brand-mark" /><span>Lucidio</span><em>STUDIO</em></div>
      <div className="divider" />
      <div className="project-picker" ref={pickerRef}>
        <button className="project-picker-button" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>
          <i className="live" />
          <span>{activeProject?.name ?? 'Select project'}</span>
          <ChevronDown size={16} strokeWidth={2.2} />
        </button>
        {pickerOpen && <div className="project-picker-menu">
          {projects.map((project) => (
            <div key={project.id} className={`project-picker-row ${project.id === activeProjectId ? 'active' : ''}`}>
              <button className="project-picker-select" onClick={() => { onSelectProject(project.id); setPickerOpen(false); }}>
                <i className={project.id === activeProjectId ? 'live' : ''} /><span>{project.name}</span>
              </button>
              <button className="project-picker-delete" aria-label={`Delete ${project.name}`} onClick={() => { onRequestDeleteProject(project.id); setPickerOpen(false); }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="project-picker-add" onClick={() => { onNewProject(); setPickerOpen(false); }}><Plus size={15} strokeWidth={2.4} /> Add project</button>
        </div>}
      </div>
      <div className="tabs">
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const menuOpen = openProjectMenuId === project.id;
          return <div key={project.id} className={`tab-wrap ${menuOpen ? 'menu-open' : ''}`}>
            <button className={`tab ${active ? 'active' : ''}`} onClick={() => onSelectProject(project.id)}>
              <i className={active ? 'live' : ''} />
              <span>{project.name}</span>
            </button>
            <button className="tab-menu-button" aria-label={`Project menu for ${project.name}`} aria-expanded={menuOpen} onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onToggleProjectMenu(project.id, { top: rect.bottom + 6, right: window.innerWidth - rect.right });
            }}><MoreHorizontal size={15} /></button>
            {menuOpen && <div className="project-menu" style={projectMenuAnchor ? { top: projectMenuAnchor.top, right: projectMenuAnchor.right } : undefined}>
              <button onClick={() => onRequestDeleteProject(project.id)}><Trash2 size={14} /> Delete project</button>
            </div>}
          </div>;
        })}
        <button className="new-tab" onClick={onNewProject}>+</button>
      </div>
      <UsageMeter catalog={catalog} />
      <div className="avatar">AN</div>
    </header>
  );
}
