import React, { useEffect, useRef } from 'react';
import { useStore } from '../store.jsx';
import { Status, DemoTag, Icon } from './ui.jsx';
import { Logo } from './Topbar.jsx';

export const NAV = [
  ['cockpit', 'Cockpit', 'cockpit'], ['chat', 'Conversa', 'chat'], ['missions', 'Missões', 'missions'], ['agents', 'Agentes', 'agents'],
  ['workspaces', 'Espaços de trabalho', 'workspace'], ['activity', 'Atividade', 'activity'], ['settings', 'Configurações', 'settings'],
];

/** Navegação em gaveta (substitui a sidebar fixa): diálogo modal com foco preso, Esc/clique fora para fechar e foco devolvido ao botão que a abriu. */
export default function NavDrawer({ open, page, onClose }) {
  const { missions, mission, selectMission } = useStore();
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const first = box.current?.querySelector('a, button');
    first?.focus();
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = [...box.current.querySelectorAll('a[href], button:not(:disabled)')];
      if (!items.length) return;
      const a = items[0], z = items.at(-1);
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="nav-scrim" onClick={onClose} aria-hidden="true" />
      <aside id="nav-drawer" className="nav-drawer" ref={box} role="dialog" aria-modal="true" aria-label="Navegação">
        <div className="nav-head">
          <span className="brand"><Logo /><span className="brand-name"><b>AI Dev</b> Orchestrator<small>v0.1 · local</small></span></span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar navegação"><Icon name="close" /></button>
        </div>
        <nav aria-label="Páginas">
          {NAV.map(([id, label, icon]) => (
            <a key={id} href={`#/${id}`} onClick={onClose} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined}>
              <Icon name={icon} size={18} />{label}
            </a>
          ))}
        </nav>
        <a className="btn primary newmission" href="#/missions?new" onClick={onClose}><Icon name="plus" size={15} /> Nova missão</a>
        <div className="side-title">Missões recentes</div>
        <div className="recent">
          {missions.length === 0 && <div className="empty small">Nenhuma missão.</div>}
          {missions.slice(0, 8).map((m) => (
            <a key={m.id} href="#/cockpit" onClick={() => { selectMission(m.id); onClose(); }} className={mission?.id === m.id ? 'active' : ''}>
              <span className="t">{m.title}</span>
              <span className="meta"><Status value={m.status} />{m.demo && <DemoTag />}</span>
            </a>
          ))}
        </div>
      </aside>
    </>
  );
}
