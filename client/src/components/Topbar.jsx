import React from 'react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Icon, statusLabel, cycleApprovalPending } from './ui.jsx';

/** Marca do produto: núcleo com órbitas (a mesma linguagem do Neural Core). */
export const Logo = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="lg" x1="4" y1="4" x2="28" y2="28"><stop stopColor="#3ad6f2" /><stop offset="1" stopColor="#8b6cff" /></linearGradient></defs>
    <circle cx="16" cy="16" r="5.5" fill="url(#lg)" />
    <ellipse cx="16" cy="16" rx="13" ry="5" stroke="url(#lg)" strokeWidth="1.4" transform="rotate(-30 16 16)" opacity=".85" />
    <ellipse cx="16" cy="16" rx="13" ry="5" stroke="url(#lg)" strokeWidth="1.4" transform="rotate(30 16 16)" opacity=".45" />
  </svg>
);

// Estado de um agente, como o servidor o informa (/api/agents): o ponto só reforça o texto, que sempre aparece.
const agentTone = (a) => (a.status === 'running' ? 'active' : a.status === 'idle' ? 'idle' : 'off');
function AgentPill({ agent, fallback }) {
  const name = agent?.name?.split(' ')[0] ?? fallback;
  const label = agent ? statusLabel(agent.status) : 'sem dados';
  return (
    <span className={`agent-pill t-${agent ? agentTone(agent) : 'off'}`} title={agent?.detail || undefined} aria-label={`${name}: ${label}`}>
      <i aria-hidden="true" /><b>{name}</b><span className="state">{label}</span>
    </span>
  );
}

export default function Topbar({ onMenu, menuRef, navOpen }) {
  const { state, missions, agents, selectMission, act, notify } = useStore();
  const c = state?.counts;
  const live = state?.system === 'running'; // só destaca o botão enquanto algo está em execução (o botão continua sempre habilitado)
  const cyclePending = missions.filter(cycleApprovalPending);
  const pending = (c?.awaitingApproval ?? 0) + cyclePending.length;
  const stop = () => act(async () => { const r = await api.post('/api/execution/stop'); notify(r.detail); });
  const system = state?.system;
  return (
    <header className="topbar">
      <button type="button" ref={menuRef} className="icon-btn nav-toggle" onClick={onMenu} aria-label="Abrir navegação" aria-haspopup="dialog" aria-expanded={!!navOpen} aria-controls="nav-drawer"><Icon name="menu" /></button>
      <a className="brand" href="#/cockpit" aria-label="AI Dev Orchestrator: ir ao Cockpit">
        <Logo />
        <span className="brand-name"><b>AI Dev</b> Orchestrator<small>centro de comando · local</small></span>
      </a>
      <div className="ws-chip" title={state?.activeWorkspace?.path || 'Nenhum espaço de trabalho ativo'}>
        <Icon name="workspace" size={15} /><span className="lbl">Espaço de trabalho</span><b>{state?.activeWorkspace?.name || 'nenhum'}</b>
      </div>
      <span className="grow" />
      <div className="agents-strip" role="group" aria-label="Agentes">
        <AgentPill agent={agents.find((a) => a.id === 'planner')} fallback="Planner" />
        <AgentPill agent={agents.find((a) => a.id === 'executor')} fallback="Executor" />
      </div>
      {pending > 0 && (
        <a className="pending-pill" href={cyclePending.length ? '#/missions' : '#/cockpit'} onClick={() => { if (cyclePending.length) selectMission(cyclePending[0].id); }}
          aria-label={`${pending} ${pending === 1 ? 'aprovação pendente' : 'aprovações pendentes'}: revisar`}>
          <Icon name="gate" size={15} /><b>{pending}</b><span className="lbl">{pending === 1 ? 'aprovação pendente' : 'aprovações pendentes'}</span>
        </a>
      )}
      <span className={`sys-pill s-${system === 'running' ? 'running' : system === 'degraded' ? 'degraded' : 'idle'}`} role="status">
        <i aria-hidden="true" />{state ? statusLabel(system) : '…'}
      </span>
      <Btn kind={live ? 'danger live' : 'danger'} onClick={stop} aria-label="Interromper execução" title="Solicita interrupção segura da execução atual"><Icon name="stop" size={13} /><span className="txt">Interromper</span></Btn>
    </header>
  );
}
