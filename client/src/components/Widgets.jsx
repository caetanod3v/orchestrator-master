import React, { useEffect, useRef } from 'react';
import { Status, Btn, DemoTag, Empty, taskBlocked } from './ui.jsx';

export function AgentCard({ agent, compact }) {
  return (
    <div className="agent">
      <div className="row wrap">
        <b className="agent-name">{agent.name}</b>
        <Status value={agent.status} />
      </div>
      {!compact && <p className="dim">{agent.role}</p>}
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
            <Status value={t.status} />
          </li>
        );
      })}
    </ol>
  );
}

// Terminal: mostra somente o log registrado para a tarefa (saída real do processo, quando houve execução).
export function Terminal({ mission, task }) {
  const lines = task?.log || [];
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length, task?.id]);
  return (
    <div className="terminal">
      <div className="term-head">
        <span className="mono">{task ? `tarefa: ${task.title}` : 'sem tarefa selecionada'}</span>
        {mission.demo && <DemoTag title="Logs fictícios de demonstração" />}
        {task?.status === 'running' && <span className="s-running small">● ao vivo</span>}
      </div>
      <pre ref={box}>
        {lines.length === 0
          ? <span className="dim">Sem saída registrada. Nenhum processo foi executado para esta tarefa.</span>
          : lines.map((l, i) => <div key={i} className={/^\[(stderr|erro)/.test(l) ? 's-failed' : ''}><span className="prompt">{String((task.logTotal || lines.length) - lines.length + i + 1).padStart(3, '0')}</span> {l}</div>)}
      </pre>
    </div>
  );
}

const usageText = (u) => [u.costUsd != null && `US$ ${u.costUsd.toFixed(4)}`, u.turns != null && `${u.turns} ${u.turns === 1 ? 'turno' : 'turnos'}`, u.durationMs != null && `${(u.durationMs / 1000).toFixed(1)} s`].filter(Boolean).join(' · ');

/**
 * Revisão e controle da tarefa. As ações exibidas dependem do estado real da tarefa;
 * o servidor revalida tudo (esta tela nunca é a autoridade).
 */
export function ReviewPanel({ mission, task, actions, busy }) {
  if (!task) return <Empty>Selecione uma tarefa na fila.</Empty>;
  const st = task.status;
  const retry = ['failed', 'interrupted'].includes(st) && !task.rejected;
  const canRun = st === 'queued' && task.authorized && !task.blockedReason;
  return (
    <div className="review">
      <div className="row small"><b>{task.title}</b><Status value={st} /></div>
      {task.blockedReason && !mission.demo && st !== 'running' && <p className="dim small">⚠ {task.blockedReason}</p>}
      {task.error && <p className="s-failed small">{task.error}{task.exitCode != null ? ` (código ${task.exitCode})` : ''}</p>}
      <div className="mono small dim">relatório</div>
      <p>{task.report || <span className="dim">Sem relatório (a tarefa não foi executada).</span>}</p>
      {task.usage && <p className="dim small">uso real desta execução: {usageText(task.usage)}</p>}
      <div className="mono small dim">alterações</div>
      {task.files.length === 0 ? <p className="dim">{task.gitRepo === false ? 'Espaço de trabalho sem Git: alterações não verificáveis.' : 'Nenhuma alteração registrada.'}</p> : (
        <ul className="files">
          {task.files.map((f) => (
            <li key={f.path}>
              <span className="mono grow">{f.path}{f.preexisting ? ' (já alterado antes)' : ''}</span>
              {f.added != null ? <><span className="add">+{f.added}</span> <span className="rem">−{f.removed}</span></> : <span className="dim">{f.status === '??' ? 'novo' : f.status}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {(st === 'queued' || retry) && !task.authorized && !mission.demo && <Btn kind="primary" onClick={actions.authorize}>{retry ? '✓ Autorizar nova tentativa' : '✓ Autorizar execução'}</Btn>}
        {st === 'queued' && task.authorized && <Btn kind="primary" disabled={!canRun || busy} onClick={actions.run}>▶ Executar</Btn>}
        {st === 'queued' && task.authorized && <Btn onClick={actions.revoke}>Revogar autorização</Btn>}
        {st === 'running' && <Btn kind="danger" onClick={actions.stop}>■ Interromper execução</Btn>}
        {st === 'awaiting_approval' && <><Btn kind="primary" onClick={actions.approve}>✓ Aprovar resultado</Btn><Btn kind="danger" onClick={actions.reject}>✕ Rejeitar</Btn></>}
      </div>
      {mission.demo && <p className="dim small">Missão demonstrativa: decisões alteram só o estado fictício local; não há execução real.</p>}
    </div>
  );
}
