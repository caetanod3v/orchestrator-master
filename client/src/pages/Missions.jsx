import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel, Btn, Status, DemoTag, Progress, Empty, fmtTime } from '../components/ui.jsx';
import { TaskQueue } from '../components/Widgets.jsx';

export default function Missions() {
  const { missions, mission, selectMission, workspaces, state, act } = useStore();
  const [form, setForm] = useState({ title: '', objective: '' });
  const [taskTitle, setTaskTitle] = useState('');
  const [dep, setDep] = useState('');

  const create = async (e) => {
    e.preventDefault();
    const m = await act(() => api.post('/api/missions', { ...form, workspaceId: state?.activeWorkspace?.id }));
    if (m) { setForm({ title: '', objective: '' }); selectMission(m.id); }
  };
  const addTask = async (e) => {
    e.preventDefault();
    await act(() => api.post(`/api/missions/${mission.id}/tasks`, { title: taskTitle, dependsOn: dep ? [dep] : [] }));
    setTaskTitle(''); setDep('');
  };
  const remove = (m) => confirm(`Remover a missão "${m.title}"?`) && act(() => api.del(`/api/missions/${m.id}`));
  const wsName = (id) => workspaces.find((w) => w.id === id)?.name || 'sem workspace';

  return (
    <div className="two">
      <div className="col">
        <Panel title="Nova missão">
          <form onSubmit={create} className="form">
            <label>Título<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required autoFocus={location.hash.includes('new')} /></label>
            <label>Objetivo<textarea rows={3} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></label>
            <div className="dim small">Workspace: {state?.activeWorkspace?.name || 'nenhum ativo (cadastre em Workspaces)'}</div>
            <Btn kind="primary" type="submit">Criar missão</Btn>
          </form>
        </Panel>
        <Panel title={`Missões (${missions.length})`}>
          {missions.length === 0 && <Empty>Nenhuma missão.</Empty>}
          <table className="tbl">
            <tbody>
              {missions.map((m) => (
                <tr key={m.id} style={{ cursor: 'pointer' }} className={mission?.id === m.id ? 'sel' : ''} onClick={() => selectMission(m.id)}>
                  <td><div>{m.title} {m.demo && <DemoTag />}</div><div className="dim small">{wsName(m.workspaceId)} · {fmtTime(m.createdAt)}</div></td>
                  <td><Status value={m.status} /></td>
                  <td><Btn onClick={(e) => { e.stopPropagation(); remove(m); }} title="Remover missão">✕</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <div className="col">
        {mission ? (
          <Panel title={`Detalhe: ${mission.title}`} demo={mission.demo}>
            {mission.objective && <p>{mission.objective}</p>}
            <Progress done={mission.tasks.filter((t) => t.status === 'completed').length} total={mission.tasks.length} />
            <div style={{ height: 10 }} />
            <TaskQueue mission={mission} />
            <form onSubmit={addTask} className="form inline">
              <input placeholder="Nova tarefa (manual)" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} maxLength={200} required />
              <select value={dep} onChange={(e) => setDep(e.target.value)}>
                <option value="">sem dependência</option>
                {mission.tasks.map((t, i) => <option key={t.id} value={t.id}>depende de {String(i + 1).padStart(2, '0')}</option>)}
              </select>
              <Btn type="submit">Adicionar</Btn>
            </form>
            <a className="btn" href="#/cockpit">Abrir no Cockpit →</a>
          </Panel>
        ) : <Empty>Selecione ou crie uma missão.</Empty>}
      </div>
    </div>
  );
}
