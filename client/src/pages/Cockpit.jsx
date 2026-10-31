import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { TaskSegments, DemoTag, Btn, Glyph, fmtTime, statusLabel, typeLabel, cycleApprovalPending } from '../components/ui.jsx';
import TaskInspector from '../components/TaskInspector.jsx';
import NeuralCore from '../components/NeuralCore.jsx';
import FlowGraph from '../components/FlowGraph.jsx';
import CyclePanel from '../components/CyclePanel.jsx';
import ChatDock from '../components/ChatDock.jsx';
import { agentTokens } from '../usage-view.js';
import { agentState, latestExecutionFailed, coreMode, CORE_LABEL } from '../op-state.js';

const STATE_LABEL = {
  active: 'ativo', idle: 'ocioso', live: 'disponível', awaiting: 'aguardando aprovação',
  disconnected: 'desconectado', unavailable: 'indisponível', error: 'erro',
};
const CORE_GLYPH = { idle: 'idle', planning: 'active', executing: 'active', awaiting: 'awaiting', error: 'error' };

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

// Tom do evento (só reforça o tipo, que sempre aparece em texto): aprovação = verde; rejeição = vermelho; o resto, neutro.
const EVENT_TONE = { approval: 'ok', rejection: 'bad' };
function Events({ items, empty }) {
  if (!items.length) return <p className="dim small">{empty}</p>;
  return (
    <ul className="events">
      {items.map((a) => (
        <li key={a.id} className={`ev-${EVENT_TONE[a.type] || 'n'}`}>
          <div className="ev-meta"><time className="ev-time" dateTime={a.at}>{fmtTime(a.at).split(' ')[1]}</time><span className="ev-type">{typeLabel(a.type)}</span></div>
          <div className="ev-msg">{a.message}</div>
        </li>
      ))}
    </ul>
  );
}
const Kv = ({ k, children }) => <div className="kv"><span>{k}</span><span>{children}</span></div>;

export default function Cockpit() {
  const { mission, missions, agents, activity, state, act, notify, selectMission } = useStore();
  const [sel, setSel] = useState(null);       // tarefa selecionada no grafo (id)
  const [tab, setTab] = useState('overview'); // overview | events | task | cycle
  const [git, setGit] = useState(null);
  const panelRef = useRef(null);
  const fresh = useFresh(activity, !!state);
  const flash = useMemo(() => new Set(fresh.events.map((e) => e.taskId).filter(Boolean)), [fresh.batch]); // eslint-disable-line react-hooks/exhaustive-deps
  const [locate, setLocate] = useState(null); // pedido de centralizar uma tarefa no canvas

  // ao trocar de missão a seleção só sobrevive se a tarefa pertence à nova missão
  useEffect(() => { setSel((cur) => (mission?.tasks.some((t) => t.id === cur) ? cur : null)); }, [mission?.id]);
  useEffect(() => { if (!sel && tab === 'task') setTab('overview'); }, [sel, tab]);

  const select = useCallback((id) => { setSel(id); setTab('task'); setTimeout(() => panelRef.current?.focus(), 0); }, []);
  const clear = useCallback(() => {
    setSel((cur) => { if (cur) setTimeout(() => document.querySelector(`[data-node="${cur}"]`)?.focus(), 0); return null; });
  }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !document.querySelector('.menu')) clear(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [clear]);

  const planner = agents.find((a) => a.id === 'planner');
  const executor = agents.find((a) => a.id === 'executor');
  const awaiting = state?.counts.awaitingApproval ?? 0;
  const cycleApprovals = missions.filter(cycleApprovalPending); // M9: ações do ciclo esperando aprovação (dado real do servidor)
  const ws = state?.activeWorkspace;
  const execBusy = !!state?.executor.busy;
  const runningTask = missions.flatMap((m) => m.tasks).find((t) => t.id === state?.executor.current?.taskId);
  const task = mission?.tasks.find((t) => t.id === sel);
  const pendingFirst = missions.flatMap((m) => m.tasks.filter((t) => t.status === 'awaiting_approval').map((t) => ({ m, t })))[0];
  const current = mission?.tasks.find((t) => t.status === 'running') || mission?.tasks.find((t) => t.status === 'awaiting_approval') || mission?.tasks.find((t) => t.status === 'queued');
  const done = mission ? mission.tasks.filter((t) => t.status === 'completed').length : 0;
  // erro do executor = a execução MAIS RECENTE falhou (e não foi rejeição humana); uma execução posterior bem-sucedida o supera
  const execError = latestExecutionFailed(missions.flatMap((m) => m.tasks));
  const plannerSt = agentState(planner);
  const executorSt = execError ? 'error' : agentState(executor);
  const pendingAll = awaiting + cycleApprovals.length;
  // o núcleo reflete o estado REAL (executor ocupado, planner ocupado, falha, decisão pendente), sem temporizadores nem simulação
  const mode = coreMode({ executorBusy: execBusy, runningTasks: state?.counts.running ?? 0, plannerBusy: !!state?.planner?.busy || planner?.status === 'running', pending: pendingAll, failed: execError });
  const coreLine = { executing: `Executando: ${runningTask?.title ?? 'uma tarefa'}`, planning: 'O Planner está decidindo a próxima etapa.', awaiting: 'Nada executa até você decidir.', error: 'A última execução falhou; veja a tarefa com erro.', idle: 'Sem execução ativa.' }[mode];
  const tokens = { planner: agentTokens(state?.usage, mission?.id, 'planner'), executor: agentTokens(state?.usage, mission?.id, 'executor') };

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
  const review = () => {
    if (!pendingFirst && cycleApprovals.length) { selectMission(cycleApprovals[0].id); setTab('cycle'); return; }
    if (!pendingFirst) return;
    if (pendingFirst.m.id !== mission?.id) selectMission(pendingFirst.m.id);
    select(pendingFirst.t.id);
  };

  useEffect(() => {
    if (tab !== 'overview' || !ws) return undefined;
    let alive = true;
    setGit(null);
    api.get(`/api/workspaces/${ws.id}/git`).then((g) => alive && setGit(g)).catch((e) => alive && setGit({ error: e.message }));
    return () => { alive = false; };
  }, [tab, ws?.id]);

  const tabs = [['overview', 'Visão geral'], ['events', 'Eventos'], ...(task ? [['task', 'Tarefa']] : []), ...(mission && !mission.demo ? [['cycle', 'Ciclo']] : [])];
  const onTabKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(([id]) => id === tab), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length][0];
    setTab(n); document.getElementById(`tab-${n}`)?.focus();
  };

  return (
    <div className="ck">
      <section className="ck-main" aria-label="Missão atual">
        <header className="ck-head">
          <div className="ck-id">
            <span className="k">Missão {mission?.demo && <DemoTag />}</span>
            {mission ? <h2 className="ck-title">{mission.title}</h2> : <h2 className="ck-title">Nenhuma missão ativa</h2>}
            {mission ? (
              <div className="ck-meta">
                {mission.tasks.length > 0 && <span className="ck-prog"><TaskSegments tasks={mission.tasks} /><span>{done} de {mission.tasks.length} concluídas</span></span>}
                {mission.cycle && <span>Ciclo {statusLabel(mission.cycle.status, true)}, rodada {mission.cycle.rounds.length} de {mission.cycle.maxIterations}</span>}
                {current && <span>Agora: {current.title}</span>}
              </div>
            ) : <p className="dim small">Descreva o que quer construir na conversa ou crie uma missão manualmente.</p>}
          </div>
          {pendingAll > 0 && (
            <div className="attn" role="group" aria-label="Aprovações pendentes">
              <Glyph kind="awaiting" />
              <div className="attn-txt"><b>{pendingAll} {pendingAll === 1 ? 'aprovação pendente' : 'aprovações pendentes'}</b>Nada executa até você decidir.</div>
              <Btn kind="primary" onClick={review}>Revisar</Btn>
            </div>
          )}
        </header>
        <div className="ck-canvas">
          <FlowGraph mission={mission} selectedId={sel} onSelect={select} flash={flash} locate={locate}
            empty={<div className="ck-empty"><h3>Comece por aqui</h3><p className="dim">O grafo do trabalho aparece quando há uma missão: a intenção no topo e as tarefas ligadas por suas dependências.</p><div className="actions"><a className="btn primary" href="#/chat">Conversar com o orquestrador</a><a className="btn" href="#/missions?new">Criar missão manualmente</a></div></div>} />
        </div>
      </section>

      <aside className="ck-side" aria-label="Inspetor">
        <div className={`orch st-${mode}`}>
          <NeuralCore mode={mode} size={112} />
          <div className="orch-text">
            <b>Orquestrador</b>
            <span className="status"><Glyph kind={CORE_GLYPH[mode]} />{CORE_LABEL[mode]}</span>
            <span className="dim small">{coreLine}</span>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Inspetor" onKeyDown={onTabKey}>
          {tabs.map(([id, label]) => <button key={id} id={`tab-${id}`} type="button" role="tab" className="tab" aria-selected={tab === id} aria-controls="ck-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        <div id="ck-panel" className="ck-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1} ref={panelRef} key={tab}>
          {tab === 'overview' && <>
            <section className="blk">
              <h3 className="blk-h">Agentes</h3>
              {planner && (
                <details className="agent-row">
                  <summary><span className="ar-name">Planner</span><span className={`status st-${plannerSt}`}><Glyph kind={plannerSt} />{STATE_LABEL[plannerSt]}</span></summary>
                  <div className="ar-body">
                    <p className="dim small">{planner.detail}</p>
                    <Kv k="Função">{planner.role}</Kv>
                    <Kv k="Disponibilidade">{planner.availability === 'connected' ? 'Claude Code, sem ferramentas' : 'indisponível'}</Kv>
                    <Kv k="Tokens nesta missão">{tokens.planner.text}{tokens.planner.partial && ' (parcial)'}</Kv>
                    <p className="dim small">Só devolve uma decisão (<span className="mono">continue</span>, <span className="mono">complete</span> ou <span className="mono">blocked</span>), validada pelo servidor. Não executa nada nem altera permissões.</p>
                  </div>
                </details>
              )}
              {executor && (
                <details className="agent-row">
                  <summary><span className="ar-name">Executor</span><span className={`status st-${executorSt}`}><Glyph kind={executorSt} />{STATE_LABEL[executorSt]}</span></summary>
                  <div className="ar-body">
                    <p className="dim small">{execBusy ? `Executando: ${runningTask?.title ?? '…'}` : executor.available ? `Claude Code ${executor.version?.split(' ')[0] ?? ''} pronto` : 'CLI não detectada no PATH'}</p>
                    <Kv k="Função">{executor.role}</Kv>
                    <Kv k="Execução ativa">{execBusy ? 'sim' : 'não'}</Kv>
                    <Kv k="Permissões">leitura e edição de arquivos; sem shell nem rede</Kv>
                    <Kv k="Tokens nesta missão">{tokens.executor.text}{tokens.executor.partial && ' (parcial)'}</Kv>
                    {execError && <p className="s-failed small">Há tarefa com falha de execução (não rejeitada por humano).</p>}
                    {execBusy && <div className="actions"><Btn kind="danger" onClick={stopRun}>Interromper execução</Btn></div>}
                  </div>
                </details>
              )}
            </section>
            <section className="blk">
              <h3 className="blk-h">Espaço de trabalho</h3>
              {ws ? <>
                <div className="blk-main">{ws.name}</div>
                <div className="mono small dim path">{ws.path}</div>
                <Kv k="Git">{!git ? 'consultando…' : git.error ? <span className="s-failed">{git.error}</span> : !git.isRepo ? 'não é repositório Git' : `${git.branch}, ${git.dirty ? `${git.changeCount} ${git.changeCount === 1 ? 'alteração' : 'alterações'}` : 'limpo'}`}</Kv>
                <Kv k="package.json">{ws.hasPackageJson ? 'sim' : 'não'}</Kv>
              </> : <p className="dim small">Nenhum espaço ativo. <a href="#/workspaces">Cadastrar um</a></p>}
            </section>
            <section className="blk">
              <h3 className="blk-h">Fila</h3>
              <p className="small">{state?.counts.pending ?? 0} {state?.counts.pending === 1 ? 'tarefa pendente' : 'tarefas pendentes'} em todas as missões.</p>
            </section>
          </>}

          {tab === 'events' && <>
            <Events items={activity.slice(0, 40)} empty="Sem eventos ainda. Missões, aprovações e execuções aparecem aqui assim que acontecem." />
            <p className="small"><a href="#/activity">Ver toda a atividade</a></p>
          </>}

          {tab === 'task' && task && <TaskInspector mission={mission} task={task} actions={actions} busy={execBusy} onClose={clear} onLocate={() => setLocate((l) => ({ id: task.id, n: (l?.n || 0) + 1 }))} />}

          {tab === 'cycle' && mission && <CyclePanel mission={mission} />}
        </div>
      </aside>

      <ChatDock />
    </div>
  );
}
