// Regras puras que decidem se uma tarefa pode ser executada agora. Retorna o motivo do
// bloqueio (pt-BR) ou null. Nada aqui executa processos nem toca o disco.

const cycleActive = (m) => !!m?.cycle && ['planning', 'running'].includes(m.cycle.status);

/**
 * @param {object} p
 * @param {object} p.mission
 * @param {object} p.task
 * @param {object|null} p.workspace   workspace cadastrado da missão (ou null)
 * @param {(path:string)=>{ok:boolean,error?:string}} p.validateDir
 * @param {boolean} p.busy            já existe uma execução ativa
 * @param {boolean|null} p.cliAvailable  null = desconhecido
 */
export function runBlockers({ mission, task, workspace, validateDir, busy, cliAvailable }) {
  if (!mission || !task) return 'Tarefa não encontrada.';
  if (mission.demo) return 'Missão demonstrativa: a execução real está desabilitada.';
  if (cycleActive(mission) && !task.auto) return 'Um ciclo autônomo está ativo nesta missão; aguarde, cancele ou pause o ciclo.';
  if (task.rejected) return 'Tarefa rejeitada por um humano; crie uma nova tarefa para tentar de novo.';
  if (task.status === 'running') return 'Tarefa já está em execução.';
  if (task.status === 'awaiting_approval') return 'O resultado desta tarefa aguarda revisão humana.';
  if (task.status === 'completed') return 'Tarefa já concluída.';
  if (task.status !== 'queued') return 'Autorize uma nova tentativa para executar esta tarefa.';
  if (!task.authorized) return 'Aguardando autorização humana para executar.';
  const pending = task.dependsOn
    .map((id) => mission.tasks.findIndex((t) => t.id === id))
    .filter((i) => i >= 0 && mission.tasks[i].status !== 'completed');
  if (pending.length) return `Dependências pendentes: ${pending.map((i) => String(i + 1).padStart(2, '0')).join(', ')}.`;
  if (!workspace) return 'A missão não tem um workspace cadastrado.';
  const v = validateDir(workspace.path);
  if (!v.ok) return `Workspace inválido: ${v.error}`;
  if (busy) return 'Outra execução está em andamento.';
  if (cliAvailable === false) return 'Claude Code não foi encontrado no PATH.';
  return null;
}

/** Motivo pelo qual NÃO se pode autorizar a execução (separado de runBlockers). */
export function authorizeBlockers({ mission, task }) {
  if (!mission || !task) return 'Tarefa não encontrada.';
  if (mission.demo) return 'Missão demonstrativa: a execução real está desabilitada.';
  if (cycleActive(mission) && !task.auto) return 'Um ciclo autônomo está ativo nesta missão.';
  if (task.rejected) return 'Tarefa rejeitada por um humano.';
  if (!['queued', 'failed', 'interrupted'].includes(task.status)) return 'A tarefa não está em um estado que permita autorizar a execução.';
  return null;
}
