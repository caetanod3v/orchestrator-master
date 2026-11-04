import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { usePrefs } from '../hooks.js';
import { Btn, Icon, Equalizer } from './ui.jsx';
import { paneUsage, squadUsage } from '../usage-view.js';
import { terminalWorktrees } from '../worktree-view.js';
import { createTerminalStream } from '../terminal-stream.js';
import { paneState, pendingByPane, paneName, gridShape, evenTracks, dragTracks, dividerAt } from '../env-view.js';
import WorktreePanel from './WorktreePanel.jsx';
import AgentsPopover from './ProviderPanel.jsx';

// Squads prontos: o mesmo fluxo abre 2, 4 ou 6 terminais do Claude Code em paralelo, cada um com o seu papel.
export const SQUADS = [
  { id: 'duo', label: 'Dupla', roles: ['builder', 'reviewer'] },
  { id: 'squad', label: 'Squad de 4', roles: ['maestro', 'builder', 'builder', 'reviewer'] },
  { id: 'full', label: 'Squad de 6', roles: ['maestro', 'scout', 'builder', 'builder', 'builder', 'reviewer'] },
];
const MAX_CHUNK = 60_000; // o servidor aceita até 64 KB por entrada
const THEME = { background: '#000000', foreground: '#d4d4d8', cursor: '#ff6a2b', cursorAccent: '#000000', selectionBackground: 'rgba(255, 106, 43, .28)' };
const STATE_LABEL = { working: 'trabalhando', idle: 'ocioso', exited: 'encerrado', failed: 'falhou', boot: 'iniciando' };
const shortPath = (p) => { const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || String(p ?? ''); };

/** Um pane = um terminal xterm ligado ao PTY do servidor: saída por SSE, entrada e tamanho por POST (nunca WebSocket: passa pela checagem de Host/Origin). */
function TerminalPane({ session, role, state, waiting, maximized, fontSize, stream, onClose, onMaximize }) {
  const { noteInteraction } = useStore();
  const hostRef = useRef(null), termRef = useRef(null), fitRef = useRef(null);
  const id = session.id, running = session.status === 'running';
  const runningRef = useRef(running); runningRef.current = running;
  const [started, setStarted] = useState(false); // false até chegar a primeira saída: o Claude Code leva alguns segundos para iniciar (vários ao mesmo tempo, mais)

  useEffect(() => {
    const host = hostRef.current; if (!host) return undefined;
    const term = new Terminal({ fontFamily: "'Geist Mono Variable', 'Geist Mono', 'Cascadia Mono', Consolas, monospace", fontSize, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: THEME, allowProposedApi: false });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host);
    termRef.current = term; fitRef.current = fit;
    const doFit = () => { try { if (host.clientWidth > 40 && host.clientHeight > 40) fit.fit(); } catch { /* sem layout ainda */ } };
    doFit();

    // entrada: uma fila só, para as teclas chegarem na ordem em que foram digitadas
    let chain = Promise.resolve();
    const send = (data) => { for (let i = 0; i < data.length; i += MAX_CHUNK) { const part = data.slice(i, i + MAX_CHUNK); chain = chain.then(() => api.post(`/api/terminals/${id}/input`, { data: part })).catch(() => {}); } };
    // tudo que o xterm escreve no PTY (teclas, colar, relatórios de foco e de mouse) é interação da interface: o redesenho que o Claude Code faz em resposta não é trabalho
    const inputSub = term.onData((d) => { noteInteraction(id); if (runningRef.current) send(d); });

    // tamanho: o servidor limita cols/rows; só enviamos quando mudou, com pequeno atraso
    let timer = null, last = '';
    const pushSize = () => { const key = `${term.cols}x${term.rows}`; if (key === last || !runningRef.current) return; last = key; noteInteraction(id); api.post(`/api/terminals/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {}); };
    const sizeSub = term.onResize(() => { clearTimeout(timer); timer = setTimeout(pushSize, 150); });
    const ro = new ResizeObserver(() => doFit()); ro.observe(host);
    timer = setTimeout(pushSize, 200);

    // saída: UMA conexão compartilhada para todos os panes (o navegador limita ~6 por origem); a tela já impressa chega no onReset, então recarregar a página não perde nada
    const unsub = stream.subscribe(id, {
      onReset: (text) => { term.reset(); if (text) { term.write(text); setStarted(true); } },
      onData: (d) => { term.write(d); setStarted(true); },
      onExit: (c) => { term.write(`\r\n\x1b[2m[processo encerrado${c === null || c === undefined ? '' : `, código ${c}`}]\x1b[0m\r\n`); },
    });
    return () => { clearTimeout(timer); ro.disconnect(); unsub(); inputSub.dispose(); sizeSub.dispose(); term.dispose(); termRef.current = null; fitRef.current = null; };
  }, [id, stream]); // eslint-disable-line react-hooks/exhaustive-deps -- o tamanho da fonte tem efeito próprio (abaixo): recriar o terminal perderia a tela

  // fonte (preferência): vale na hora, sem recriar o terminal
  useEffect(() => {
    const term = termRef.current; if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch { /* sem layout */ }
  }, [fontSize]);

  // ao maximizar/restaurar o espaço muda: reajusta depois do layout
  useEffect(() => { const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 60); return () => clearTimeout(t); }, [maximized]);

  const use = paneUsage(session.usage);
  const boot = running && !started; // ainda sem a primeira saída: o processo existe, mas o Claude Code não terminou de iniciar
  const shown = boot ? 'boot' : state;
  const label = boot ? STATE_LABEL.boot : state === 'exited' ? (session.exitCode === null || session.exitCode === undefined ? 'encerrado' : `encerrado (${session.exitCode})`) : state === 'failed' ? `falhou (${session.exitCode})` : STATE_LABEL[state];
  const nm = paneName(session, role), hasUse = !!session.usage && Number.isFinite(session.usage.total);
  const wait = waiting?.[0], waitText = wait ? String(wait.text ?? wait.note ?? '').replace(/\s+/g, ' ').trim() : '';
  const waitTitle = waiting?.length ? `Aguardando a sua decisão: ${waiting.map((t) => t.text || t.note || t.id).join(' | ')}\nAprove ou recuse no painel do Maestro.` : '';
  return (
    <section className={`oc-pane st-${state}${waiting?.length ? ' has-wait' : ''}${maximized ? ' max' : ''}`} style={{ '--role': role?.color || 'var(--brand)' }} aria-label={`Terminal ${session.title}, ${label}${waiting?.length ? ', aguardando a sua decisão' : ''}`} onMouseDownCapture={() => noteInteraction(id)} onFocusCapture={() => noteInteraction(id)} onBlurCapture={() => noteInteraction(id)}>
      <header className="oc-ph">
        <span className={`oc-pstate st-${shown}`} role="status"><i className={`oc-pdot st-${shown}`} aria-hidden="true" />{shown === 'working' && <Equalizer />}{label}</span>
        {nm.role && <b className="oc-prole">{nm.role}</b>}
        <b className={`oc-ptitle${nm.role ? ' sub' : ''}`} title={session.title}>{nm.name}</b>
        {waiting?.length > 0 && <span className="oc-pwait" role="status" title={waitTitle}><Icon name="clock" size={12} /><span className="oc-pwait-t">{waiting.length > 1 ? `${waiting.length} tarefas aguardando você` : waitText ? `Aguardando você: ${waitText}` : 'Aguardando você'}</span></span>}
        <span className="oc-pgrow" />
        <span className="oc-ptag" title="Provider deste terminal">Claude Code</span>
        {session.worktreeId && <span className="oc-ptag wt" title="Roda num worktree próprio">worktree</span>}
        {hasUse && <span className="oc-pusage" title={use.title}><span className="sr">Consumo: </span>{use.tokens} tok<span aria-hidden="true"> · </span><span className="sr">custo </span>{use.cost}</span>}
        <button type="button" className="oc-pbtn" onClick={onMaximize} aria-label={maximized ? 'Restaurar o terminal' : 'Ampliar o terminal'} title={maximized ? 'Restaurar' : 'Ampliar'}><Icon name={maximized ? 'restore' : 'fit'} size={14} /></button>
        <button type="button" className="oc-pbtn close" onClick={onClose} aria-label={running ? 'Encerrar o terminal' : 'Remover o terminal'} title={running ? 'Encerrar' : 'Remover'}><Icon name="close" size={14} /></button>
      </header>
      <div className="oc-pbody" ref={hostRef}>{running && !started && <div className="oc-boot" role="status"><span className="oc-boot-bar" aria-hidden="true" />Iniciando o Claude Code…</div>}</div>
      <footer className="oc-pf"><span className="mono" title={session.cwd}>{shortPath(session.cwd)}</span><span className="mono dim">pid {session.pid}</span></footer>
    </section>
  );
}

/** Divisor arrastável entre duas trilhas (mouse, toque e setas do teclado; duplo clique restaura). */
function Gutter({ axis, index, tracks, onTracks, gridRef, style, label }) {
  const onDown = (e) => {
    e.preventDefault();
    const el = e.currentTarget, g = gridRef.current; if (!g) return;
    el.setPointerCapture?.(e.pointerId);
    const start = tracks, size = axis === 'x' ? g.clientWidth : g.clientHeight, total = start.reduce((s, x) => s + x, 0), p0 = axis === 'x' ? e.clientX : e.clientY;
    g.classList.add('dragging');
    const move = (ev) => onTracks(dragTracks(start, index, (((axis === 'x' ? ev.clientX : ev.clientY) - p0) / size) * total));
    const up = () => { g.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const onKey = (e) => {
    const dec = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', inc = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault(); onTracks(dragTracks(tracks, index, e.key === inc ? 0.1 : -0.1));
  };
  return <div className={`oc-gutter ${axis}`} style={style} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} tabIndex={0} onPointerDown={onDown} onKeyDown={onKey} onDoubleClick={() => onTracks(evenTracks(tracks.length))} title="Arraste para redimensionar (duplo clique restaura)" />;
}

const TASK_LABEL = { pending: 'aguardando você', delivered: 'entregue', done: 'concluída', rejected: 'recusada', failed: 'falhou', expired: 'expirada' };

/** Tarefas que o maestro repassa aos panes: por padrão cada uma espera a sua aprovação; o modo autônomo é opt-in e fica sempre visível. */
function MaestroPanel({ data, onChange, notify }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); try { onChange(await fn()); } catch (e) { notify(e.message, 'error'); } finally { setBusy(false); } };
  const tasks = data.tasks, pending = tasks.filter((t) => t.status === 'pending'), rest = tasks.filter((t) => t.status !== 'pending').slice(0, 6);
  const toggle = (e) => {
    const on = e.target.checked;
    const aviso = ['Ligar o maestro autônomo?', '', `As tarefas que o maestro enviar serão digitadas nos outros terminais SEM pedir a sua aprovação (até ${data.autoPerMinute} por minuto). O Enter enviado junto também confirma qualquer pergunta que o terminal de destino esteja mostrando (ex.: um pedido de permissão). Cada agente age com as suas permissões. O modo volta a desligado quando o servidor reinicia.`].join(String.fromCharCode(10));
    if (on && !window.confirm(aviso)) return;
    run(() => api.post('/api/maestro/autonomy', { enabled: on }));
  };
  return (
    <section className={`mp ${data.autonomous ? 'mp-auto' : ''}`} aria-label="Maestro">
      <div className="mp-head">
        <b>Maestro</b>
        <label className="tg-chk" title="Desligado: toda tarefa do maestro espera a sua aprovação. Ligado: é entregue na hora, com limite por minuto."><input type="checkbox" checked={data.autonomous} disabled={busy} onChange={toggle} /> Maestro autônomo</label>
        {data.autonomous && <span className="mp-warn" role="status">Ligado: tarefas são entregues sem aprovação</span>}
        <span className="dim small">{pending.length ? `${pending.length} aguardando você` : 'nenhuma tarefa aguardando'}</span>
      </div>
      {pending.length > 0 && <p className="dim small mp-note">Confira o terminal de destino antes de aprovar: o Enter enviado com a tarefa também confirma qualquer pergunta que ele esteja mostrando.</p>}
      {pending.length > 0 && <ul className="mp-list" aria-label="Tarefas aguardando aprovação">{pending.map((t) => (
        <li key={t.id} className="mp-item">
          <div className="mp-txt"><b>Para {t.toTitle}</b> <span className="dim small">({t.id})</span>{t.note && <span className="dim small"> · {t.note}</span>}<div className="mp-task">{t.text}</div></div>
          <div className="mp-act"><Btn kind="primary" disabled={busy} onClick={() => run(() => api.post(`/api/maestro/tasks/${t.id}/approve`))}>Aprovar e enviar</Btn><Btn disabled={busy} onClick={() => run(() => api.post(`/api/maestro/tasks/${t.id}/reject`))}>Recusar</Btn></div>
        </li>))}</ul>}
      {rest.length > 0 && <ul className="mp-hist" aria-label="Tarefas recentes">{rest.map((t) => (
        <li key={t.id} title={t.summary || t.note || t.text}><span className={`mp-st mp-st-${t.status}`}>{TASK_LABEL[t.status] || t.status}</span> <b>{t.toTitle}</b> <span className="mp-clip">{t.status === 'done' && t.summary ? t.summary : t.text}</span></li>))}</ul>}
    </section>
  );
}

export default function TerminalGrid({ narrow = false, onMenu, menuRef, onOpenWorkspaces }) {
  const { state, notify, terminals, maestro, setMaestro, workingIds, loadTerminals } = useStore();
  const [prefs, setPref] = usePrefs();
  const [busy, setBusy] = useState(false);
  const [max, setMax] = useState(null);
  const ws = state?.activeWorkspace;
  const stream = useMemo(() => createTerminalStream(), []); // uma conexão SSE para todos os terminais
  useEffect(() => () => stream.close(), [stream]);
  const waitingBy = useMemo(() => pendingByPane(maestro?.tasks), [maestro]);
  const wtCount = terminalWorktrees(state?.worktrees?.items).length;

  const roles = terminals?.roles ?? [], byRole = Object.fromEntries(roles.map((r) => [r.id, r]));
  const role = byRole[prefs.role] ? prefs.role : roles[0]?.id ?? 'builder';
  const isolate = prefs.isolate;
  const sessions = terminals?.sessions ?? [];
  const mine = sessions.filter((s) => s.workspaceId === ws?.id);         // o ambiente aberto
  const others = sessions.filter((s) => s.workspaceId !== ws?.id);       // seguem rodando (e montados) em segundo plano
  const live = sessions.filter((s) => s.status === 'running').length;
  const liveMine = mine.filter((s) => s.status === 'running').length;
  const room = (terminals?.maxSessions ?? 8) - live;
  const total = squadUsage(mine);
  const maxId = mine.some((s) => s.id === max) ? max : null;

  // layout da grade: trilhas por formato (1x1, 2x1, 2x2, 3x2…); ao mudar o número de terminais volta a divisões iguais
  const shape = maxId ? gridShape(1) : gridShape(mine.length);
  const key = `${shape.cols}x${shape.rows}`;
  const baseLayout = useMemo(() => ({ key, cols: evenTracks(shape.cols), rows: evenTracks(shape.rows) }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [layout, setLayout] = useState(baseLayout);
  const cur = layout.key === key ? layout : baseLayout;
  const setAxis = (axis, tracks) => setLayout({ ...cur, [axis]: tracks });
  const gridRef = useRef(null);

  const opening = useRef(false); // trava síncrona: dois cliques seguidos nunca abrem duas vezes (o estado `busy` só vale depois da renderização)
  const nextSquad = () => 1 + Math.max(0, ...sessions.map((x) => Number(/ S(\d+)\.\d+$/.exec(x.title)?.[1] ?? 0)));
  const open = async (list, { squad = false } = {}) => {
    if (opening.current) return;
    if (!ws) { onOpenWorkspaces?.(); return; }
    if (squad && liveMine > 0 && !window.confirm(`Já há ${liveMine} ${liveMine === 1 ? 'terminal ativo' : 'terminais ativos'} neste ambiente. Abrir MAIS ${list.length} terminais de um novo squad?`)) return;
    opening.current = true; setBusy(true);
    const n = squad ? nextSquad() : null;
    if (list.length > 1) notify(`Abrindo ${list.length} terminais; o Claude Code leva alguns segundos para iniciar em cada um.`);
    try {
      // em paralelo: cada terminal é um processo próprio; as falhas são individuais. Os do squad levam o número dele no título (ex.: Construtor S1)
      const spawn = (r, i, ack) => api.post('/api/terminals', { role: r, isolate, ...(ack ? { acknowledgeProjectConfig: true } : {}), ...(n ? { title: `${byRole[r]?.label ?? r} S${n}.${i + 1}` } : {}) });
      const rs = await Promise.allSettled(list.map((r, i) => spawn(r, i, false)));
      // M3: configuração executável do projeto não revisada no Git: o servidor recusa e só abre com a confirmação explícita (uma pergunta para o lote inteiro)
      const held = rs.map((x, i) => (x.status === 'rejected' && x.reason?.code === 'project_config_unreviewed' ? i : -1)).filter((i) => i >= 0);
      if (held.length && window.confirm(`${rs[held[0]].reason.message}\n\nAbrir ${held.length === 1 ? 'o terminal' : `os ${held.length} terminais`} mesmo assim?`)) {
        const again = await Promise.allSettled(held.map((i) => spawn(list[i], i, true)));
        held.forEach((i, k) => { rs[i] = again[k]; });
      }
      const bad = rs.filter((r) => r.status === 'rejected');
      if (bad.length) notify(`${bad.length} de ${list.length} terminais não abriram: ${bad[0].reason?.message ?? 'erro'}`, 'error');
    } finally { opening.current = false; setBusy(false); loadTerminals(); }
  };
  const closeAll = async () => {
    if (!mine.length || !window.confirm(`Encerrar os ${mine.length} terminais deste ambiente? Os agentes em andamento serão interrompidos (worktrees são mantidos).`)) return;
    setBusy(true);
    try { for (const s of mine) { try { await api.post(`/api/terminals/${s.id}/close`); } catch { /* segue com os demais */ } } setMax(null); }
    finally { setBusy(false); loadTerminals(); }
  };
  const close = async (s) => {
    try {
      const r = await api.post(`/api/terminals/${s.id}/close`); if (max === s.id) setMax(null);
      if (r?.worktreeId) notify('Terminal encerrado. O worktree dele foi mantido (pode ter trabalho): gerencie em "Worktrees dos terminais".');
    } catch (e) { notify(e.message, 'error'); } finally { loadTerminals(); }
  };

  const cell = (s, i, visible) => {
    const span = visible && !maxId && shape.spanLast && i === mine.length - 1;
    return (
      <div key={s.id} className={`oc-cell${maxId === s.id ? ' is-max' : ''}`} hidden={!visible || (!!maxId && maxId !== s.id)} style={span ? { gridColumn: '1 / -1' } : undefined}>
        <TerminalPane session={s} stream={stream} role={byRole[s.role]} state={paneState(s, workingIds)} waiting={waitingBy.get(s.id)} fontSize={prefs.fontSize} maximized={maxId === s.id} onClose={() => close(s)} onMaximize={() => setMax((m) => (m === s.id ? null : s.id))} />
      </div>
    );
  };
  const showGutters = !maxId && mine.length > 1;
  const vBottom = shape.spanLast ? `${100 - dividerAt(cur.rows, cur.rows.length - 2)}%` : 0;

  return (
    <div className={`tg${maxId ? ' tg-full' : ''}`}>
      <div className="oc-bar" role="toolbar" aria-label="Terminais do ambiente">
        {narrow && <button type="button" ref={menuRef} className="oc-iconbtn" onClick={onMenu} aria-label="Abrir a lista de ambientes" aria-haspopup="dialog"><Icon name="menu" size={18} /></button>}
        <button type="button" className="oc-wschip" onClick={onOpenWorkspaces} title={ws ? `${ws.path}\nTrocar ou adicionar workspace` : 'Escolher um workspace'}>
          <Icon name="workspace" size={15} /><b>{ws?.name ?? 'Nenhum workspace'}</b><Icon name="chevronsUpDown" size={14} />
        </button>
        {ws && <>
          <div className="oc-grp" role="group" aria-label="Squads">
            {SQUADS.map((q) => <Btn key={q.id} disabled={busy || q.roles.length > room} onClick={() => open(q.roles, { squad: true })} title={q.roles.map((r) => byRole[r]?.label ?? r).join(', ')}>{q.label}</Btn>)}
          </div>
          <div className="oc-grp" role="group" aria-label="Novo terminal">
            <label className="sr" htmlFor="tg-role">Papel do novo terminal</label>
            <select id="tg-role" className="oc-sel" value={role} onChange={(e) => setPref('role', e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            <Btn kind="primary" disabled={busy || room < 1} onClick={() => open([role])}><Icon name="plus" size={14} /> Terminal</Btn>
          </div>
        </>}
        <div className="oc-right">
        {ws && <>
          <label className="oc-iso" title="Cada terminal trabalha num git worktree próprio, sem pisar nos arquivos dos outros (exige repositório Git).">
            <input type="checkbox" role="switch" checked={isolate} onChange={(e) => setPref('isolate', e.target.checked)} /><span className="oc-switch-track" aria-hidden="true"><i /></span>Worktree
          </label>
          <span className="oc-total" title={total.partialCost ? 'Há panes sem custo conhecido: o total em dólares não é exibido. Crie data/pricing.json com os preços por modelo (USD por milhão de tokens) para ver o custo.' : total.cost === '—' ? 'Custo indisponível: crie data/pricing.json com os preços por modelo (USD por milhão de tokens).' : 'Soma dos terminais deste ambiente'}>{total.tokens} tok · {total.cost}</span>
          {mine.length > 1 && <Btn kind="quiet" disabled={busy} onClick={closeAll} title="Encerra e remove todos os terminais deste ambiente">Encerrar todos</Btn>}
          <AgentsPopover className="oc-count" tone={mine.some((x) => x.status === 'running' && workingIds.has(x.id)) ? 'work' : liveMine ? 'live' : 'none'} title={`${live} de ${terminals?.maxSessions ?? '…'} terminais no total (todos os ambientes). Clique para ver os agentes por provider.`}><span className="oc-agents-t">{liveMine} {liveMine === 1 ? 'ativo' : 'ativos'}</span></AgentsPopover>
        </>}
        </div>
      </div>

      {maestro && (mine.some((x) => x.role === 'maestro' && x.status === 'running') || maestro.tasks.length > 0 || maestro.autonomous) && <MaestroPanel data={maestro} onChange={setMaestro} notify={notify} />}
      {wtCount > 0 && (
        <details className="tg-wt">
          <summary>Worktrees dos terminais · {wtCount}</summary>
          <p className="dim small">Cada terminal isolado trabalha numa branch própria. Encerrar o terminal NÃO apaga o worktree. Aqui você confere o estado, registra um snapshot (commit na branch do worktree) e limpa o que não tem mais trabalho a perder. A integração ao projeto principal exige o gate de evidência das missões, que não existe nos terminais: revise a branch e integre você mesmo com o Git; depois a limpeza fica liberada. O servidor recusa remover worktree com alterações ou commits não integrados.</p>
          <WorktreePanel terminals inUse={new Set(sessions.filter((x) => x.status === 'running' && x.worktreeId).map((x) => x.worktreeId))} />
        </details>
      )}

      {!ws ? (
        <div className="oc-empty">
          <span className="oc-empty-ico"><Icon name="folderPlus" size={26} /></span>
          <h3>Escolha um workspace</h3>
          <p className="dim">Cada ambiente é uma pasta de projeto. Os terminais dos agentes abrem nela.</p>
          <Btn kind="primary" onClick={onOpenWorkspaces}>Abrir ou adicionar workspace</Btn>
        </div>
      ) : mine.length === 0 ? (
        <div className="oc-empty">
          <span className="oc-empty-ico"><Icon name="terminal" size={26} /></span>
          <h3>{ws.name}</h3>
          <p className="dim">Nenhum terminal aberto neste ambiente. Comece por um squad pronto ou um terminal avulso.</p>
          <div className="oc-squads">
            {SQUADS.map((q) => (
              <button key={q.id} type="button" className="oc-squad" disabled={busy || q.roles.length > room} onClick={() => open(q.roles, { squad: true })}>
                <b>{q.label}</b>
                <span className="oc-squad-roles">{q.roles.map((r, i) => <span key={i} className="oc-chip" style={{ '--role': byRole[r]?.color }}><i />{byRole[r]?.label ?? r}</span>)}</span>
              </button>
            ))}
            <button type="button" className="oc-squad solo" disabled={busy || room < 1} onClick={() => open([role])}><b>Terminal avulso</b><span className="oc-squad-roles"><span className="oc-chip" style={{ '--role': byRole[role]?.color }}><i />{byRole[role]?.label ?? role}</span></span></button>
          </div>
          <p className="dim small oc-foot">Os terminais usam o seu login do Claude Code e <b>não passam</b> pelas aprovações do ciclo automático: o que o agente faz ali é decisão sua.</p>
        </div>
      ) : null}

      <div className="oc-gridwrap" hidden={mine.length === 0}>
        <div ref={gridRef} className={`oc-grid${maxId ? ' has-max' : ''}`} style={{ gridTemplateColumns: cur.cols.map((f) => `minmax(0, ${f}fr)`).join(' '), gridTemplateRows: cur.rows.map((f) => `minmax(0, ${f}fr)`).join(' ') }}>
          {mine.map((s, i) => cell(s, i, true))}
          {others.map((s, i) => cell(s, i, false))}
          {showGutters && cur.cols.slice(0, -1).map((_, i) => <Gutter key={`x${i}`} axis="x" index={i} tracks={cur.cols} onTracks={(t) => setAxis('cols', t)} gridRef={gridRef} label={`Redimensionar colunas ${i + 1} e ${i + 2}`} style={{ left: `calc(${dividerAt(cur.cols, i)}% - 5px)`, top: 0, bottom: vBottom }} />)}
          {showGutters && cur.rows.slice(0, -1).map((_, i) => <Gutter key={`y${i}`} axis="y" index={i} tracks={cur.rows} onTracks={(t) => setAxis('rows', t)} gridRef={gridRef} label={`Redimensionar linhas ${i + 1} e ${i + 2}`} style={{ top: `calc(${dividerAt(cur.rows, i)}% - 5px)`, left: 0, right: 0 }} />)}
        </div>
      </div>
    </div>
  );
}
