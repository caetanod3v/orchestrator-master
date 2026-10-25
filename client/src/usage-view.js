// Tokens exibidos dentro da caixa de cada agente do Cockpit (funções puras, sem React).
// Regra de ouro: valor ausente aparece como "—", nunca como zero inventado. Nada aqui estima, nem calcula saldo ou limite.

export const DASH = '—';
const nf = new Intl.NumberFormat('pt-BR');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const FIELDS = ['input', 'output', 'cacheCreation', 'cacheRead'];

export const fmtTokens = (v) => (isNum(v) ? nf.format(v) : DASH);

/** O backend já envia o agregado novo? (um servidor antigo devolve só { costUsd, runs }) */
export const hasTotals = (usage) => !!usage && typeof usage === 'object' && !!usage.total && typeof usage.total === 'object';

/**
 * Tokens de um agente ('planner' | 'executor') na missão indicada, a partir de /api/state.usage.byMission (o servidor já deduplica:
 * o total final de uma execução substitui o provisório, e cada chamada do Planner conta uma vez). O número é a soma do que a CLI reportou
 * (entrada + saída + cache de criação + cache de leitura); campos não reportados ficam de fora e, sem nenhum, o texto é "—".
 * `partial`: há consumo ainda provisório (execução em andamento ou encerrada sem o resultado final).
 * @returns {{text:string, partial:boolean}}
 */
export function agentTokens(usage, missionId, agent) {
  const none = { text: DASH, partial: false };
  if (!hasTotals(usage) || !Array.isArray(usage.byMission) || missionId == null) return none;
  const t = usage.byMission.find((m) => m.missionId === missionId)?.byAgent?.[agent];
  if (!t || !t.entries) return none;
  const known = FIELDS.map((f) => t[f]).filter(isNum);
  if (!known.length) return none;
  return { text: fmtTokens(known.reduce((a, b) => a + b, 0)), partial: isNum(t.provisional) && t.provisional > 0 };
}
