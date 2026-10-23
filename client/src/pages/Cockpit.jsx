import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Progress, DemoTag, Empty, Btn, fmtTime } from '../components/ui.jsx';
import { AgentCard, TaskQueue, Terminal, ReviewPanel } from '../components/Widgets.jsx';
import NeuralCore, { reactionFor, usePrefersReduced } from '../components/NeuralCore.jsx';

// Posição de cada nó (fração da área) e conexões justificadas pela arquitetura:
// planner propõe -> portão humano aprova -> executor executa no workspace; a fila alimenta o núcleo.
// Uma conexão desenhada indica relação, não comunicação em andamento.
const POS = { planner: [0.2, 0.2], executor: [0.8, 0.2], queue: [0.1, 0.58], workspace: [0.9, 0.58], gate: [0.5, 0.91] };
const LINKS = [
  ['core', 'planner'], ['core', 'executor'], ['core', 'gate'], ['core', 'workspace'], ['core', 'queue'],
  ['planner', 'gate'], ['gate', 'executor'], ['executor', 'workspace'],
];
const LABEL = { planner: 'Planner', executor: 'Executor', gate: 'Aprovação humana', queue: 'Fila de tarefas', workspace: 'Workspace' };
const KIND = { planner: 'agent', executor: 'agent', gate: 'gate', queue: 'res', workspace: 'res' };
const STATE_LABEL = {
  active: 'ativo', idle: 'ocioso', live: 'disponível', awaiting: 'aguardando aprovação',
  disconnected: 'desconectado', unavailable: 'indisponível', error: 'erro',
};
const KIND_LABEL = { agent: 'agente', gate: 'portão humano', res: 'recurso' };

const agentState = (a) => (a.status === 'running' ? 'active' : a.status === 'idle' ? 'idle'
  : a.availability === 'disconnected' ? 'disconnected' : 'unavailable');

// Eventos NOVOS desde que a tela carregou (o histórico inicial nunca gera reação).
function useFresh(events, ready) {
  const seen = useRef(null);
  const [fresh, setFresh] = useState({ batch: 0, events: [] });
  useEffect(() => {
    if (!ready) return;
    if (seen.current === null) { seen.current = new Set(events.map((e) => e.id)); return; }
    const news = events.filter((e) => !seen.current.has(e.id));
    if (!news.length) return;
    news.forEach((e) => seen.current.add(e.id));
    setFresh((f) => ({ batch: f.batch + 1, events: news.reverse() }));
  }, [events, ready]);
  return fresh;
}

function Node({ id, line, state, selected, flash, onClick }) {
  const kind = KIND[id];
  return (
    <button id={`node-${id}`} type="button" aria-pressed={selected}
      aria-label={`${LABEL[id]}, ${KIND_LABEL[kind]}, estado: ${STATE_LABEL[state]}${line ? `, ${line}` : ''}`}
      className={`node k-${kind} st-${state}${selected ? ' sel' : ''}${flash ? ' flash' : ''}${POS[id][0] > 0.7 ? ' shiftable' : ''}`}
      style={{ '--x': `${POS[id][0] * 100}%`, '--y': `${POS[id][1] * 100}%` }} onClick={onClick}>
      <span className="kind">{KIND_LABEL[kind]}</span>
      <b>{LABEL[id]}</b>
      <span className="st"><i />{STATE_LABEL[state]}</span>
      {line && <span className="line">{line}</span>}
    </button>
  );
}

function Events({ items, empty }) {
  if (!items.length) return <div className="dim small">{empty}</div>;
  return (
    <ul className="events">
      {items.map((a) => (
        <li key={a.id}><span className="dim">{fmtTime(a.at).split(' ')[1]}</span> <span className={`type t-${a.type}`}>{a.type}</span> {a.message}</li>
      ))}
    </ul>
  );
}
const Row = ({ k, children }) => <div className="row small"><span className="dim">{k}</span><span className="val">{children}</span></div>;

export default function Cockpit() {
  const { mission, missions, agents, activity, state, act, notify } = useStore();
  const [taskId, setTaskId] = useState(null);
  const [sel, setSel] = useState(null);       // nó selecionado (alvo)
  const [panel, setPanel] = useState(null);   // painel renderizado (permanece montado durante a saída)
  const [flash, setFlash] = useState({});
  const [git, setGit] = useState(null);
  const panelRef = useRef(null);
  const fresh = useFresh(activity, !!state);
  const prefersReduced = usePrefersReduced();
  const [force, setForce] = useState(() => { try { return localStorage.getItem('core-motion') === 'on'; } catch { return false; } });
  const toggleForce = () => setForce((f) => { try { localStorage.setItem('core-motion', f ? 'off' : 'on'); } catch { /* sem armazenamento */ } return !f; });

  useEffect(() => {
    if (!mission) return;
    const pending = mission.tasks.find((t) => t.status === 'awaiting_approval');
    setTaskId((cur) => (mission.tasks.some((t) => t.id === cur) ? cur : (pending || mission.tasks[0])?.id ?? null));
  }, [mission?.id]);

  // painel: monta ao selecionar, desmonta 200 ms depois de desselecionar (animação de saída)
  useEffect(() => {
    if (sel) { setPanel(sel); return undefined; }
    const t = setTimeout(() => setPanel(null), 200);
    return () => clearTimeout(t);
  }, [sel]);
  useEffect(() => { if (sel && sel !== 'queue') panelRef.current?.focus(); }, [panel]);

  const close = useCallback(() => {
    setSel((cur) => { if (cur) setTimeout(() => document.getElementById(`node-${cur}`)?.focus(), 0); return null; });
  }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);

  // reação dos nós a eventos reais novos
  useEffect(() => {
    const ids = fresh.events.map((e) => reactionFor(e).node).filter(Boolean);
    if (!ids.length) return undefined;
    setFlash((f) => Object.fromEntries([...Object.entries(f), ...ids.map((i) => [i, fresh.batch])]));
    const t = setTimeout(() => setFlash({}), 1500);
    return () => clearTimeout(t);
  }, [fresh.batch]);

  const planner = agents.find((a) => a.id === 'planner');
  const executor = agents.find((a) => a.id === 'executor');
  const awaiting = state?.counts.awaitingApproval ?? 0;
  const running = (state?.counts.running ?? 0) > 0;
  const ws = state?.activeWorkspace;
  const execBusy = !!state?.executor.busy;
  const runningTask = missions.flatMap((m) => m.tasks).find((t) => t.id === state?.executor.current?.taskId);
  const task = mission?.tasks.find((t) => t.id === taskId);
  const pendingTasks = mission?.tasks.filter((t) => t.status === 'awaiting_approval') ?? [];
  const current = mission?.tasks.find((t) => t.status === 'running') || pendingTasks[0] || mission?.tasks.find((t) => t.status === 'queued');
  const done = mission ? mission.tasks.filter((t) => t.status === 'completed').length : 0;
  // falha de execução = tarefa "failed" que NÃO foi rejeitada por um humano (hoje nenhuma execução ocorre)
  const execError = missions.some((m) => m.tasks.some((t) => t.status === 'failed' && !t.rejected));

  const st = {
    planner: planner ? agentState(planner) : 'unavailable',
    executor: execError ? 'error' : executor ? agentState(executor) : 'unavailable',
    gate: awaiting > 0 ? 'awaiting' : 'live', queue: 'live', workspace: ws ? 'live' : 'disconnected',
  };
  const nodes = Object.keys(POS).map((id) => ({ id, x: POS[id][0], y: POS[id][1], state: st[id] }));
  const lines = {
    planner: planner?.detail, executor: execBusy ? `executando: ${runningTask?.title ?? '…'}` : executor?.available ? `Claude Code ${executor.version?.split(' ')[0] ?? ''}` : 'CLI não detectada',
    gate: awaiting > 0 ? `${awaiting} pendente${awaiting > 1 ? 's' : ''}` : 'sem pendências',
    queue: `${state?.counts.pending ?? 0} pendentes`, workspace: ws ? ws.name : 'nenhum ativo',
  };

  const choose = (id) => {
    if (sel === id) { close(); return; }
    if (id === 'gate' && pendingTasks[0]) setTaskId(pendingTasks[0].id);
    setSel(id);
  };
  // Cada ação chama a API; o servidor revalida tudo e devolve o motivo em caso de bloqueio.
  const post = async (path, ok) => {
    const r = await act(() => api.post(`/api/missions/${mission.id}/tasks/${task.id}/${path}`));
    if (r && ok) notify(ok);
  };
  const stopRun = () => act(async () => { const r = await api.post('/api/execution/stop'); notify(r.detail, r.stopped ? 'info' : 'error'); });
  const actions = {
    authorize: () => post('authorize', 'Execução autorizada. Clique em Executar para iniciar.'),
    revoke: () => post('revoke', 'Autorização revogada.'),
    run: () => post('run', 'Execução iniciada.'),
    stop: stopRun,
    approve: () => post('approve', 'Resultado aprovado.'),
    reject: () => post('reject', 'Resultado rejeitado.'),
  };


  useEffect(() => {
    if (panel !== 'workspace' || !ws) return undefined;
    let alive = true;
    setGit(null);
    api.get(`/api/workspaces/${ws.id}/git`).then((g) => alive && setGit(g)).catch((e) => alive && setGit({ error: e.message }));
    return () => { alive = false; };
  }, [panel, ws?.id]);

  const closing = !sel && panel;
  const shifted = !!panel && panel !== 'queue' && !closing;
  const closeBtn = <button type="button" className="btn" onClick={close} aria-label="Fechar painel">Esc ✕</button>;

  return (
    <div className={`stage${shifted ? ' panel-open' : ''}`}>
      <NeuralCore running={running} awaiting={awaiting} nodes={nodes} links={LINKS} fresh={fresh} selected={sel} forceMotion={force} layout={shifted ? 'shifted' : 'full'} />

      <div className="hud tl">
        <div className="k">missão {mission?.demo && <DemoTag />}</div>
        <div className="v">{mission ? mission.title : <>nenhuma — <a href="#/missions?new">criar</a></>}</div>
        <div className="k">tarefa</div>
        <div className="v">{current ? current.title : '—'}</div>
        {mission && mission.tasks.length > 0 && <div className="mini"><Progress done={done} total={mission.tasks.length} /><span className="dim small">{done}/{mission.tasks.length}</span></div>}
      </div>
      <div className="hud tr">
        {prefersReduced && <button type="button" className="btn motion" onClick={toggleForce} aria-pressed={force}>{force ? 'Animação forçada · voltar à preferência do sistema' : 'Movimento reduzido pelo sistema · animar mesmo assim'}</button>}
        {awaiting > 0
          ? <button className="alert" onClick={() => choose('gate')}>● {awaiting} aprovação pendente — revisar</button>
          : <span className="dim small">nenhuma aprovação pendente</span>}
      </div>
      <div className="hud bl">
        <div className="k">eventos recentes</div>
        <Events items={activity.slice(0, 3)} empty="Sem eventos ainda." />
      </div>
      <div className="hud br">
        <div className="legend">
          {['active', 'idle', 'awaiting', 'disconnected', 'unavailable', 'error'].map((s) => <span key={s} className={`st-${s}`}><i />{STATE_LABEL[s]}</span>)}
        </div>
        <button type="button" className="btn" aria-pressed={sel === 'queue'} onClick={() => choose('queue')}>{sel === 'queue' ? '▾' : '▴'} Fila e terminal</button>
      </div>

      {Object.keys(POS).filter((id) => (id !== 'planner' || planner) && (id !== 'executor' || executor)).map((id) => (
        <Node key={id} id={id} state={st[id]} line={lines[id]} selected={sel === id} flash={flash[id] !== undefined} onClick={() => choose(id)} />
      ))}

      {panel && panel !== 'queue' && (
        <aside className={`overlay${closing ? ' out' : ''}`} ref={panelRef} tabIndex={-1} role="dialog" aria-label={`Detalhes: ${LABEL[panel]}`}>
          <header><h3>{LABEL[panel]} {panel === 'gate' && mission?.demo && <DemoTag />}</h3>{closeBtn}</header>
          <div className="rowline"><span className={`st-${st[panel]}`}><i className="dot" />{STATE_LABEL[st[panel]]}</span><span className="dim small">{KIND_LABEL[KIND[panel]]}</span></div>

          {panel === 'planner' && planner && <>
            <p>{planner.role}</p>
            <Row k="disponibilidade">{planner.availability === 'unavailable' ? 'indisponível (não implementado)' : planner.availability}</Row>
            <Row k="conexão">não conectado</Row>
            <p className="dim small">Nenhuma tarefa foi planejada e nenhuma mensagem foi trocada com este agente.</p>
          </>}

          {panel === 'executor' && executor && <>
            <p>{executor.role}</p>
            <Row k="CLI Claude Code">{executor.available ? `detectada (${executor.version})` : 'não detectada no PATH'}</Row>
            <Row k="integração">{executor.available ? 'conectada: executa só tarefas autorizadas por humano' : 'indisponível'}</Row>
            <Row k="execução ativa">{execBusy ? 'sim' : 'não'}</Row>
            {execBusy && <Row k="tarefa em execução">{runningTask?.title ?? '…'}</Row>}
            <Row k="permissões">leitura e edição de arquivos; sem shell nem rede; pedidos extras são negados</Row>
            {execBusy && <div className="actions"><Btn kind="danger" onClick={stopRun}>■ Interromper execução</Btn></div>}
            {execError && <p className="s-failed small">Há tarefa com falha de execução (não rejeitada por humano).</p>}
            <p className="dim small">Detectar a CLI não significa execução ativa; o estado acima vem do servidor.</p>
          </>}

          {panel === 'gate' && <>
            <p className="dim small">Portão que exige decisão humana antes de cada tarefa. Não é um agente.</p>
            {mission && mission.tasks.length > 1 && (
              <label className="small dim">Tarefa
                <select value={taskId ?? ''} onChange={(e) => setTaskId(e.target.value)}>
                  {mission.tasks.map((t, i) => <option key={t.id} value={t.id}>{String(i + 1).padStart(2, '0')} · {t.title} ({t.status})</option>)}
                </select>
              </label>
            )}
            {mission ? <ReviewPanel mission={mission} task={task} actions={actions} busy={execBusy} /> : <Empty>Sem missão.</Empty>}
          </>}

          {panel === 'workspace' && <>
            {ws ? <>
              <Row k="nome">{ws.name}</Row>
              <div className="mono small path">{ws.path}</div>
              <Row k="Git">{!git ? 'consultando…' : git.error ? <span className="s-failed">{git.error}</span> : !git.isRepo ? 'não é repositório Git' : `${git.branch} · ${git.dirty ? `${git.changeCount} alterações` : 'limpo'}`}</Row>
              <Row k="package.json">{ws.hasPackageJson ? 'sim' : 'não'}</Row>
            </> : <p className="dim">Nenhum workspace ativo.</p>}
            <p><a href="#/workspaces">Gerenciar workspaces →</a></p>
          </>}

          <div className="k sec">atividades</div>
          <Events
            items={activity.filter((a) => ({
              planner: false,
              executor: a.type === 'system' || a.type === 'execution',
              gate: a.type === 'approval' || a.type === 'rejection',
              workspace: a.type === 'workspace',
            })[panel]).slice(0, 6)}
            empty="Nenhuma atividade registrada."
          />
        </aside>
      )}

      {panel === 'queue' && (
        <section className={`drawer${closing ? ' out' : ''}`} ref={panelRef} role="dialog" aria-label="Fila de tarefas e terminal">
          <header><h3>Fila e terminal {mission?.demo && <DemoTag />}</h3>{closeBtn}</header>
          {mission ? (
            <div className="drawer-body">
              <TaskQueue mission={mission} selectedId={taskId} onSelect={setTaskId} />
              <Terminal mission={mission} task={task} />
            </div>
          ) : <div className="dim">Nenhuma missão.</div>}
        </section>
      )}
    </div>
  );
}
