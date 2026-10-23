import React from 'react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Status, Btn } from './ui.jsx';

export default function Topbar() {
  const { state, mission, act, notify } = useStore();
  const c = state?.counts;
  const stop = () =>
    act(async () => {
      const r = await api.post('/api/execution/stop');
      notify(r.detail);
    });
  return (
    <header className="topbar">
      <div className="crumb"><span className="k">mission</span> <b>{mission ? mission.title : '—'}</b></div>
      <div className="crumb"><span className="k">workspace</span> <b>{state?.activeWorkspace?.name || 'nenhum'}</b></div>
      <div className="spacer" />
      <div className="kpi"><span className="k">sistema</span> {state ? <Status value={state.system} /> : '…'}</div>
      <div className="kpi"><span className="k">agentes ativos</span> <b>{c ? c.activeAgents : '—'}</b></div>
      <div className="kpi"><span className="k">pendentes</span> <b>{c ? c.pending : '—'}</b></div>
      <Btn kind="danger" onClick={stop} title="Solicita interrupção segura da execução atual">■ Interromper</Btn>
    </header>
  );
}
