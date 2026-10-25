// Apresentação do Token Monitor (funções puras, sem React): formatação e derivação a partir de /api/state.usage.
// Regra de ouro: valor ausente aparece como "—", nunca como zero inventado. Nada aqui calcula saldo ou limite.

export const DASH = '—';
const nf = new Intl.NumberFormat('pt-BR');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const fmtTokens = (v) => (isNum(v) ? nf.format(v) : DASH);
/** Custo estimado pela CLI (não é cobrança). */
export const fmtCost = (v) => (isNum(v) ? `US$ ${v.toFixed(4)}` : DASH);

/** O backend já envia o agregado novo? (um servidor antigo devolve só { costUsd, runs }) */
export const hasTotals = (usage) => !!usage && typeof usage === 'object' && !!usage.total && typeof usage.total === 'object';

/** Estado dos dados de um grupo de totais: final, provisório, misto ou sem dados. */
export function stateOf(t) {
  if (!t || !t.entries) return { kind: 'none', label: DASH };
  if (!t.provisional) return { kind: 'final', label: 'final' };
  if (!t.final) return { kind: 'provisional', label: 'provisório' };
  return { kind: 'mixed', label: `${t.final} final · ${t.provisional} prov.` };
}

/** Linhas da tabela de totais: geral, Planner e Executor. */
export function totalRows(usage) {
  if (!hasTotals(usage)) return [];
  return [
    { id: 'total', label: 'Total', t: usage.total },
    { id: 'planner', label: 'Planner', t: usage.byAgent?.planner },
    { id: 'executor', label: 'Executor', t: usage.byAgent?.executor },
  ];
}

/** Uso por missão, com o título vindo da lista de missões (cai no id se a missão não estiver carregada). */
export function missionRows(usage, missions = []) {
  if (!hasTotals(usage) || !Array.isArray(usage.byMission)) return [];
  return usage.byMission.map((m) => {
    const found = missions.find((x) => x.id === m.missionId);
    return { id: m.missionId, title: found?.title ?? m.missionId, demo: !!found?.demo, total: m.total, byAgent: m.byAgent };
  });
}

/** Resumo curto para o HUD: entrada e saída; null se nada foi reportado. */
export function hudText(usage) {
  if (!hasTotals(usage) || !usage.total.entries) return null;
  const { input, output } = usage.total;
  if (!isNum(input) && !isNum(output)) return null;
  return `ent ${fmtTokens(input)} · saí ${fmtTokens(output)}`;
}

const LIMIT_STATUS = {
  allowed: { kind: 'ok', label: 'dentro do limite' },
  allowed_warning: { kind: 'warn', label: 'aviso: perto do limite' },
  rejected: { kind: 'bad', label: 'limite atingido' },
};

/** Horário informado pela CLI (epoch em segundos; valores muito grandes são tratados como milissegundos). */
export function fmtReset(v) {
  if (!isNum(v)) return DASH;
  const d = new Date(v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Indicador de limite da CLI (separado do consumo; NÃO é saldo). `utilization` é mostrado como veio, sem assumir unidade. */
export function limitView(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const s = typeof rl.status === 'string' ? (LIMIT_STATUS[rl.status] ?? { kind: 'unknown', label: 'status não reconhecido' }) : { kind: 'unknown', label: DASH };
  return { kind: s.kind, status: s.label, utilization: isNum(rl.utilization) ? String(rl.utilization) : DASH, resetsAt: fmtReset(rl.resetsAt), agent: rl.agent === 'planner' ? 'Planner' : rl.agent === 'executor' ? 'Executor' : DASH };
}
