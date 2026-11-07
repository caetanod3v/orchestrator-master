import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { usePrefs, useLayouts } from '../hooks.js';
import { orderSessions, mergeOrder, sameList, EMPTY as EMPTY_LAYOUT } from '../layout-state.js';
import { historyRows, resumeBody, needsConfigAck, restorePlan, batchSummary, lastShutdownRestore, attemptKey, readAutoRestore, writeAutoRestore } from '../session-history.js';
import { Btn, Icon, WorkStar } from './ui.jsx';
import { paneUsage, squadUsage } from '../usage-view.js';
import { createTerminalStream } from '../terminal-stream.js';
import { paneState, pendingByPane, paneName, shapeFor, focusPlacement, layoutModeId, LAYOUT_MODES, evenTracks, dragTracks, dividerAt } from '../env-view.js';
import MaestroPopover from './MaestroPopover.jsx';
import AgentsPopover from './ProviderPanel.jsx';
import SessionHistory from './SessionHistory.jsx';

// Squads prontos: o mesmo fluxo abre 2, 4 ou 6 terminais do Claude Code em paralelo, cada um com o seu papel.
export const SQUADS = [
  { id: 'duo', label: 'Dupla', roles: ['builder', 'reviewer'] },
  { id: 'squad', label: 'Squad de 4', roles: ['maestro', 'builder', 'builder', 'reviewer'] },
  { id: 'full', label: 'Squad de 6', roles: ['maestro', 'scout', 'builder', 'builder', 'builder', 'reviewer'] },
];
const MAX_CHUNK = 60_000; // o servidor aceita até 64 KB por entrada
const THEME = { background: '#090909', foreground: '#d2d2d2', cursor: '#c94a4a', cursorAccent: '#090909', selectionBackground: 'rgba(168, 58, 58, .35)', red: '#b84646', brightRed: '#c94a4a', green: '#5fa377', brightGreen: '#7fb592', yellow: '#92713e', brightYellow: '#c9a46a' };
const STATE_LABEL = { working: 'executando', idle: 'ocioso', done: 'concluído', waiting: 'aguardando', exited: 'encerrado', failed: 'falhou', boot: 'iniciando' };
const shortPath = (p) => { const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || String(p ?? ''); };

/** Um pane = um terminal xterm ligado ao PTY do servidor: saída por SSE, entrada e tamanho por POST (nunca WebSocket: passa pela checagem de Host/Origin). */
function TerminalPane({ session, role, state, waiting, maximized, fontSize, stream, onClose, onMaximize, onFocus }) {
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
        <span className={`oc-pstate st-${shown}`} role="status">{shown === 'working' ? <WorkStar size={13} /> : <i className={`oc-pdot st-${shown}`} aria-hidden="true" />}{label}</span>
        {nm.role && <b className="oc-prole">{nm.role}</b>}
        <b className={`oc-ptitle${nm.role ? ' sub' : ''}`} title={session.title}>{nm.name}</b>
        {waiting?.length > 0 && <span className="oc-pwait" role="status" title={waitTitle}><Icon name="clock" size={12} /><span className="oc-pwait-t">{waiting.length > 1 ? `${waiting.length} tarefas aguardando você` : waitText ? `Aguardando você: ${waitText}` : 'Aguardando você'}</span></span>}
        <span className="oc-pgrow" />
        <span className="oc-ptag" title="Provider deste terminal">Claude Code</span>
        {session.worktreeId && <span className="oc-ptag wt" title="Roda num worktree próprio">worktree</span>}
        {hasUse && <span className="oc-pusage" title={use.title}><span className="sr">Consumo: </span>{use.tokens} tok<span aria-hidden="true"> · </span><span className="sr">custo </span>{use.cost}</span>}
        {onFocus && <button type="button" className="oc-pbtn" onClick={onFocus} aria-label="Colocar este terminal em foco" title="Colocar em foco"><Icon name="fit" size={14} /></button>}
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


export default function TerminalGrid({ onOpenWorkspaces, onOpenSettings }) {
  const { state, notify, terminals, maestro, setMaestro, workingIds, loadTerminals } = useStore();
  const [prefs, setPref] = usePrefs();
  const [busy, setBusy] = useState(false);
  const [layouts, layoutActions, layoutsReady] = useLayouts(); // layout por workspace (ordem, ampliado, trilhas), no servidor
  const [restorable, setRestorable] = useState(0); // sessões deste workspace que estavam abertas e podem voltar
  const [histOpen, setHistOpen] = useState(false); // diálogo do histórico de sessões (retomar/fork)
  const [modes, setModes] = useState(() => { try { return JSON.parse(localStorage.getItem('forge.layoutMode') || '{}') || {}; } catch { return {}; } }); // modo da grade por workspace: conveniência desta tela (não vai ao servidor)
  const [autoRestore, setAutoRestoreState] = useState(readAutoRestore); // restaurar sozinho as sessões do último encerramento ao entrar no workspace
  const setAutoRestore = (on) => { setAutoRestoreState(on); writeAutoRestore(on); };
  const attempted = useRef(new Set()), autoBusy = useRef(false); // 'já tentei' por registro+instante: uma sessão não é reaberta em laço nem notificada duas vezes
  const [focusBy, setFocusBy] = useState({}); // workspaceId -> id do terminal em foco (modo Foco)
  const ws = state?.activeWorkspace;
  const stream = useMemo(() => createTerminalStream(), []); // uma conexão SSE para todos os terminais
  useEffect(() => () => stream.close(), [stream]);
  const waitingBy = useMemo(() => pendingByPane(maestro?.tasks), [maestro]);
  const pendingIds = useMemo(() => new Set(waitingBy.keys()), [waitingBy]);

  const roles = terminals?.roles ?? [], byRole = Object.fromEntries(roles.map((r) => [r.id, r]));
  const role = byRole[prefs.role] ? prefs.role : roles[0]?.id ?? 'builder';
  const isolate = prefs.isolate;
  const sessions = terminals?.sessions ?? [];
  // Sessões do workspace + tópico ativos. As demais seguem rodando e MONTADAS (ocultas): trocar de aba ou de tópico nunca encerra nem remonta terminal.
  const topicId = null; // a interface não usa mais tópicos: o workspace mostra todos os terminais dele e os novos nascem sem tópico
  const where = ws?.displayName || ws?.name || '';
  const L = (ws && layouts[ws.id]) || EMPTY_LAYOUT;
  const mine = ws ? orderSessions(sessions.filter((s) => s.workspaceId === ws.id), L.order) : []; // ordem salva (id da sessão); o DOM não muda de ordem: a posição visual vem do CSS `order`
  const mineIdx = new Map(mine.map((s, i) => [s.id, i]));
  const live = sessions.filter((s) => s.status === 'running').length;
  const liveMine = mine.filter((s) => s.status === 'running').length;
  const room = (terminals?.maxSessions ?? 8) - live;
  const total = squadUsage(mine);
  const mode = layoutModeId(ws && modes[ws.id]);
  const setMode = (m) => { const next = { ...modes, [ws.id]: m }; setModes(next); try { localStorage.setItem('forge.layoutMode', JSON.stringify(next)); } catch { /* sem armazenamento: vale só nesta sessão */ } };
  const maxId = L.maximized ? (mine.find((s) => s.recordId === L.maximized)?.id ?? null) : null;

  // layout da grade: trilhas por formato (1x1, 2x1, 2x2, 3x2…); ao mudar o número de terminais volta a divisões iguais
  const focusIdx = Math.max(0, mine.findIndex((x) => x.id === (ws && focusBy[ws.id])));
  const focusPlan = mode === 'focus' && !maxId ? focusPlacement(mine.length, focusIdx) : null;
  const shape = maxId || focusPlan ? shapeFor('auto', 1) : shapeFor(mode, mine.length);
  const key = `${shape.cols}x${shape.rows}`;
  const baseLayout = useMemo(() => ({ cols: evenTracks(shape.cols), rows: evenTracks(shape.rows) }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = L.grids[key]; // trilhas salvas POR WORKSPACE e por formato; só valem se baterem com o formato atual
  const cur = saved && saved.cols.length === shape.cols && saved.rows.length === shape.rows ? saved : baseLayout;
  const setAxis = (axis, tracks) => { if (ws) layoutActions.setGrid(ws.id, key, { ...cur, [axis]: tracks }); };

  // ordem dos terminais abertos deste workspace: salva só depois de ler a do servidor; mantém quem não está vivo agora (restauração) e acrescenta os novos
  const liveIds = mine.map((s) => s.recordId).filter(Boolean);
  useEffect(() => {
    if (!ws || !layoutsReady || !liveIds.length) return;
    const next = mergeOrder(L.order, liveIds);
    if (!sameList(next, L.order)) layoutActions.setOrder(ws.id, next);
  }, [ws?.id, layoutsReady, liveIds.join(','), L.order.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // aviso no workspace vazio: há sessões que estavam abertas e podem voltar (usa o histórico que o servidor já mantém)
  useEffect(() => {
    if (!ws || mine.length > 0) { setRestorable(0); return undefined; }
    let alive = true;
    api.get('/api/terminals/history').then((d) => { if (alive) setRestorable(historyRows({ history: d?.sessions, workspaceId: ws.id }).restore.length); }).catch(() => {});
    return () => { alive = false; };
  }, [ws?.id, mine.length, histOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Restauração automática: workspace aberto, sem nenhum terminal, e o servidor diz que há sessões do último encerramento retomáveis. Nunca confirma sozinha a configuração de projeto não revisada.
  useEffect(() => {
    if (!ws || !autoRestore || !layoutsReady || !terminals || mine.length > 0 || autoBusy.current) return undefined;
    let alive = true; const wsId = ws.id;
    (async () => {
      let d; try { d = await api.get('/api/terminals/history'); } catch { return; }
      if (!alive) return;
      const rows = historyRows({ history: d?.sessions, workspaceId: wsId });
      const fresh = lastShutdownRestore(rows.restore).filter((r) => !attempted.current.has(attemptKey(r)));
      if (!fresh.length || autoBusy.current) return;
      const live = (terminals?.sessions ?? []).filter((x) => x.status === 'running').length;
      const plan = restorePlan(orderSessions(fresh, L.order, (r) => r.id), (terminals?.maxSessions ?? 10) - live);
      for (const r of fresh) attempted.current.add(attemptKey(r));
      if (!plan.open.length) return;
      autoBusy.current = true;
      notify(`Restaurando ${plan.open.length} ${plan.open.length === 1 ? 'sessão' : 'sessões'} de ${where} do ponto onde pararam…`);
      const results = [];
      try {
        for (const r of plan.open) {
          try { await api.post('/api/terminals/resume', resumeBody({ recordId: r.id })); results.push({ row: r, ok: true }); } catch (e) {
            const limit = e?.status === 409 && /Limite de/.test(e.message || '');
            results.push({ row: r, ok: false, error: limit ? 'limite de terminais' : needsConfigAck(e) ? 'precisa da sua confirmação: abra o Histórico' : (e?.message || 'erro') });
            if (limit) break;
          }
        }
      } finally {
        autoBusy.current = false;
        const sum = batchSummary(results, plan.skipped.length); notify(sum.text, sum.kind); loadTerminals();
      }
    })();
    return () => { alive = false; };
  }, [ws?.id, autoRestore, layoutsReady, !!terminals, mine.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const gridRef = useRef(null);

  const opening = useRef(false); // trava síncrona: dois cliques seguidos nunca abrem duas vezes (o estado `busy` só vale depois da renderização)
  const nextSquad = () => 1 + Math.max(0, ...sessions.map((x) => Number(/ S(\d+)\.\d+$/.exec(x.title)?.[1] ?? 0)));
  const open = async (list, { squad = false } = {}) => {
    if (opening.current) return;
    if (!ws) { onOpenWorkspaces?.(); return; }
    if (squad && liveMine > 0 && !window.confirm(`Já há ${liveMine} ${liveMine === 1 ? 'terminal ativo' : 'terminais ativos'} em ${where}. Abrir MAIS ${list.length} terminais de um novo squad?`)) return;
    opening.current = true; setBusy(true);
    const n = squad ? nextSquad() : null;
    if (list.length > 1) notify(`Abrindo ${list.length} terminais; o Claude Code leva alguns segundos para iniciar em cada um.`);
    try {
      // em paralelo: cada terminal é um processo próprio; as falhas são individuais. Os do squad levam o número dele no título (ex.: Construtor S1)
      const spawn = (r, i, ack, squadId) => api.post('/api/terminals', { role: r, isolate, ...(squadId ? { squadId } : {}), workspaceId: ws.id, topicId, ...(ack ? { acknowledgeProjectConfig: true } : {}), ...(n ? { title: `${byRole[r]?.label ?? r} S${n}.${i + 1}` } : {}) });
      // Worktree: um squad inteiro compartilha UM worktree. O 1º terminal o cria; os outros entram nele (esperam o 1º para saber o id). Terminal avulso continua com o seu.
      let rs;
      if (isolate && squad && list.length > 1) {
        const head = await Promise.allSettled([spawn(list[0], 0, false)]);
        const squadId = head[0].status === 'fulfilled' ? head[0].value?.session?.squadId : null;
        const tail = squadId ? await Promise.allSettled(list.slice(1).map((r, i) => spawn(r, i + 1, false, squadId))) : list.slice(1).map(() => ({ status: 'rejected', reason: head[0].reason ?? new Error('o worktree do squad não foi criado') }));
        rs = [...head, ...tail];
      } else rs = await Promise.allSettled(list.map((r, i) => spawn(r, i, false)));
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
    if (!mine.length || !window.confirm(`Encerrar os ${mine.length} terminais de ${where}? Os agentes em andamento serão interrompidos (worktrees são mantidos).`)) return;
    setBusy(true);
    const closed = [];
    try { for (const s of mine) { try { await api.post(`/api/terminals/${s.id}/close`); closed.push(s.recordId); } catch { /* segue com os demais */ } } }
    finally { setBusy(false); await loadTerminals(); for (const rid of closed) layoutActions.forget(ws.id, rid); } // esquece DEPOIS de a lista sair da tela: senão o efeito da ordem reacrescenta o id
  };
  const close = async (s) => {
    let closedRid = null;
    try {
      const r = await api.post(`/api/terminals/${s.id}/close`); closedRid = s.recordId;
      if (r?.worktreeId) notify('Terminal encerrado. O worktree dele foi mantido (pode ter trabalho): gerencie em Configurações > Workspaces e Worktrees.');
    } catch (e) { notify(e.message, 'error'); } finally { await loadTerminals(); if (closedRid) layoutActions.forget(ws.id, closedRid); }
  };

  const cell = (s, i, visible) => {
    const span = visible && !maxId && !focusPlan && shape.spanLast && i === mine.length - 1;
    const at = visible && focusPlan ? focusPlan.cells[i] : null, strip = !!at && at.col === 2;
    return (
      <div key={s.id} className={`oc-cell${maxId === s.id ? ' is-max' : ''}${strip ? ' is-strip' : ''}`} hidden={!visible || (!!maxId && maxId !== s.id)} style={{ ...(span ? { gridColumn: '1 / -1' } : {}), ...(at ? { gridColumn: at.col, gridRow: at.row } : {}), order: i }}>
        <TerminalPane session={s} stream={stream} role={byRole[s.role]} state={paneState(s, workingIds, pendingIds)} waiting={waitingBy.get(s.id)} fontSize={prefs.fontSize} maximized={maxId === s.id} onClose={() => close(s)} onMaximize={() => layoutActions.setMaximized(ws.id, maxId === s.id ? null : (s.recordId ?? null))} onFocus={strip ? () => setFocusBy({ ...focusBy, [ws.id]: s.id }) : undefined} />
      </div>
    );
  };
  const showGutters = !maxId && !focusPlan && mine.length > 1;
  const vBottom = shape.spanLast ? `${100 - dividerAt(cur.rows, cur.rows.length - 2)}%` : 0;

  return (
    <div className={`tg${maxId ? ' tg-full' : ''}`}>
      <div className="oc-bar" role="toolbar" aria-label={`Terminais de ${where}`}>
        <button type="button" className="oc-wschip" onClick={onOpenWorkspaces} title={ws ? `${ws.path}\nTrocar ou adicionar workspace` : 'Escolher um workspace'}>
          <Icon name="workspace" size={15} /><b>{ws ? where : 'Nenhum workspace'}</b><Icon name="chevronsUpDown" size={14} />
        </button>
        {ws && <>
          <div className="oc-grp" role="group" aria-label="Squads">
            {SQUADS.map((q) => <Btn key={q.id} kind="quiet" disabled={busy || q.roles.length > room} onClick={() => open(q.roles, { squad: true })} title={q.roles.map((r) => byRole[r]?.label ?? r).join(', ')}>{q.label}</Btn>)}
          </div>
          <div className="oc-grp" role="group" aria-label="Novo terminal">
            <label className="sr" htmlFor="tg-role">Papel do novo terminal</label>
            <select id="tg-role" className="oc-sel" value={role} onChange={(e) => setPref('role', e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            <Btn disabled={busy || room < 1} onClick={() => open([role])} title="Abrir um terminal com este papel"><Icon name="plus" size={12} /> Terminal</Btn>
          </div>
        </>}
        <div className="oc-right">
        {ws && <>
          {mine.length > 1 && <div className="oc-seg" role="radiogroup" aria-label="Organização dos terminais">
            {LAYOUT_MODES.map((m) => <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)} title={{ auto: 'Grade automática', cols: 'Todos lado a lado', rows: 'Todos empilhados', focus: 'Um terminal grande e os outros numa tira' }[m.id]}>{m.label}</button>)}
          </div>}
          <Btn kind="quiet" onClick={() => setHistOpen(true)} title="Sessões anteriores deste workspace: retomar ou fazer fork"><Icon name="clock" size={14} /> Histórico</Btn>
          <label className="oc-iso" title="Terminal avulso trabalha num git worktree próprio; um squad inteiro compartilha UM worktree (isolado do projeto principal, mas os terminais do squad editam os mesmos arquivos). Exige repositório Git.">
            <input type="checkbox" role="switch" checked={isolate} onChange={(e) => setPref('isolate', e.target.checked)} /><span className="oc-switch-track" aria-hidden="true"><i /></span>Worktree
          </label>
          <span className="oc-total" title={total.partialCost ? 'Há panes sem custo conhecido: o total em dólares não é exibido. Crie data/pricing.json com os preços por modelo (USD por milhão de tokens) para ver o custo.' : total.cost === '—' ? 'Custo indisponível: crie data/pricing.json com os preços por modelo (USD por milhão de tokens).' : 'Soma dos terminais deste tópico'}>{total.tokens} tok · {total.cost}</span>
          {mine.length > 1 && <Btn kind="quiet" disabled={busy} onClick={closeAll} title="Encerra e remove todos os terminais deste tópico">Encerrar todos</Btn>}
          {maestro && (maestro.autonomous || maestro.tasks.length > 0 || mine.some((x) => x.role === 'maestro' && x.status === 'running')) && <MaestroPopover onOpenSettings={onOpenSettings} />}
          <AgentsPopover className="oc-count" tone={mine.some((x) => x.status === 'running' && workingIds.has(x.id)) ? 'work' : liveMine ? 'live' : 'none'} title={`${live} de ${terminals?.maxSessions ?? '…'} terminais no total (todos os ambientes). Clique para ver os agentes por provider.`}><span className="oc-agents-t">{liveMine} {liveMine === 1 ? 'ativo' : 'ativos'}</span></AgentsPopover>
        </>}
        </div>
      </div>

      {!ws ? (
        <div className="oc-empty">
          <span className="oc-empty-ico"><Icon name="folderPlus" size={26} /></span>
          <h3>Escolha um workspace</h3>
          <p className="dim">Cada ambiente é uma pasta de projeto. Os terminais dos agentes abrem nela.</p>
          <Btn kind="primary" onClick={onOpenWorkspaces}>Abrir ou adicionar workspace</Btn>
        </div>
      ) : mine.length === 0 ? (
        <div className="oc-empty min">
          <Icon name="terminal" size={18} />
          <h3>{where}</h3>
          <p className="dim">Nenhum terminal ativo.</p>
          <div className="oc-empty-act">
            <Btn kind="primary" disabled={busy || room < 1} onClick={() => open([role])}><Icon name="plus" size={12} /> Novo terminal</Btn>
            {SQUADS.map((q) => <Btn key={q.id} kind="quiet" disabled={busy || q.roles.length > room} onClick={() => open(q.roles, { squad: true })} title={q.roles.map((r) => byRole[r]?.label ?? r).join(', ')}>{q.label}</Btn>)}
            {restorable > 0 && <Btn kind="quiet" onClick={() => setHistOpen(true)} title="Abre o histórico de sessões para retomá-las, na ordem em que estavam">Restaurar {restorable} {restorable === 1 ? 'sessão' : 'sessões'}</Btn>}
          </div>
          <p className="dim small oc-foot">Os terminais <b>não passam</b> pelas aprovações do ciclo automático: o que o agente faz ali é decisão sua.</p>
        </div>
      ) : null}

      <div className="oc-gridwrap" hidden={mine.length === 0}>
        <div ref={gridRef} className={`oc-grid${maxId ? ' has-max' : ''}`} style={focusPlan ? { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 1fr)', gridTemplateRows: `repeat(${focusPlan.rows}, minmax(0, 1fr))` } : { gridTemplateColumns: cur.cols.map((f) => `minmax(0, ${f}fr)`).join(' '), gridTemplateRows: cur.rows.map((f) => `minmax(0, ${f}fr)`).join(' ') }}>
          {sessions.map((s) => cell(s, mineIdx.get(s.id) ?? -1, mineIdx.has(s.id)))} {/* ordem estável: o React não move (nem remonta) os terminais ao trocar de aba ou tópico */}
          {showGutters && cur.cols.slice(0, -1).map((_, i) => <Gutter key={`x${i}`} axis="x" index={i} tracks={cur.cols} onTracks={(t) => setAxis('cols', t)} gridRef={gridRef} label={`Redimensionar colunas ${i + 1} e ${i + 2}`} style={{ left: `calc(${dividerAt(cur.cols, i)}% - 5px)`, top: 0, bottom: vBottom }} />)}
          {showGutters && cur.rows.slice(0, -1).map((_, i) => <Gutter key={`y${i}`} axis="y" index={i} tracks={cur.rows} onTracks={(t) => setAxis('rows', t)} gridRef={gridRef} label={`Redimensionar linhas ${i + 1} e ${i + 2}`} style={{ top: `calc(${dividerAt(cur.rows, i)}% - 5px)`, left: 0, right: 0 }} />)}
        </div>
      </div>
      {histOpen && ws && <SessionHistory ws={ws} topicId={topicId} where={where} order={L.order} autoRestore={autoRestore} onAutoRestore={setAutoRestore} onClose={() => setHistOpen(false)} />}
    </div>
  );
}
