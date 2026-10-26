import React from 'react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Status, Btn } from './ui.jsx';

export default function Topbar() {
  const { state, mission, act, notify } = useStore();
  const c = state?.counts;
  const live = state?.system === 'running'; // só destaca o botão enquanto algo está em execução (o botão continua sempre habilitado)
  const stop = () =>
    act(async () => {
      const r = await api.post('/api/execution/stop');
      notify(r.detail);
    });
  return (
    <header className="topbar">
      <div className="ctx">
        <div className="crumb"><span className="k">missão</span> <b>{mission ? mission.title : '—'}</b></div>
        <span className="sep" aria-hidden="true" />
        <div className="crumb"><span className="k">espaço de trabalho</span> <b>{state?.activeWorkspace?.name || 'nenhum'}</b></div>
      </div>
      <div className="stats">
        <div className="kpi"><span className="k">sistema</span> {state ? <Status value={state.system} /> : '…'}</div>
        <div className="kpi"><span className="k">agentes ativos</span> <b>{c ? c.activeAgents : '—'}</b></div>
        <div className="kpi"><span className="k">pendentes</span> <b>{c ? c.pending : '—'}</b></div>
        <Btn kind={live ? 'danger live' : 'danger'} onClick={stop} title="Solicita interrupção segura da execução atual">■ Interromper</Btn>
      </div>
    </header>
  );
}
