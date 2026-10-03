import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { StudioOverlays } from './app/StudioOverlays';
import { WorkspaceView } from './app/WorkspaceView';
import { useStudio } from './app/useStudio';

function App() {
  const studio = useStudio();

  return (
    <div className="app-shell">
      <Header {...studio.headerProps} />
      <div className="studio-body">
        <Sidebar {...studio.sidebarProps} />
        <WorkspaceView {...studio.workspaceProps} />
      </div>
      <StudioOverlays {...studio.overlayProps} />
    </div>
  );
}

export default App;
