import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }) {
  const [data, setData] = useState({ state: null, missions: [], workspaces: [], agents: [], activity: [] });
  const [error, setError] = useState(null);
  const [selectedMissionId, setSelectedMissionId] = useState(() => localStorage.getItem('mission') || null);

  const refresh = useCallback(async () => {
    try {
      const [state, missions, workspaces, agents, activity] = await Promise.all([
        api.get('/api/state'), api.get('/api/missions'), api.get('/api/workspaces'),
        api.get('/api/agents'), api.get('/api/activity'),
      ]);
      setData({ state, missions, workspaces, agents, activity });
      setError(null);
    } catch (e) {
      setError('API indisponível. Inicie o backend (npm run server).');
    }
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
    es.addEventListener('task', again); es.addEventListener('state', again); es.addEventListener('hello', again);
    return () => es.close();
  }, [refresh]);

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
