// Limites por ciclo (incremento D): máximo de chamadas ao Planner e orçamento de custo ESTIMADO. Independentes de ORCH_PLANNER_ROUTING.
//
//   ORCH_CYCLE_MAX_PLANNER_CALLS         inteiro de 1 a 1000: máximo de INVOCAÇÕES do Planner (CLI) por ciclo, cumulativo entre retomadas
//                                        (cada nova tentativa após resposta inválida conta; rodadas e chamadas do Executor não).
//   ORCH_CYCLE_MAX_ESTIMATED_COST_USD    decimal > 0 (até 6 casas, máx. 100000): custo máximo ESTIMADO do ciclo, em dólares.
//   vazio, ausente ou `off`              limite desativado (padrão: o comportamento é o de antes). Qualquer outro valor lança Error (o servidor não sobe).
//
// O custo é a ESTIMATIVA que a CLI reporta (total_cost_usd do evento result), lida dos registros que o Token Monitor já grava
// (cycle.plannerUsage e task.tokenUsage das rodadas): nada é medido de novo nem contado duas vezes. NÃO é cobrança real nem um teto garantido:
// a verificação ocorre ANTES de cada nova chamada (Planner ou Executor), então a última chamada permitida pode ultrapassar o limite.
// Chamada iniciada cujo custo a CLI não reportou (morta, cancelada, sem `result`) tem custo DESCONHECIDO: nunca vira zero. Com o orçamento
// ativo, isso impede novas chamadas (não dá para afirmar que o orçamento está sendo respeitado).
import { entryOf } from './usage.js';

export const LIMIT_ENV = Object.freeze({ calls: 'ORCH_CYCLE_MAX_PLANNER_CALLS', cost: 'ORCH_CYCLE_MAX_ESTIMATED_COST_USD' });
export const LIMIT_BOUNDS = Object.freeze({ maxCalls: 1000, maxCostUsd: 100000 });
const EPS = 1e-9;

/** Lê e valida os limites do ambiente. null = desativado. Lança Error se o valor for inválido. */
export function cycleLimitsFromEnv(env = process.env) {
  const read = (name) => { const v = String(env[name] ?? '').trim(); return v === '' || v.toLowerCase() === 'off' ? null : v; };
  const calls = read(LIMIT_ENV.calls), cost = read(LIMIT_ENV.cost);
  if (calls !== null && (!/^\d{1,4}$/.test(calls) || Number(calls) < 1 || Number(calls) > LIMIT_BOUNDS.maxCalls)) {
    throw new Error(`${LIMIT_ENV.calls} inválido: use um inteiro de 1 a ${LIMIT_BOUNDS.maxCalls}, ou "off" (ou vazio) para desativar.`);
  }
  if (cost !== null && (!/^\d{1,6}(\.\d{1,6})?$/.test(cost) || !(Number(cost) > 0) || Number(cost) > LIMIT_BOUNDS.maxCostUsd)) {
    throw new Error(`${LIMIT_ENV.cost} inválido: use um número em dólares maior que 0 e até ${LIMIT_BOUNDS.maxCostUsd} (ex.: 2.50), ou "off" (ou vazio) para desativar.`);
  }
  return { maxPlannerCalls: calls === null ? null : Number(calls), maxEstimatedCostUsd: cost === null ? null : Number(cost) };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const costOf = (rec) => { const e = entryOf(rec); return e && e.costUsd !== null ? e.costUsd : null; }; // só o `final` traz custo; o `live` nunca vira custo

/**
 * Gasto ESTIMADO conhecido do ciclo atual e quantas chamadas já iniciadas não têm custo reportado.
 * Planner: uma entrada por chamada (cycle.plannerUsage; duplicatas da mesma chamada contam uma vez); desconhecidas = chamadas feitas - chamadas com custo.
 * Executor: cada rodada cuja tarefa chegou a iniciar o processo (startedAt) conta uma vez, pelo task.tokenUsage (o task.usage legado é a mesma execução e NÃO é somado).
 */
export function cycleSpend(m) {
  const c = m?.cycle ?? {}, seen = new Set();
  let knownUsd = 0, plannerCosted = 0, executorUnknown = 0, executorCalls = 0;
  (Array.isArray(c.plannerUsage) ? c.plannerUsage : []).forEach((p, i) => {
    if (!isObj(p)) return;
    const key = p.call ?? `i${i}`; if (seen.has(key)) return; seen.add(key);
    const v = costOf(p); if (v !== null) { knownUsd += v; plannerCosted++; }
  });
  for (const r of Array.isArray(c.rounds) ? c.rounds : []) {
    const t = (Array.isArray(m.tasks) ? m.tasks : []).find((x) => x.id === r?.taskId);
    if (!t?.startedAt) continue; // a execução nunca iniciou o processo: não houve chamada
    executorCalls++;
    const v = costOf(t.tokenUsage); if (v !== null) knownUsd += v; else executorUnknown++;
  }
  const plannerCalls = Number.isInteger(c.plannerCalls) ? c.plannerCalls : 0;
  return { knownUsd, plannerCalls, plannerUnknown: Math.max(0, plannerCalls - plannerCosted), executorCalls, executorUnknown };
}

const usd = (n) => `US$ ${Number(n.toFixed(6))}`;

/**
 * Verifica, ANTES de iniciar uma chamada de LLM (kind: 'planner' | 'executor'), se algum limite impede. Sem limites ativos: sempre null.
 * @returns {{code:'planner_call_cap'|'cost_budget_reached'|'cost_budget_unknown', reason:string}|null}
 */
export function limitProblem(limits, m, kind) {
  const cap = limits?.maxPlannerCalls ?? null, max = limits?.maxEstimatedCostUsd ?? null;
  if (cap === null && max === null) return null;
  if (kind === 'planner' && cap !== null) {
    const n = Number.isInteger(m?.cycle?.plannerCalls) ? m.cycle.plannerCalls : 0;
    if (n >= cap) return { code: 'planner_call_cap', reason: `Limite de ${cap} chamada(s) ao Planner por ciclo (${LIMIT_ENV.calls}) atingido: ${n} já feita(s). Nenhuma nova chamada foi iniciada.` };
  }
  if (max !== null) {
    const s = cycleSpend(m);
    if (s.knownUsd + EPS >= max) {
      return { code: 'cost_budget_reached', reason: `Orçamento ESTIMADO de ${usd(max)} por ciclo (${LIMIT_ENV.cost}) atingido: custo estimado conhecido ${usd(s.knownUsd)}. É uma estimativa da CLI, não a cobrança real nem um teto garantido. Nenhuma nova chamada foi iniciada.` };
    }
    const unknown = s.plannerUnknown + s.executorUnknown;
    if (unknown > 0) {
      return { code: 'cost_budget_unknown', reason: `Não é possível verificar o orçamento ESTIMADO de ${usd(max)} por ciclo (${LIMIT_ENV.cost}): ${unknown} chamada(s) já iniciada(s) sem custo estimado reportado pela CLI (Planner: ${s.plannerUnknown}, Executor: ${s.executorUnknown}); custo estimado conhecido ${usd(s.knownUsd)}. Por segurança, nenhuma nova chamada foi iniciada.` };
    }
  }
  return null;
}
