import { Status, Empty, taskBlocked } from './ui.jsx';
import { taskLabel } from '../op-state.js';

export function AgentCard({ agent, compact }) {
  return (
    <div className="agent">
      <div className="row wrap">
        <h3 className="agent-name">{agent.name}</h3>
        <Status value={agent.status} />
      </div>
      {!compact && <p className="agent-role">{agent.role}</p>}
      <p className="dim small">{agent.detail}{agent.version ? ` · ${agent.version}` : ''}</p>
    </div>
  );
}

export function TaskQueue({ mission, selectedId, onSelect }) {
  const tasks = mission.tasks;
  if (!tasks.length) return <Empty>Sem tarefas. Adicione tarefas manualmente em Missões ou inicie um ciclo autônomo, em que o Planner decide as tarefas.</Empty>;
  return (
    <ol className="queue">
      {tasks.map((t, i) => {
        const blocked = t.status === 'queued' && taskBlocked(t, tasks);
        return (
          <li key={t.id} className={selectedId === t.id ? 'sel' : ''} onClick={() => onSelect?.(t.id)}>
            <span className="n">{String(i + 1).padStart(2, '0')}</span>
            <div className="grow">
              <div className="t">{onSelect
                ? <button type="button" className="rowlink" aria-current={selectedId === t.id ? 'true' : undefined}>{t.title}</button> /* o clique sobe até o <li> */
                : t.title}</div>
              {(t.dependsOn.length > 0 || t.authorized) && (
                <div className="dim small">
                  {t.dependsOn.length > 0 && <>depende de: {t.dependsOn.map((d) => String(tasks.findIndex((x) => x.id === d) + 1).padStart(2, '0')).join(', ')}{blocked && ' · bloqueada'}</>}
                  {t.authorized && <b className="s-completed"> · execução autorizada</b>}
                </div>
              )}
            </div>
            <Status value={t.status} label={taskLabel(t)} />
          </li>
        );
      })}
    </ol>
  );
}
