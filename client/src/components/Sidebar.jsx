import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { usePrefs } from '../hooks.js';
import { environments } from '../env-view.js';
import { Icon, Equalizer } from './ui.jsx';
import AgentsPopover from './ProviderPanel.jsx';
import { BOX, pixelPaths } from '../brand-mark.mjs';

/** Marca: maestro em pixel art (fonte única em brand-mark.mjs, a mesma do favicon e do ícone do app). O azul escuro do bastão é fixo: faz parte da marca, não do tema. */
const MARK = pixelPaths();
export const Logo = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`} fill="none" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <rect width={BOX} height={BOX} rx="4.4" fill="#000" />
    <path d={MARK.white} fill="#fff" /><path d={MARK.accent} fill="#1d4ed8" />
  </svg>
);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function describe(e) {
  const parts = [];
  if (e.running) parts.push(plural(e.running, 'terminal ativo', 'terminais ativos') + (e.working ? ` (${e.working} trabalhando)` : ''));
  if (e.exited) parts.push(plural(e.exited, 'encerrado', 'encerrados'));
  if (e.failed) parts.push(plural(e.failed, 'terminou com falha', 'terminaram com falha'));
  if (e.pendingTasks) parts.push(plural(e.pendingTasks, 'tarefa do maestro aguardando você', 'tarefas do maestro aguardando você'));
  return parts.join(', ') || 'sem terminais';
}

const MAX_NAME = 80;

/** Campo de edição do nome amigável: Enter confirma, Esc cancela, sair do campo confirma. Só o rótulo muda (pasta e identidade do workspace ficam como estão). */
function EnvRename({ env, onSave, onCancel }) {
  const [value, setValue] = useState(env.name);
  const done = useRef(false);
  const finish = (save) => { if (done.current) return; done.current = true; if (save) onSave(value); else onCancel(); };
  return (
    <div className="oc-env oc-env-edit on">
      <span className="oc-env-ico"><Icon name="workspace" size={17} /></span>
      <input className="oc-env-input" autoFocus maxLength={MAX_NAME} value={value} aria-label={`Novo nome para o ambiente ${env.original}`} title={`Pasta: ${env.path}\nEnter confirma, Esc cancela. Vazio restaura "${env.original}".`}
        onFocus={(e) => e.target.select()} onChange={(e) => setValue(e.target.value)} onBlur={() => finish(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }} />
    </div>
  );
}

function EnvItem({ env, collapsed, editing, onPick, onEdit, onSave, onCancel }) {
  // vermelho = falha de verdade; âmbar = espera por você (tarefa do maestro); laranja = trabalhando; verde = saudável
  const tone = env.failed ? 'err' : env.pendingTasks ? 'warn' : env.working ? 'work' : env.running ? 'live' : 'none';
  const full = `${env.name}: ${describe(env)}${env.active ? ' (aberto)' : ''}`;
  if (editing) return <li><EnvRename env={env} onSave={onSave} onCancel={onCancel} /></li>;
  return (
    <li className="oc-envrow">
      <button type="button" className={`oc-env${env.active ? ' on' : ''}`} onClick={() => onPick(env)} aria-current={env.active ? 'true' : undefined} aria-label={full} title={collapsed ? full : env.renamed ? `${env.path}\nNome original: ${env.original}` : env.path}>
        <span className={`oc-env-ico tone-${tone}`}><Icon name="workspace" size={17} /><i className="oc-dot" aria-hidden="true" /></span>
        <span className="oc-env-name side-label">{env.name}</span>
        <span className="oc-env-badges" aria-hidden="true">
          {env.attention && <span className={`oc-badge ${env.failed ? 'attn' : 'warn'}`} title={describe(env)}><Icon name="alert" size={12} />{env.failed + env.pendingTasks}</span>}
          {env.working > 0 ? <span className="oc-badge work"><Equalizer />{env.working}</span> : env.running > 0 ? <span className="oc-badge live"><i />{env.running}</span> : env.exited > 0 && !env.attention ? <span className="oc-badge off">{env.exited}</span> : null}
        </span>
      </button>
      {!collapsed && <button type="button" className="oc-iconbtn oc-env-pen" onClick={() => onEdit(env.id)} aria-label={`Renomear o ambiente ${env.name}`} title="Renomear (só o nome exibido)"><Icon name="pencil" size={13} /></button>}
    </li>
  );
}

/** Ambientes de trabalho: um item por workspace que tem terminais (ou que está aberto), montado a partir dos dados reais. Em telas estreitas vira uma gaveta modal. */
export default function Sidebar({ modal = false, collapsed = false, onToggle, onClose, onOpenSettings, onOpenWorkspaces }) {
  const { workspaces, state, terminals, maestro, workingIds, act } = useStore();
  const [prefs] = usePrefs();
  const box = useRef(null);
  const [editId, setEditId] = useState(null);
  const sessions = terminals?.sessions ?? [];
  const activeId = state?.activeWorkspace?.id ?? null;
  const envs = useMemo(() => environments({ workspaces, sessions, activeId, workingIds, maestroTasks: maestro?.tasks ?? [] }), [workspaces, sessions, activeId, workingIds, maestro]);
  const totals = useMemo(() => ({ running: sessions.filter((s) => s.status === 'running').length, working: workingIds.size, attention: envs.reduce((n, e) => n + (e.attention ? e.failed + e.pendingTasks : 0), 0) }), [sessions, workingIds, envs]);

  useEffect(() => {
    if (!modal) return undefined;
    box.current?.querySelector('button')?.focus();
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
  }, [modal, onClose]);

  const save = async (env, text) => {
    setEditId(null);
    const next = String(text).replace(/\s+/g, ' ').trim();
    if (next === env.name || (!env.renamed && next === env.original)) return; // nada mudou
    await act(() => api.post(`/api/workspaces/${env.id}/rename`, { displayName: next }));
  };
  const pick = async (env) => { if (!env.active) await act(() => api.post(`/api/workspaces/${env.id}/activate`)); if (modal) onClose(); };
  const initials = (prefs.name || 'Você').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const cls = `oc-side${collapsed && !modal ? ' collapsed' : ''}${modal ? ' modal' : ''}`;
  const sum = [totals.running ? plural(totals.running, 'ativo', 'ativos') : null, totals.attention ? `${totals.attention} ${totals.attention === 1 ? 'alerta' : 'alertas'}` : null].filter(Boolean).join(' · ');

  return (
    <aside id="nav-drawer" ref={box} className={cls} {...(modal ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Ambientes de trabalho' } : { 'aria-label': 'Ambientes de trabalho' })}>
      <div className="oc-side-head">
        <span className="oc-brand" aria-label="AI Dev Orchestrator"><Logo /><span className="oc-brand-name side-label">Orchestrator</span></span>
        {modal
          ? <button type="button" className="oc-iconbtn" onClick={onClose} aria-label="Fechar a lista de ambientes"><Icon name="close" size={16} /></button>
          : <button type="button" className="oc-iconbtn oc-collapse" onClick={onToggle} aria-label={collapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral'} aria-expanded={!collapsed} title={collapsed ? 'Expandir' : 'Recolher'}><Icon name="panel" size={17} /></button>}
      </div>

      <div className="oc-side-title side-label"><span>Ambientes</span>{envs.length > 0 && <span className="oc-n">{envs.length}</span>}
        <button type="button" className="oc-iconbtn oc-plus" onClick={onOpenWorkspaces} aria-label="Abrir ou adicionar workspace" title="Abrir ou adicionar workspace"><Icon name="plus" size={14} /></button>
      </div>

      <nav className="oc-envs" aria-label="Ambientes">
        {envs.length === 0
          ? <div className="oc-env-empty side-label"><p>Nenhum ambiente ainda.</p><button type="button" className="oc-link" onClick={onOpenWorkspaces}>Adicionar um workspace</button></div>
          : <ul>{envs.map((e) => <EnvItem key={e.id} env={e} collapsed={collapsed && !modal} editing={editId === e.id} onPick={pick} onEdit={setEditId} onSave={(t) => save(e, t)} onCancel={() => setEditId(null)} />)}</ul>}
        {collapsed && !modal && <button type="button" className="oc-env oc-env-add" onClick={onOpenWorkspaces} aria-label="Abrir ou adicionar workspace" title="Abrir ou adicionar workspace"><span className="oc-env-ico"><Icon name="folderPlus" size={17} /></span></button>}
      </nav>

      <div className="oc-side-foot">
        {state && <AgentsPopover className="oc-sum" tone={totals.working ? 'work' : totals.running ? 'live' : 'none'} title="Agentes por provider (todos os ambientes)"><span className="oc-agents-t side-label">{sum || 'nenhum terminal ativo'}</span><span className="oc-agents-n">{totals.running}</span></AgentsPopover>}
        <div className="oc-side-user">
          <button type="button" className="oc-gear" onClick={onOpenSettings} aria-label="Configurações" title="Configurações"><Icon name="gear" size={18} /></button>
          <span className="oc-me side-label"><span className="oc-avatar" aria-hidden="true">{initials}</span><span className="oc-me-t"><b>{prefs.name || 'Você'}</b></span></span>
        </div>
      </div>
    </aside>
  );
}
