// Configuração de orquestração na interface (Marco A, I4): funções PURAS (sem React, sem rede) testadas a partir de server/test/orchestration-config.test.mjs.
// Só apresenta o que o servidor informa em /api/state.orchestration (valores EFETIVOS e a origem de cada um) e nunca decide por conta própria: quem valida e recusa é o servidor.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const SOURCE_LABEL = { env: 'definido pelo ambiente do servidor', settings: 'definido nas configurações', default: 'padrão (desligado)' };
export const RETRY_CHOICES = [0, 1, 2];
export const retryChoiceLabel = (n) => (n === 0 ? '0 — desligadas (padrão)' : n === 1 ? '1 retentativa por ciclo' : `${n} retentativas por ciclo`);

/** "tentativa k de N" — k é a posição da rodada entre as rodadas da MESMA etapa; a rodada (n) continua sendo a do ciclo. */
export const attemptLabel = (k, max = 3) => `tentativa ${k} de ${Number.isInteger(max) && max > 0 ? max : 3}`;

/**
 * Para cada rodada do ciclo que pertence a uma etapa de plano: { stepId, attempt, total }. `attempt` = posição entre as rodadas de mesmo planId+stepId; `total` = quantas rodadas a etapa tem.
 * Rodadas avulsas (sem planId/stepId) não aparecem. Resultado indexado pelo número da rodada (n).
 */
export function roundAttempts(rounds) {
  const seen = new Map(), totals = new Map(), out = {};
  const list = (Array.isArray(rounds) ? rounds : []).filter((r) => isObj(r) && r.planId != null && r.stepId != null && Number.isInteger(r.n));
  for (const r of list) { const k = `${r.planId}\u0000${r.stepId}`; totals.set(k, (totals.get(k) ?? 0) + 1); }
  for (const r of list) { const k = `${r.planId}\u0000${r.stepId}`, a = (seen.get(k) ?? 0) + 1; seen.set(k, a); out[r.n] = { stepId: r.stepId, attempt: a, total: totals.get(k) }; }
  return out;
}

/** Quantas rodadas a etapa já teve no plano atual (0 = nunca executada). */
export function stepAttempts(plan, rounds, stepId) {
  if (!isObj(plan)) return 0;
  return (Array.isArray(rounds) ? rounds : []).filter((r) => isObj(r) && r.planId === plan.id && r.stepId === stepId).length;
}

/** Há ciclo em andamento em alguma missão? O servidor recusa (409) mudanças de orquestração nesse caso; a interface já desabilita os controles. */
export const hasActiveCycle = (missions) => (Array.isArray(missions) ? missions : []).some((m) => ['planning', 'running'].includes(m?.cycle?.status));

/** Retentativas configuradas, mas sem efeito: elas só valem para etapas de um plano, e o plano em várias etapas está desligado. */
export const retriesWithoutPlan = (o) => isObj(o) && o.planMode === false && Number.isInteger(o.stepRetries) && o.stepRetries > 0;

/**
 * Modelo do painel "Orquestração" a partir de /api/state.orchestration. null se o servidor não informou (nada é inventado).
 * Cada campo: valor efetivo, origem, se está travado pelo ambiente, se o controle fica desabilitado e por quê.
 */
export function orchestrationForm(o, { activeCycle = false } = {}) {
  if (!isObj(o) || typeof o.planMode !== 'boolean' || !Number.isInteger(o.stepRetries)) return null;
  const src = isObj(o.source) ? o.source : {};
  const field = (key, value, envName) => {
    const source = ['env', 'settings', 'default'].includes(src[key]) ? src[key] : 'default', locked = source === 'env';
    const reason = locked ? `Definido pela variável de ambiente ${envName}: para mudar, altere o ambiente do servidor e reinicie.` : activeCycle ? 'Há um ciclo em andamento: aguarde terminar ou cancele para mudar.' : null;
    return { value, source, sourceLabel: SOURCE_LABEL[source], locked, disabled: locked || activeCycle, reason };
  };
  const warnings = [];
  if (retriesWithoutPlan(o)) warnings.push('As retentativas só valem para etapas de um plano. Com o plano em várias etapas desligado, elas não têm efeito: o Planner continua decidindo uma tarefa por vez.');
  return {
    planMode: field('planMode', o.planMode, 'ORCH_CYCLE_PLAN'),
    stepRetries: field('stepRetries', o.stepRetries, 'ORCH_CYCLE_MAX_STEP_RETRIES'),
    warnings,
    notes: [
      'Cada retentativa é uma nova execução do Executor e uma nova rodada do ciclo: consome tempo, chamadas e custo adicionais, e só é feita quando a falha é de uma classe recuperável (verificação real reprovada ou arquivo esperado não comprovado).',
      'Não existe rollback automático: a tentativa seguinte edita o mesmo workspace e pode sobrescrever o que a anterior fez. A garantia vem da verificação real refeita, não de desfazer alterações.',
      'A mudança vale para as próximas mensagens do chat e para os próximos ciclos ou retomadas; um ciclo em andamento não é alterado (por isso a mudança é recusada enquanto houver um).',
    ],
    maxStepAttempts: Number.isInteger(o.maxStepAttempts) ? o.maxStepAttempts : 3,
  };
}
