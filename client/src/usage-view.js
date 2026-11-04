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

// ---- Terminais interativos (panes do Cockpit) ----
// `usage` de cada pane vem de /api/terminals (lido do transcript do Claude Code): { input, output, cacheWrite, cacheRead, total, turns, model, costUsd|null } ou null.
// Custo ausente (sem tabela de preços) é "—", nunca US$ 0.

const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const fmtUsd = (v) => (isNum(v) ? usd.format(v) : DASH);

/** Texto do pane: { tokens, cost, title } (title = detalhamento para o tooltip). */
export function paneUsage(usage) {
  if (!usage || !isNum(usage.total)) return { tokens: DASH, cost: DASH, title: 'Sem consumo registrado ainda (o arquivo da sessão aparece depois da primeira resposta).' };
  const title = `Entrada ${fmtTokens(usage.input)} · saída ${fmtTokens(usage.output)} · cache gravado ${fmtTokens(usage.cacheWrite)} · cache lido ${fmtTokens(usage.cacheRead)} · ${usage.turns} ${usage.turns === 1 ? 'resposta' : 'respostas'}${usage.model ? ` · ${usage.model}` : ''}`;
  return { tokens: fmtTokens(usage.total), cost: fmtUsd(usage.costUsd), title };
}

/**
 * Total do squad (todos os panes listados). Tokens: soma dos panes que já têm consumo. Custo: só quando TODOS os panes com consumo têm custo conhecido;
 * senão é "—" (`partialCost` diz que há custo conhecido em parte dos panes, sem somar como se fosse o total).
 */
export function squadUsage(sessions) {
  const withUsage = (Array.isArray(sessions) ? sessions : []).map((s) => s?.usage).filter((u) => u && isNum(u.total));
  if (!withUsage.length) return { tokens: DASH, cost: DASH, panes: 0, partialCost: false };
  const known = withUsage.filter((u) => isNum(u.costUsd));
  return { tokens: fmtTokens(withUsage.reduce((a, u) => a + u.total, 0)), cost: known.length === withUsage.length ? fmtUsd(known.reduce((a, u) => a + u.costUsd, 0)) : DASH, panes: withUsage.length, partialCost: known.length > 0 && known.length < withUsage.length };
}
