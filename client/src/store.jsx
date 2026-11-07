import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, nav } from './api.js';
import { createActivityTracker } from './activity.js';
import { createWorkEndTracker, finishedStamps, unseenFinished } from './workspace-nav.js';
import { paneState } from './env-view.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }) {
  const [data, setData] = useState({ state: null, missions: [], workspaces: [], agents: [], activity: [] });
  const [error, setError] = useState(null);
  const [selectedMissionId, setSelectedMissionId] = useState(() => localStorage.getItem('mission') || null);

  // Só a resposta de /api/state MAIS RECENTE é aplicada: o refresh completo e a atualização leve de uso (abaixo) podem se cruzar.
  const stateSeq = useRef(0);
  const refresh = useCallback(async () => {
    const my = ++stateSeq.current;
    try {
      const [state, missions, workspaces, agents, activity] = await Promise.all([
        api.get('/api/state'), api.get('/api/missions'), api.get('/api/workspaces'),
        api.get('/api/agents'), api.get('/api/activity'),
      ]);
      setData((prev) => ({ state: my === stateSeq.current ? state : prev.state, missions, workspaces, agents, activity }));
      setError(null);
    } catch (e) {
      setError('API indisponível. Inicie o backend (npm run server).');
    }
  }, []);

  // Evento SSE `usage`: relê só /api/state, onde o servidor já entrega o agregado (nada é somado no cliente, então nenhum dado conta duas vezes).
  const refreshUsage = useCallback(async () => {
    const my = ++stateSeq.current;
    try {
      const state = await api.get('/api/state');
      if (my === stateSeq.current) setData((prev) => ({ ...prev, state }));
    } catch { /* o polling de 5 s cobre */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Terminais e maestro: UMA fonte para a sidebar (ambientes e indicadores) e para o Cockpit (grade). Dados reais de /api/terminals e /api/maestro; a tela só é
  // atualizada quando algo mudou. "Trabalhando" = saída SUSTENTADA do pane fora de qualquer interação da interface (activity.js); clique, foco e redimensionamento nunca contam (nada é simulado). Com a aba oculta o polling pausa.
  const [terminals, setTerminals] = useState(null);   // { roles, maxSessions, sessions }
  const [maestro, setMaestro] = useState(null);       // { autonomous, autoPerMinute, tasks }
  const [workingIds, setWorkingIds] = useState(() => new Set());
  const tracker = useRef(null), lastT = useRef(''), lastM = useRef('');
  if (!tracker.current) tracker.current = createActivityTracker();
  // Aviso de término ("!" no workspace): um workspace terminou algo quando uma tarefa do maestro conclui, um terminal encerra ou o trabalho dele (saída sustentada) PARA.
  // O aviso fica até você voltar a interagir com o workspace (ativá-lo ou clicar/digitar num terminal dele). Só a conveniência de "visto" vai ao localStorage.
  const workEnd = useRef(null); if (!workEnd.current) workEnd.current = createWorkEndTracker();
  const baseline = useRef(new Date().toISOString()).current;
  const [workEnds, setWorkEnds] = useState({});
  const [seen, setSeen] = useState(() => { try { return JSON.parse(localStorage.getItem('forge.finishSeen') || '{}') || {}; } catch { return {}; } });
  const seenRef = useRef(seen); seenRef.current = seen;
  const stampsRef = useRef(new Map()), wsOfRef = useRef(new Map());
  const markSeen = useCallback((ws) => {
    const at = stampsRef.current.get(ws);
    if (!ws || !at || (seenRef.current[ws] ?? baseline) >= at) return;
    const next = { ...seenRef.current, [ws]: at }; seenRef.current = next; setSeen(next);
    try { localStorage.setItem('forge.finishSeen', JSON.stringify(next)); } catch { /* sem armazenamento: vale só nesta sessão */ }
  }, [baseline]);
  const noteInteraction = useCallback((id) => { tracker.current.noteInteraction(id); markSeen(wsOfRef.current.get(id)); }, [markSeen]); // clique, foco, tecla, mouse ou redimensionamento no pane: silencia a classificação dele e dá o término do workspace como visto
  const loadTerminals = useCallback(async () => {
    try {
      const d = await api.get('/api/terminals');
      const act = tracker.current.update(d.sessions);
      wsOfRef.current = new Map(d.sessions.map((x) => [x.id, x.workspaceId]));
      // "Trabalhando" por workspace com a MESMA regra dos indicadores (estado real do agente pelos hooks; sem hooks, a leitura pela saída): só quando NENHUM agente do workspace trabalha mais é que a equipe terminou.
      const ends = workEnd.current.update(new Set(d.sessions.filter((x) => x.workspaceId && paneState(x, act) === 'working').map((x) => x.workspaceId)));
      setWorkEnds((prev) => (JSON.stringify(prev) === JSON.stringify(ends) ? prev : ends));
      setWorkingIds((prev) => (prev.size === act.size && [...act].every((x) => prev.has(x)) ? prev : act));
      const json = JSON.stringify(d); if (json !== lastT.current) { lastT.current = json; setTerminals(d); }
      api.get('/api/maestro').then((m) => { const j = JSON.stringify(m); if (j !== lastM.current) { lastM.current = j; setMaestro(m); } }).catch(() => {});
    } catch { /* servidor fora do ar: mantém o último estado */ }
  }, []);
  const updateMaestro = useCallback((m) => { lastM.current = JSON.stringify(m); setMaestro(m); }, []);
  useEffect(() => {
    loadTerminals();
    const tick = () => { if (!document.hidden) loadTerminals(); };
    const t = setInterval(tick, 1500);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [loadTerminals]);

  // Eventos em tempo real (SSE). O polling acima continua como rede de segurança.
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('log', (e) => {
      const d = JSON.parse(e.data);
      setData((prev) => ({ ...prev, missions: prev.missions.map((m) => (m.id !== d.missionId ? m : {
        ...m,
        tasks: m.tasks.map((t) => (t.id !== d.taskId || (t.logTotal || 0) >= d.count ? t : { ...t, log: [...t.log, d.line].slice(-600), logTotal: d.count })),
      })) }));
    });
    const again = () => refresh();
    es.addEventListener('task', again); es.addEventListener('state', again); es.addEventListener('hello', again); es.addEventListener('cycle', again);
    // Atualizações de uso chegam em rajadas: uma releitura a cada ~400 ms, sempre depois do último evento da rajada.
    let timer = null;
    es.addEventListener('usage', () => { if (!timer) timer = setTimeout(() => { timer = null; refreshUsage(); }, 400); });
    return () => { es.close(); clearTimeout(timer); };
  }, [refresh, refreshUsage]);

  const activeWsId = data.state?.activeWorkspace?.id ?? null;
  // Terminal que o usuário encerrou (ou que acabou) não conta como "a equipe terminou": só tarefa concluída e o fim do trabalho observado, olhando os terminais vivos.
  const stamps = React.useMemo(() => finishedStamps({ sessions: (terminals?.sessions ?? []).filter((x) => x.status === 'running'), maestroTasks: maestro?.tasks ?? [], workEnds }), [terminals, maestro, workEnds]);
  stampsRef.current = stamps;
  useEffect(() => { markSeen(activeWsId); }, [activeWsId, markSeen]); // ativar o workspace = ver o que terminou nele até agora (um término posterior volta a avisar)
  const unseenWs = React.useMemo(() => unseenFinished({ stamps, seen, baseline }), [stamps, seen, baseline]);

  const selectMission = (id) => {
    setSelectedMissionId(id);
    if (id) localStorage.setItem('mission', id);
  };

  const mission = data.missions.find((m) => m.id === selectedMissionId) || data.missions[0] || null;
  const [toast, setToast] = useState(null);
  const notify = useCallback((text, kind = 'info') => {
    const id = Date.now();
    setToast({ id, text, kind });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 4500);
  }, []);
  const act = async (fn) => {
    try { const r = await fn(); await refresh(); return r; } catch (e) { notify(e.message, 'error'); }
  };

  // Navegação por abas e tópicos: vem de /api/state (o servidor é a fonte); sem o campo, só o workspace ativo conta como aberto.
  const openWorkspaceIds = data.state?.openWorkspaceIds ?? (data.state?.activeWorkspace ? [data.state.activeWorkspace.id] : []);
  const topics = data.state?.topics ?? [];
  const activeTopicIds = data.state?.activeTopicIds ?? {}; // só o servidor decide (Geral = sem entrada)
  /** Ativa um tópico (id) ou Geral (null) no workspace, sempre pelo servidor. */
  const selectTopic = (workspaceId, topicId) => act(() => (topicId ? nav.activateTopic(topicId) : nav.activateGeneral(workspaceId)));

  return (
    <Ctx.Provider value={{ ...data, openWorkspaceIds, topics, activeTopicIds, selectTopic, error, mission, selectMission, refresh, act, notify, toast, terminals, maestro, setMaestro: updateMaestro, workingIds, loadTerminals, noteInteraction, unseenWs }}>{children}</Ctx.Provider>
  );
}
