import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Glyph, Icon, statusLabel, cycleApprovalPending, TASK_GLYPH } from './ui.jsx';
import AgentStatus from './AgentStatus.jsx';
import { latestExecutionFailed } from '../op-state.js';

export const NAV = [
  ['cockpit', 'Cockpit', 'cockpit'], ['chat', 'Conversa', 'chat'], ['missions', 'Missões', 'missions'], ['agents', 'Agentes', 'agents'],
  ['workspaces', 'Espaços de trabalho', 'workspace'], ['activity', 'Atividade', 'activity'], ['settings', 'Configurações', 'settings'],
];

/** Marca: três nós ligados (a ideia de orquestração), em traço único. */
export const Logo = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false">
    <rect width="28" height="28" rx="8" fill="var(--bone)" />
    <path d="M9 9.5l5 4.5M19 9.5L14 14M14 14v5" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="9" cy="9" r="2.2" fill="var(--ink)" /><circle cx="19" cy="9" r="2.2" fill="var(--ink)" /><circle cx="14" cy="19.5" r="2.4" fill="var(--ink)" />
  </svg>
);

/** Seletor do espaço de trabalho ativo: um menu (popover) com os espaços cadastrados. Esc fecha e devolve o foco ao botão. */
function WorkspaceMenu({ collapsed }) {
  const { state, workspaces, act } = useStore();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // posição do popover (fixa, para não ser cortada pela rolagem da sidebar)
  const btn = useRef(null), box = useRef(null);
  const active = state?.activeWorkspace;
  useEffect(() => {
    if (!open) return undefined;
    box.current?.querySelector('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"], a')?.focus();
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...box.current.querySelectorAll('[role="menuitemradio"], a')], i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };
    const away = (e) => { if (!box.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', away); };
  }, [open]);
  const pick = async (w) => { setOpen(false); btn.current?.focus(); if (w.id !== active?.id) await act(() => api.post(`/api/workspaces/${w.id}/activate`)); };
  return (
    <div className="ws-menu">
      <button type="button" ref={btn} className="ws-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) { const r = btn.current.getBoundingClientRect(); setPos(collapsed ? { left: r.right + 8, top: r.top, width: 280 } : { left: r.left, top: r.bottom + 6, width: r.width }); } setOpen((o) => !o); }}
        title={active?.path || 'Nenhum espaço de trabalho ativo'} aria-label={`Espaço de trabalho: ${active?.name || 'nenhum'}`}>
        <span className="ws-ico"><Icon name="workspace" size={16} /></span>
        <span className="ws-text"><span className="k">Espaço de trabalho</span><b>{active?.name || 'nenhum ativo'}</b></span>
        {!collapsed && <Icon name="chevronsUpDown" size={16} />}
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Espaços de trabalho" ref={box} style={pos || undefined}>
          {workspaces.length === 0 && <div className="menu-empty">Nenhum espaço cadastrado.</div>}
          {workspaces.map((w) => (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === active?.id} className="menu-item" onClick={() => pick(w)}>
              <span className="menu-main"><b>{w.name}</b><span className="mono dim">{w.path}</span></span>
              {w.id === active?.id && <Icon name="check" size={16} />}
            </button>
          ))}
          <div className="menu-sep" />
          <a className="menu-item" href="#/workspaces" onClick={() => setOpen(false)} role="menuitem"><span className="menu-main"><b>Gerenciar espaços de trabalho</b></span><Icon name="chevronRight" size={16} /></a>
        </div>
      )}
    </div>
  );
}

/** Navegação. No desktop é um trilho fixo (recolhível); em telas estreitas é uma gaveta modal: foco preso, Esc ou clique fora fecham e o foco volta ao botão que a abriu. */
export default function Sidebar({ page, modal = false, collapsed = false, onToggle, onClose }) {
  const { missions, mission, selectMission, state, agents } = useStore();
  const box = useRef(null);
  useEffect(() => {
    if (!modal) return undefined;
    box.current?.querySelector('a, button')?.focus();
    const key = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.menu')) { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = [...box.current.querySelectorAll('a[href], button:not(:disabled)')];
      if (!items.length) return;
      const a = items[0], z = items.at(-1);
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [modal, onClose]);

  const pending = (state?.counts?.awaitingApproval ?? 0) + missions.filter(cycleApprovalPending).length;
  const go = () => { if (modal) onClose(); };
  const planner = agents.find((a) => a.id === 'planner'), executor = agents.find((a) => a.id === 'executor');
  const system = state?.system;
  const execFailed = latestExecutionFailed(missions.flatMap((m) => m.tasks));
  const cls = `side${collapsed && !modal ? ' collapsed' : ''}${modal ? ' modal' : ''}`;
  return (
    <aside id="nav-drawer" ref={box} className={cls} {...(modal ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Navegação' } : { 'aria-label': 'Navegação lateral' })}>
      <div className="side-head">
        <a className="brand" href="#/cockpit" onClick={go} aria-label="AI Dev Orchestrator: ir ao Cockpit"><Logo /><span className="brand-name">Orchestrator</span></a>
        {modal
          ? <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar navegação"><Icon name="close" /></button>
          : <button type="button" className="icon-btn side-toggle" onClick={onToggle} aria-label={collapsed ? 'Expandir navegação' : 'Recolher navegação'} aria-expanded={!collapsed}><Icon name="panel" size={18} /></button>}
      </div>
      <WorkspaceMenu collapsed={collapsed && !modal} />
      <a className="btn primary side-new" href="#/missions?new" onClick={go} title="Nova missão"><Icon name="plus" size={16} /><span className="side-label">Nova missão</span></a>
      <nav aria-label="Páginas">
        {NAV.map(([id, label, icon]) => (
          <a key={id} href={`#/${id}`} onClick={go} className={`side-link${page === id ? ' active' : ''}`} aria-current={page === id ? 'page' : undefined} title={label}>
            <Icon name={icon} size={18} /><span className="side-label">{label}</span>
            {id === 'cockpit' && pending > 0 && page !== 'cockpit' && <span className="side-count" aria-label={`${pending} aprovações pendentes`}>{pending}</span>}
          </a>
        ))}
      </nav>
      <div className="side-recent">
        <div className="side-title">Missões recentes</div>
        {missions.length === 0 && <div className="side-empty">Nenhuma missão ainda.</div>}
        {missions.slice(0, 6).map((m) => (
          <a key={m.id} href="#/cockpit" onClick={() => { selectMission(m.id); go(); }} className={`side-mission${mission?.id === m.id ? ' active' : ''}`} title={m.title}>
            <Glyph kind={TASK_GLYPH[m.status] || 'unavailable'} /><span className="t">{m.title}</span>{m.demo && <span className="demo">DEMO</span>}
          </a>
        ))}
      </div>
      <ul className="side-foot" aria-label="Estado do sistema">
        <li title={planner?.detail || undefined}><span className="side-name">Planner</span><AgentStatus agent={planner} /></li>
        <li title={executor?.detail || undefined}><span className="side-name">Executor</span><AgentStatus agent={executor} failed={execFailed} /></li>
        <li role="status"><span className="side-name">Sistema</span><span className={`status s-${system === 'running' ? 'running' : system === 'degraded' ? 'degraded' : 'idle'}`}><i aria-hidden="true" /><span className="ag-text">{state ? statusLabel(system) : '…'}</span></span></li>
      </ul>
    </aside>
  );
}
