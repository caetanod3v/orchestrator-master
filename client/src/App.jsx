import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Cockpit from './pages/Cockpit.jsx';
import Missions from './pages/Missions.jsx';
import Agents from './pages/Agents.jsx';
import Workspaces from './pages/Workspaces.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';
import { useStore } from './store.jsx';

const PAGES = { cockpit: Cockpit, missions: Missions, agents: Agents, workspaces: Workspaces, activity: Activity, settings: Settings };
const current = () => { const p = location.hash.replace('#/', '').split('?')[0]; return p in PAGES ? p : 'cockpit'; };

export default function App() {
  const [page, setPage] = useState(current());
  const { error, toast } = useStore();
  useEffect(() => {
    const on = () => setPage(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const Page = PAGES[page];
  return (
    <div className="app">
      <Sidebar page={page} />
      <div className="main">
        <Topbar />
        {error && <div className="banner err">{error}</div>}
        {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
        <div className={`content${page === 'cockpit' ? ' full' : ''}`}><Page /></div>
      </div>
    </div>
  );
}
