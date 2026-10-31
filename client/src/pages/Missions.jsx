import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel, Btn, Status, DemoTag, TaskSegments, Empty, Icon, fmtTime } from '../components/ui.jsx';
import { TaskQueue } from '../components/Widgets.jsx';
import CyclePanel from '../components/CyclePanel.jsx';

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
  // Remover desmonta a linha que tinha o foco: depois que ela sai da lista, o foco vai para a missão vizinha (ou para o formulário de nova missão).
  const newTitle = useRef(null);
  const afterRemove = useRef(null);
  useEffect(() => {
    const p = afterRemove.current;
    if (!p || missions.some((x) => x.id === p.removedId)) return;
    afterRemove.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    (document.querySelector(`[data-mission-id="${p.nextId}"]`) || newTitle.current)?.focus();
  }, [missions]);
  const remove = (m) => {
    if (!confirm(`Remover a missão "${m.title}"?`)) return;
    const i = missions.findIndex((x) => x.id === m.id);
    afterRemove.current = { removedId: m.id, nextId: (missions[i + 1] || missions[i - 1])?.id };
    act(() => api.del(`/api/missions/${m.id}`));
  };
  // A linha inteira seleciona (mouse); o botão do título recebe o foco do teclado e seu clique sobe até a linha.
  const wsName = (id) => workspaces.find((w) => w.id === id)?.name || 'sem espaço de trabalho';

  return (
    <div className="two split">
      <div className="col">
        <Panel title="Nova missão">
          <form onSubmit={create} className="form">
            <label>Título<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required autoFocus={location.hash.includes('new')} ref={newTitle} /></label>
            <label>Objetivo<textarea rows={3} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></label>
            <div className="dim small">Espaço de trabalho: {state?.activeWorkspace?.name || 'nenhum ativo (cadastre em Espaços de trabalho)'}</div>
            <Btn kind="primary" type="submit">Criar missão</Btn>
          </form>
        </Panel>
        <Panel title={`Missões (${missions.length})`}>
          {missions.length === 0 && <Empty>Nenhuma missão.</Empty>}
          <table className="tbl">
            <tbody>
              {missions.map((m) => (
                <tr key={m.id} className={`click${mission?.id === m.id ? ' sel' : ''}`} onClick={() => selectMission(m.id)}>
                  <td><div><button type="button" className="rowlink" data-mission-id={m.id} aria-current={mission?.id === m.id ? 'true' : undefined}>{m.title}</button> {m.demo && <DemoTag />}</div><div className="m-meta"><Status value={m.status} /><span className="dim small">{wsName(m.workspaceId)} · {fmtTime(m.createdAt)}</span></div></td>
                  <td><button type="button" className="icon-btn" onClick={(e) => { e.stopPropagation(); remove(m); }} title="Remover missão" aria-label={`Remover missão ${m.title}`}><Icon name="close" size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <div className="col">
        {mission ? (
          <Panel title={mission.title} demo={mission.demo} right={<Status value={mission.status} />}>
            {mission.objective && <p className="m-obj">{mission.objective}</p>}
            {mission.tasks.length > 0 && <div className="m-prog"><TaskSegments tasks={mission.tasks} /><span className="dim small">{mission.tasks.filter((t) => t.status === 'completed').length} de {mission.tasks.length} concluídas</span></div>}
            <CyclePanel mission={mission} />
            <h4 className="sec-h">Tarefas</h4>
            <TaskQueue mission={mission} />
            <form onSubmit={addTask} className="form inline">
              <input placeholder="Nova tarefa (manual)" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} maxLength={200} required />
              <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Dependência da nova tarefa">
                <option value="">sem dependência</option>
                {mission.tasks.map((t, i) => <option key={t.id} value={t.id}>depende de {String(i + 1).padStart(2, '0')}</option>)}
              </select>
              <Btn type="submit">Adicionar</Btn>
            </form>
            <div className="actions"><a className="btn" href="#/cockpit">Abrir no Cockpit <Icon name="arrowRight" size={15} /></a></div>
          </Panel>
        ) : <Empty>Selecione ou crie uma missão.</Empty>}
      </div>
    </div>
  );
}
