import React, { useMemo } from 'react';
import { useStore } from '../store.jsx';
import { nav } from '../api.js';
import { Icon } from './ui.jsx';
import SystemStatus from './SystemStatus.jsx';
import WorkspaceTabs from './WorkspaceTabs.jsx';
import { openTabs, closePlan } from '../workspace-nav.js';

/**
 * Barra superior em 2 linhas. Linha 1: marca, estado, recursos (terminais e contadores reais) e configurações; em telas estreitas leva o botão da navegação.
 * Linha 2: abas dos workspaces abertos. Tudo vem de /api/state e das sessões reais; nada é simulado.
 */
export default function Topbar({ narrow, onMenu, menuRef, navOpen, onOpenSettings, onOpenWorkspaces }) {
  const { state, workspaces, terminals, maestro, workingIds, openWorkspaceIds, act, unseenWs } = useStore();
  const sessions = terminals?.sessions ?? [], maestroTasks = maestro?.tasks ?? [];
  const activeId = state?.activeWorkspace?.id ?? null;
  const tabs = useMemo(() => openTabs({ workspaces, openWorkspaceIds, activeId, sessions, workingIds, maestroTasks }), [workspaces, openWorkspaceIds, activeId, sessions, workingIds, maestroTasks]);
  const unseen = new Set([...unseenWs].filter((id) => id !== activeId)); // a aba do workspace aberto não precisa do aviso: a sidebar mostra o "!" dele
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
        <SystemStatus />
        <button type="button" className="oc-iconbtn" onClick={onOpenSettings} aria-label="Configurações" title="Configurações"><Icon name="gear" size={18} /></button>
      </div>
      <div className="tb-row tb-tabs">
        <WorkspaceTabs tabs={tabs} unseen={unseen} onActivate={activate} onClose={close} onAdd={onOpenWorkspaces} />
      </div>
    </header>
  );
}
