import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

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

  return (
    <Ctx.Provider value={{ ...data, error, mission, selectMission, refresh, act, notify, toast }}>{children}</Ctx.Provider>
  );
}
