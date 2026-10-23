// Estado de uma MISSÃO como o usuário o vê. Quando existe ciclo, o estado do ciclo manda;
// as tarefas só decidem quando não há ciclo (fluxo manual) ou depois de um ciclo concluído.
//
// Camadas (não confundir): missão (aqui) | ciclo (mission.cycle.status) | rodada (round.status) | execução (task.status).

/** Estado derivado só das tarefas (fluxo manual). */
export function taskDerivedStatus(tasks) {
  const s = tasks.map((t) => t.status);
  if (!s.length) return 'queued';
  if (s.includes('running')) return 'running';
  if (s.includes('failed')) return 'failed';
  if (s.includes('interrupted')) return 'interrupted';
  if (s.includes('awaiting_approval')) return 'awaiting_approval';
  if (s.every((x) => x === 'completed')) return 'completed';
  return 'queued';
}

export function missionStatus(m) {
  const c = m.cycle;
  if (!c) return taskDerivedStatus(m.tasks);
  if (['planning', 'running'].includes(c.status)) return 'running'; // ciclo ativo
  if (['blocked', 'cancelled', 'limit_reached'].includes(c.status)) return c.status; // nunca "completed"
  // ciclo concluído: falhas intermediárias já foram tratadas pelo Planner; só tarefas MANUAIS ainda pendentes mudam o resultado
  const manual = m.tasks.filter((t) => !t.auto);
  return manual.length && !manual.every((t) => t.status === 'completed') ? taskDerivedStatus(manual) : 'completed';
}
