import React from 'react';
import { useStore } from '../store.jsx';
import { Status, DemoTag } from './ui.jsx';

const NAV = [
  ['cockpit', 'Neural Core'], ['missions', 'Missions'], ['agents', 'Agents'],
  ['workspaces', 'Workspaces'], ['activity', 'Activity'], ['settings', 'Settings'],
];

export default function Sidebar({ page }) {
  const { missions, mission, selectMission } = useStore();
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">▍&gt;_</span>
        <div><b>AI Dev</b><br /><b>Orchestrator</b><small>v0.1 · local</small></div>
      </div>
      <nav>
        {NAV.map(([id, label]) => (
          <a key={id} href={`#/${id}`} className={page === id ? 'active' : ''}>
            <span className="idx">{NAV.findIndex((n) => n[0] === id) + 1}</span>{label}
          </a>
        ))}
      </nav>
      <a className="btn primary newmission" href="#/missions?new">+ Nova missão</a>
      <div className="side-title">Missões recentes</div>
      <div className="recent">
        {missions.length === 0 && <div className="empty small">Nenhuma missão.</div>}
        {missions.slice(0, 8).map((m) => (
          <a key={m.id} href="#/cockpit" onClick={() => selectMission(m.id)} className={mission?.id === m.id ? 'active' : ''}>
            <span className="t">{m.title}</span>
            <span className="meta"><Status value={m.status} />{m.demo && <DemoTag />}</span>
          </a>
        ))}
      </div>
    </aside>
  );
}
