import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, nav } from '../api.js';
import { useStore } from '../store.jsx';
import { usePrefs } from '../hooks.js';
import { environments, wsTone } from '../env-view.js';
import { Icon } from './ui.jsx';
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
const TONE_LABEL = { idle: 'ocioso', work: 'trabalhando', attn: 'requer a sua atenção' };
function describe(e) {
  const parts = [];
  if (e.running) parts.push(plural(e.running, 'terminal ativo', 'terminais ativos') + (e.working ? ` (${e.working} trabalhando)` : ''));
  if (e.exited) parts.push(plural(e.exited, 'encerrado', 'encerrados'));
  if (e.failed) parts.push(plural(e.failed, 'terminou com falha', 'terminaram com falha'));
  if (e.pendingTasks) parts.push(plural(e.pendingTasks, 'tarefa do maestro aguardando você', 'tarefas do maestro aguardando você'));
  return parts.join(', ') || 'sem terminais';
}

/**
 * Ícone de estado do workspace (sempre animado, movimento simples de pulso): verde = ocioso (pulso lento), laranja = trabalhando (asterisco, pulso rápido),
 * vermelho escuro = requer atenção (exclamação). O estado vem só dos dados reais (wsTone); a animação está em oc.css e é desligada por "movimento reduzido".
 */
export function WsIcon({ tone }) {
  return (
    <span className={`wsi wsi-${tone}`} aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" focusable="false">
        {tone === 'attn' && <path d="M9 3.2v7M9 14.4v.2" strokeWidth="2.4" />}
        {tone === 'work' && <path d="M9 2.8v12.4M3.6 5.9l10.8 6.2M3.6 12.1l10.8-6.2" />}
        {tone === 'idle' && <circle cx="9" cy="9" r="4.4" fill="currentColor" stroke="none" />}
      </svg>
    </span>
  );
}

const MAX_NAME = 80;

/** Campo de edição do nome amigável: Enter confirma, Esc cancela, sair do campo confirma. Só o rótulo muda (pasta e identidade do workspace ficam como estão). */
function EnvRename({ env, onSave, onCancel }) {
  const [value, setValue] = useState(env.name);
  const done = useRef(false);
  const finish = (save) => { if (done.current) return; done.current = true; if (save) onSave(value); else onCancel(); };
  return (
    <div className="oc-env oc-env-edit on">
      <WsIcon tone={wsTone(env)} />
      <input className="oc-env-input" autoFocus maxLength={MAX_NAME} value={value} aria-label={`Novo nome para o ambiente ${env.original}`} title={`Pasta: ${env.path}\nEnter confirma, Esc cancela. Vazio restaura "${env.original}".`}
        onFocus={(e) => e.target.select()} onChange={(e) => setValue(e.target.value)} onBlur={() => finish(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }} />
    </div>
  );
}

/** Um workspace = uma linha: ícone de estado + nome + contagens. Clicar abre o workspace. Recolhida a sidebar, só o ícone. */
function EnvItem({ env, collapsed, editing, onPick, onEdit, onSave, onCancel }) {
  const tone = wsTone(env);
  const full = `${env.name}: ${TONE_LABEL[tone]}; ${describe(env)}${env.active ? ' (aberto)' : ''}`;
  if (editing) return <li><EnvRename env={env} onSave={onSave} onCancel={onCancel} /></li>;
  const attn = env.failed + env.pendingTasks;
  return (
    <li className="oc-envrow">
      <div className="oc-envrow-head">
        <button type="button" className={`oc-env tone-${tone}${env.active ? ' on' : ''}`} onClick={() => onPick(env)} aria-current={env.active ? 'true' : undefined} aria-label={full} title={collapsed ? full : env.renamed ? `${env.path}\nNome original: ${env.original}` : env.path}>
          <WsIcon tone={tone} />
          <span className="oc-env-name side-label">{env.name}</span>
          <span className="oc-env-badges" aria-hidden="true">
            {attn > 0 && <span className="oc-cnt attn" title={describe(env)}>{attn}</span>}
            {env.running > 0 && <span className="oc-cnt">{env.running}</span>}
          </span>
        </button>
        {!collapsed && <button type="button" className="oc-iconbtn oc-env-pen" onClick={() => onEdit(env.id)} aria-label={`Renomear o ambiente ${env.name}`} title="Renomear (só o nome exibido)"><Icon name="pencil" size={13} /></button>}
      </div>
    </li>
  );
}

/** Ambientes de trabalho: um item por workspace cadastrado, montado a partir dos dados reais. Em telas estreitas vira uma gaveta modal. */
export default function Sidebar({ modal = false, collapsed = false, onToggle, onClose, onOpenWorkspaces }) {
  const { workspaces, state, terminals, maestro, workingIds, openWorkspaceIds, act } = useStore();
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
  const pick = async (env) => {
    if (!env.active) await act(async () => { if (!openWorkspaceIds.includes(env.id)) await nav.openWorkspace(env.id); return nav.activateWorkspace(env.id); });
    if (modal) onClose();
  };
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

      <div className="oc-side-title side-label"><span>Workspaces</span>{envs.length > 0 && <span className="oc-n">{envs.length}</span>}
        <button type="button" className="oc-iconbtn oc-plus" onClick={onOpenWorkspaces} aria-label="Abrir ou adicionar workspace" title="Abrir ou adicionar workspace"><Icon name="plus" size={14} /></button>
      </div>

      <nav className="oc-envs" aria-label="Workspaces">
        {envs.length === 0
          ? <div className="oc-env-empty side-label"><p>Nenhum workspace ainda.</p><button type="button" className="oc-link" onClick={onOpenWorkspaces}>Adicionar um workspace</button></div>
          : <ul>{envs.map((e) => <EnvItem key={e.id} env={e} collapsed={collapsed && !modal} editing={editId === e.id} onPick={pick} onEdit={setEditId} onSave={(t) => save(e, t)} onCancel={() => setEditId(null)} />)}</ul>}
        {collapsed && !modal && <button type="button" className="oc-env oc-env-add" onClick={onOpenWorkspaces} aria-label="Abrir ou adicionar workspace" title="Abrir ou adicionar workspace"><span className="wsi wsi-add"><Icon name="folderPlus" size={17} /></span></button>}
      </nav>

      <div className="oc-side-foot">
        {state && <AgentsPopover className="oc-sum" tone={totals.working ? 'work' : totals.running ? 'live' : 'none'} title="Agentes por provider (todos os ambientes)"><span className="oc-agents-t side-label">{sum || 'nenhum terminal ativo'}</span><span className="oc-agents-n">{totals.running}</span></AgentsPopover>}
        <div className="oc-side-user">
          <span className="oc-me side-label"><span className="oc-avatar" aria-hidden="true">{initials}</span><span className="oc-me-t"><b>{prefs.name || 'Você'}</b></span></span>
        </div>
      </div>
    </aside>
  );
}
