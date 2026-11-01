// Supervisão autônoma na interface (Marco B): funções PURAS (sem React, sem rede) testadas a partir de server/test/supervision.test.mjs.
// Só apresenta o que o servidor gravou em cycle.supervision e publicou em /api/state.supervision; nunca decide nem infere nada por conta própria.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const txt = (v, n = 400) => String(v ?? '').slice(0, n);

// Ação do supervisor -> estado já estilizado (classe s-<chave>) + rótulo. Nenhuma ação "conclui": a conclusão continua nos gates do ciclo.
export const ACTION = {
  retry: ['unverified', 'repetir (retentativa)'], replan: ['unverified', 'replanejar com o Planner'], block: ['blocked', 'bloquear'],
  complete: ['completed', 'seguir (a conclusão é decidida pelos gates)'], resume: ['running', 'retomada automática'],
};
export const KIND = {
  comprovada: 'rodada comprovada', verificacao_reprovada: 'verificação real reprovada', arquivo_esperado: 'arquivo esperado não comprovado', execucao_falhou: 'execução falhou', inconclusiva: 'evidência inconclusiva',
  resultado_incerto: 'resultado incerto', execucao_interrompida: 'execução interrompida', politica: 'política negou', permissao_negada: 'permissão negada', integridade: 'testes/configuração alterados',
  verificacao_bloqueada: 'verificação real não pôde rodar', politica_recusada: 'proposta recusada pela política', recusa_repetida: 'proposta equivalente recusada de novo', falha_repetida: 'falha repetida', sem_saida: 'execução sem saída', tempo_esgotado: 'tempo total esgotado', bloqueio_transitorio: 'bloqueio transitório do Planner',
};

export const TREND = { progress: 'progresso verificável (menos verificações reprovadas)', regressed: 'piorou (novas verificações reprovadas)', changed: 'outras verificações reprovadas (trocar não é progresso)', none: 'sem progresso (as mesmas verificações reprovadas)' };
// O que de fato aconteceu com a recomendação (cycle.supervision[].applied): recomendar NÃO é executar.
export const APPLIED = { pending: 'ainda não aplicada', started: 'iniciada', completed: 'concluída', not_applied: 'NÃO aplicada', stopped: 'o ciclo parou' };
const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
/** Texto curto do desfecho da recomendação; null quando não há nada a aplicar ("n/a") ou o servidor não informou. */
export function appliedText(a) {
  if (!isObj(a) || a.state === 'n/a' || !APPLIED[a.state]) return null;
  const parts = [APPLIED[a.state]];
  if (isObj(a.result)) {
    if (a.result.decision) parts.push(`o Planner decidiu: ${txt(a.result.decision, 20)}`);
    if (a.result.execution !== undefined || a.result.evidence !== undefined) parts.push(`rodada ${num(a.round) ?? '?'}: execução ${txt(a.result.execution, 20)}, verificação ${txt(a.result.verification, 20)}, evidência ${txt(a.result.evidence, 20)}`);
  } else if (num(a.round) !== null) parts.push(`rodada ${a.round}`);
  if (a.by) parts.push(`por ${txt(a.by, 40)}`);
  if (a.reason) parts.push(txt(a.reason, 200));
  return parts.join(' · ');
}
/** Orçamento utilizado, em texto curto (só o que o servidor registrou). */
export function budgetText(b) {
  if (!isObj(b)) return null;
  const parts = [];
  if (num(b.retriesMax) > 0) parts.push(`retentativas ${num(b.retriesUsed) ?? '?'}/${b.retriesMax}`);
  if (num(b.autoResumesMax) > 0) parts.push(`retomadas automáticas ${num(b.autoResumes) ?? '?'}/${b.autoResumesMax}`);
  if (num(b.plannerCalls) !== null) parts.push(`consultas ao Planner ${b.plannerCalls}`);
  if (typeof b.activeMinutes === 'number' && b.activeMinutes >= 0) parts.push(`tempo ativo ${b.activeMinutes} min`);
  return parts.length ? parts.join(' · ') : null;
}

/** Histórico de supervisão (cycle.supervision) pronto para exibir, na ordem gravada. Entradas malformadas são ignoradas. */
export function supervisionView(entries) {
  return arr(entries).filter((e) => isObj(e) && typeof e.action === 'string').map((e, i) => {
    const [status, actionLabel] = ACTION[e.action] ?? ['idle', txt(e.action, 30)];
    const kind = isObj(e.observation) ? e.observation.kind : null;
    return {
      key: `${i}-${e.round ?? 'x'}-${e.action}`, round: Number.isInteger(e.round) ? e.round : null, step: e.step ?? null, action: e.action, actionLabel, status,
      observationLabel: kind ? (KIND[kind] ?? txt(kind, 40)) : null, uncertain: !!e.observation?.uncertain, reason: txt(e.reason, 500), signature: e.signature ? txt(e.signature, 20) : null,
      budget: budgetText(e.budget), at: e.at ?? null,
      trend: isObj(e.observation) && TREND[e.observation.trend] ? e.observation.trend : null, trendLabel: isObj(e.observation) ? (TREND[e.observation.trend] ?? null) : null,
      appliedState: isObj(e.applied) ? e.applied.state ?? null : null, appliedLabel: appliedText(e.applied),
    };
  });
}

// ---------- Configurações (painel "Supervisão") ----------
const SOURCE = { env: 'definido pelo ambiente do servidor', settings: 'definido nas configurações', default: 'padrão (desligado)' };
export const MAX_MINUTES_CHOICES = [0, 15, 30, 60, 120, 240, 480, 1440], STALL_MINUTES_CHOICES = [0, 2, 5, 10, 30, 60], AUTO_RESUME_CHOICES = [0, 1, 2];
/** Opções do seletor: a lista fixa mais o valor ATUAL, se for diferente (ex.: definido pelo ambiente), para o controle nunca mostrar um valor que não é o real. */
export const withCurrent = (list, v) => (Number.isInteger(v) && v >= 0 && !list.includes(v) ? [...list, v].sort((a, b) => a - b) : list);
export const minutesLabel = (n) => (n === 0 ? 'desligado (padrão)' : n < 60 ? `${n} min` : n % 60 === 0 ? `${n / 60} h` : `${n} min`);
export const resumeLabel = (n) => (n === 0 ? 'desligada (padrão)' : n === 1 ? '1 retomada por ciclo' : `${n} retomadas por ciclo`);

/** Modelo do painel "Supervisão" a partir de /api/state.supervision. null se o servidor não informou. */
export function supervisionForm(sv, { activeCycle = false } = {}) {
  if (!isObj(sv) || typeof sv.supervisor !== 'boolean' || !Number.isInteger(sv.maxMinutes) || !Number.isInteger(sv.stallMinutes) || !Number.isInteger(sv.autoResumes)) return null;
  const src = isObj(sv.source) ? sv.source : {};
  const ENV = { supervisor: 'ORCH_CYCLE_SUPERVISOR', maxMinutes: 'ORCH_CYCLE_MAX_MINUTES', stallMinutes: 'ORCH_CYCLE_STALL_MINUTES', autoResumes: 'ORCH_CYCLE_AUTO_RESUMES' };
  const field = (key) => {
    const source = ['env', 'settings', 'default'].includes(src[key]) ? src[key] : 'default', locked = source === 'env';
    const reason = locked ? `Definido pela variável de ambiente ${ENV[key]}: para mudar, altere o ambiente do servidor e reinicie.` : activeCycle ? 'Há um ciclo em andamento: aguarde terminar ou cancele para mudar.' : null;
    return { value: sv[key], source, sourceLabel: SOURCE[source], locked, disabled: locked || activeCycle, reason };
  };
  return {
    supervisor: field('supervisor'), maxMinutes: field('maxMinutes'), stallMinutes: field('stallMinutes'), autoResumes: field('autoResumes'),
    maxChoices: withCurrent(MAX_MINUTES_CHOICES, sv.maxMinutes), stallChoices: withCurrent(STALL_MINUTES_CHOICES, sv.stallMinutes), resumeChoices: AUTO_RESUME_CHOICES,
    notes: [
      'A supervisão decide por regras determinísticas e por evidência do sistema, nunca pelo texto do Planner: ela só recomenda e registra; repetir, replanejar e bloquear passam pelos mesmos caminhos e proteções de sempre (política, aprovações, limites, gates de evidência).',
      'Falha repetida (mesma assinatura) bloqueia o ciclo em vez de gastar outra rodada. A duração total e a ausência de saída interrompem a execução; ausência de saída NÃO prova inatividade, então o resultado é tratado como incerto e nada é repetido sozinho.',
      'A retomada automática vale só para falhas transitórias do Planner, sem nenhuma execução ambígua, no máximo duas por ciclo. Não existe rollback automático.',
    ],
  };
}
