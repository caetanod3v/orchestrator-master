// Roteamento de modelo/esforço do Planner (incremento A: só a infraestrutura e a rastreabilidade; NENHUMA escolha dinâmica ainda).
//
// Camadas do Planner:
//   lite     claude-haiku-5-5, esforço low
//   standard o que já existe: ORCH_PLANNER_MODEL / ORCH_PLANNER_EFFORT (vazios = padrão da CLI)
// O roteamento fica DESLIGADO por padrão (ORCH_PLANNER_ROUTING=off): sem ele nada deste módulo é usado e o comportamento é o de sempre.
// O roteador só decide QUEM responde; nunca o que é aceito (validação, regras de conclusão e verificações continuam no cycle.js).

export const TIERS = Object.freeze({ lite: Object.freeze({ model: 'claude-haiku-5-5', effort: 'low' }) });
export const TIER_NAMES = Object.freeze(['lite', 'standard']);

/** ORCH_PLANNER_ROUTING: vazio/off = desligado (padrão); on = ligado. Qualquer outro valor lança Error (o servidor não sobe). */
export function routingFromEnv(env = process.env) {
  const v = (env.ORCH_PLANNER_ROUTING ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'on') return 'on';
  throw new Error('ORCH_PLANNER_ROUTING inválido: use off ou on.');
}

/** { model, effort } de uma camada (`standard` = a configuração existente do ambiente); null se a camada não existe. */
export function tierSettings(tier, standard = {}) {
  if (tier === 'standard') return { model: standard.model, effort: standard.effort };
  return Object.hasOwn(TIERS, tier) ? { ...TIERS[tier] } : null;
}

/**
 * Roteador do incremento A: SEMPRE a camada padrão, só para que a rota (camada, modelo e esforço solicitados, motivo e sinais) fique registrada em
 * cada chamada. A seleção por sinais e o escalonamento são incrementos futuros.
 */
export function createRouter() {
  return {
    pick: () => ({ tier: 'standard', reason: 'roteamento ligado (incremento A): ainda não há seleção dinâmica; toda consulta usa a camada padrão', signals: {} }),
  };
}
