// Plano persistido de múltiplas etapas (M4), executado de forma SEQUENCIAL: uma etapa por vez, sem paralelismo e sem scheduler.
//
// O plano vive em `mission.cycle.plan` (mesmo banco, mesma gravação do ciclo; nada de segundo sistema de persistência):
//   { id, createdAt, rationale, steps: [{ id, title, instructions, acceptance, dependsOn, agent?, status, round, taskId }] }
// A DEFINIÇÃO das etapas (id, título, instruções, critérios, dependências, agente) vem do Planner e é validada por validatePlanSteps (cycle-schema.js).
// O ESTADO de cada etapa (status, round, taskId) é DERIVADO das rodadas gravadas (`round.planId` + `round.stepId`): é uma cópia gravada por
// syncPlan() a cada emit() do ciclo, nunca uma segunda fonte de verdade. Por isso uma etapa concluída não se repete por causa de um reinício:
// o que decide é a rodada gravada, e uma etapa só é elegível enquanto não tem rodada.
//
// Estados (o vocabulário das tarefas, sem estados novos):
//   queued      : sem rodada ainda (elegível só se todas as dependências estiverem completed)
//   running     : rodada em andamento (execução ou verificação real ainda não terminou)
//   completed   : a execução teve sucesso E as verificações reais passaram (ou não há verificações configuradas)
//   failed      : a execução falhou, ou a verificação real falhou/foi bloqueada/não rodou: o Planner decide o que fazer
//   interrupted : a execução foi interrompida (cancelamento, queda do servidor); NUNCA é refeita automaticamente
import { roundVerification } from './cycle.js';
import { validatePlanSteps } from './cycle-schema.js';

export const PLAN_ENV = 'ORCH_CYCLE_PLAN';

/** ORCH_CYCLE_PLAN: `on` liga a decisão "plan" do Planner; ausente, vazio ou `off` = desligado (fluxo de sempre). Qualquer outro valor lança Error. */
export function planModeFromEnv(env = process.env) {
  const v = String(env[PLAN_ENV] ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return false;
  if (v === 'on') return true;
  throw new Error(`${PLAN_ENV} inválido: use "on" para permitir planos de várias etapas, ou "off" (ou vazio) para desativar.`);
}

const steps = (c) => (Array.isArray(c?.plan?.steps) ? c.plan.steps.filter((s) => s && typeof s === 'object') : []);
const roundsOf = (c, stepId, planId = c.plan?.id) => (Array.isArray(c.rounds) ? c.rounds : []).filter((r) => r?.planId === planId && r.stepId === stepId);

/** Estado de UMA etapa a partir da rodada que a executou (undefined = ainda não houve rodada). */
export function stepStatusFromRound(round) {
  if (!round) return 'queued';
  if (round.status === 'running') return 'running';
  if (round.status === 'failed') return 'failed';
  if (round.status === 'interrupted') return 'interrupted';
  if (round.status !== 'succeeded') return 'failed'; // valor desconhecido: nunca vale como concluída
  if (round.verification === undefined && round.phase !== 'done') return 'running'; // a execução terminou, mas o resultado das verificações reais ainda não foi fechado
  const v = roundVerification(round);
  return v === 'passed' || v === 'none' ? 'completed' : 'failed';
}

/** Atualiza (idempotente) status/round/taskId de cada etapa do plano a partir das rodadas. Chamada a cada emit() do ciclo, antes de gravar. */
export function syncPlan(c, plan = c?.plan) {
  if (!Array.isArray(plan?.steps)) return;
  for (const s of plan.steps) {
    if (!s || typeof s !== 'object') continue;
    const r = roundsOf(c, s.id, plan.id).at(-1);
    s.status = stepStatusFromRound(r); s.round = r?.n ?? null; s.taskId = r?.taskId ?? null;
  }
}

/** Etapas elegíveis agora: sem rodada e com todas as dependências concluídas (na ordem do plano); nenhuma se alguma etapa falhou ou foi interrompida. */
export function eligibleSteps(c) {
  syncPlan(c);
  if (steps(c).some((s) => s.status === 'failed' || s.status === 'interrupted')) return []; // etapa não concluída: nada mais roda sozinho; o Planner decide
  const done = new Set(steps(c).filter((s) => s.status === 'completed').map((s) => s.id));
  return steps(c).filter((s) => s.status === 'queued' && (s.dependsOn || []).every((d) => done.has(d)));
}
/** A próxima (única) etapa a executar: execução sequencial, a primeira elegível na ordem do plano. */
export const nextStep = (c) => eligibleSteps(c)[0] ?? null;

/** Etapas do plano que ainda não estão concluídas. */
export const openSteps = (c) => { syncPlan(c); return steps(c).filter((s) => s.status !== 'completed'); };

/**
 * Integridade do plano gravado (um banco editado à mão ou corrompido não pode virar execução): estrutura válida, rodadas que apontam para etapas
 * existentes, no máximo uma rodada por etapa e nenhuma etapa executada antes de suas dependências estarem concluídas. Devolve o motivo ou null.
 */
export function planProblem(c) {
  if (c?.plan === undefined || c.plan === null) return null;
  const p = c.plan;
  if (typeof p !== 'object' || Array.isArray(p) || typeof p.id !== 'string' || !Array.isArray(p.steps)) return 'o plano gravado não tem a estrutura esperada';
  const v = validatePlanSteps(p.steps.map(({ status, round, taskId, ...def }) => def));
  if (!v.ok) return `o plano gravado é inválido: ${v.error}`;
  syncPlan(c);
  const byId = new Map(p.steps.map((s) => [s.id, s]));
  const own = (Array.isArray(c.rounds) ? c.rounds : []).filter((r) => r?.planId === p.id);
  const seen = new Set();
  for (const r of own) {
    const s = byId.get(r.stepId);
    if (!s) return `a rodada ${r.n} aponta para a etapa "${r.stepId}", que não existe no plano`;
    if (seen.has(s.id)) return `a etapa "${s.id}" tem mais de uma rodada (uma etapa só pode ser executada uma vez)`;
    seen.add(s.id);
    for (const d of s.dependsOn) {
      const dep = byId.get(d);
      if (dep.status !== 'completed' || !(dep.round < r.n)) return `a etapa "${s.id}" (rodada ${r.n}) foi executada sem a dependência "${d}" concluída`;
    }
  }
  return null;
}

/** Contexto das dependências para o Executor: ids das TAREFAS das etapas das quais esta depende (o prompt do Executor já cita o relatório delas). */
export const dependencyTaskIds = (c, step) => (step.dependsOn || []).map((id) => steps(c).find((s) => s.id === id)?.taskId).filter(Boolean);

/** Resumo do progresso para o prompt do Planner e a atividade. */
export function planProgress(c) {
  syncPlan(c);
  const all = steps(c);
  return { total: all.length, completed: all.filter((s) => s.status === 'completed').length, current: all.find((s) => s.status === 'running')?.id ?? null };
}
