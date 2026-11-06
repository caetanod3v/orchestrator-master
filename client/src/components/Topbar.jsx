import React, { useMemo } from 'react';
import { useStore } from '../store.jsx';
import { nav } from '../api.js';
import { Icon } from './ui.jsx';
import AgentsPopover from './ProviderPanel.jsx';
import WorkspaceTabs from './WorkspaceTabs.jsx';
import { openTabs, closePlan, totals } from '../workspace-nav.js';

/**
 * Barra superior em 2 linhas. Linha 1: marca, estado, recursos (terminais e contadores reais) e configurações; em telas estreitas leva o botão da navegação.
 * Linha 2: abas dos workspaces abertos. Tudo vem de /api/state e das sessões reais; nada é simulado.
 */
export default function Topbar({ narrow, onMenu, menuRef, navOpen, onOpenSettings, onOpenWorkspaces }) {
  const { state, workspaces, terminals, maestro, workingIds, openWorkspaceIds, act } = useStore();
  const sessions = terminals?.sessions ?? [], maestroTasks = maestro?.tasks ?? [];
  const activeId = state?.activeWorkspace?.id ?? null;
  const tabs = useMemo(() => openTabs({ workspaces, openWorkspaceIds, activeId, sessions, workingIds, maestroTasks }), [workspaces, openWorkspaceIds, activeId, sessions, workingIds, maestroTasks]);
  const sum = useMemo(() => totals({ sessions, maestroTasks }), [sessions, maestroTasks]);
  const max = terminals?.maxSessions;

  const activate = (t) => act(() => nav.activateWorkspace(t.id));
  const close = async (t) => {
    const plan = closePlan(t);
    if (plan.confirm && !window.confirm(plan.message)) return; // fechar a aba nunca encerra terminais; confirma só para avisar que continuam rodando
    await act(() => nav.closeWorkspace(t.id)); // o servidor já escolhe o vizinho ao fechar a aba ativa
  };

  return (
    <header className="tb" aria-label="Barra superior">
      <div className="tb-row">
        {narrow && <button type="button" ref={menuRef} className="oc-iconbtn nav-toggle" onClick={onMenu} aria-label="Abrir a lista de ambientes" aria-haspopup="dialog" aria-expanded={!!navOpen} aria-controls="nav-drawer"><Icon name="menu" size={18} /></button>}
        <span className="grow" />
        <ul className="tb-counts" aria-label="Terminais de todos os workspaces">
          <li className={`tb-c live${sum.running ? ' has' : ''}`} title="Terminais rodando (todos os workspaces)"><i aria-hidden="true" /><b>{sum.running}</b><span className="tb-cl"> rodando</span></li>
          <li className={`tb-c warn${sum.waiting ? ' has' : ''}`} title="Tarefas do maestro aguardando a sua decisão"><i aria-hidden="true" /><b>{sum.waiting}</b><span className="tb-cl"> aguardando</span></li>
          <li className={`tb-c err${sum.failed ? ' has' : ''}`} title="Terminais que terminaram com falha"><i aria-hidden="true" /><b>{sum.failed}</b><span className="tb-cl"> {sum.failed === 1 ? 'falha' : 'falhas'}</span></li>
        </ul>
        {state && <AgentsPopover className="oc-count tb-res" tone={workingIds.size ? 'work' : sum.running ? 'live' : 'none'} title={`${sum.running} de ${max ?? '…'} terminais no total (todos os workspaces). Clique para ver os agentes por provider.`}><span className="oc-agents-t">{sum.running}{max ? `/${max}` : ''} <span className="tb-cl">terminais</span></span></AgentsPopover>}
        <button type="button" className="oc-iconbtn" onClick={onOpenSettings} aria-label="Configurações" title="Configurações"><Icon name="gear" size={18} /></button>
      </div>
      <div className="tb-row tb-tabs">
        <WorkspaceTabs tabs={tabs} onActivate={activate} onClose={close} onAdd={onOpenWorkspaces} />
      </div>
    </header>
  );
}
