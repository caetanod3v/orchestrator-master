// Relatório de entrega na interface (Marco A, I2): funções PURAS (sem React, sem rede) testadas a partir de server/test/delivery-view.test.mjs.
// Só apresenta o que o servidor entregou em GET /api/missions/:id/delivery (server/delivery.js). Regras de honestidade:
//  - ausência de dado nunca vira sucesso: sem `assurance` reconhecida o nível mostrado é "não comprovada"; só state.code === 'completed' é "concluída";
//  - campo ausente (servidor mais antigo) é "não informado", nunca zero;
//  - uma resposta atrasada de outra missão nunca sobrescreve a da missão atual (createDeliveryLoader).
import { statusLabel } from './labels.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v, n = 600) => String(v ?? '').slice(0, n);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// Resultado do ciclo (state.code do servidor) -> chave de estado já estilizada (classe s-<chave>) + rótulo.
const CODE = {
  completed: ['completed', 'Concluída'], blocked: ['blocked', 'Bloqueada: aguarda uma decisão'], cancelled: ['cancelled', 'Cancelada'], limit_reached: ['limit_reached', 'Parada no limite de rodadas'],
  in_progress: ['running', 'Em andamento'], no_cycle: ['idle', 'Sem ciclo autônomo'], demo: ['idle', 'Missão demonstrativa'], unknown: ['failed', 'Estado não reconhecido'],
};
// Garantia sustentada pelos registros (assurance.level). Qualquer outro valor é tratado como NÃO comprovada.
const ASSURANCE = {
  verified: ['verified', 'Comprovada pelo sistema'], unverified: ['unverified', 'Não comprovada'], accepted_unverified: ['unverified', 'Aceita por uma pessoa SEM comprovação do sistema'], not_applicable: ['idle', 'Não se aplica (a missão não foi entregue)'],
};
const LEVEL = { verified: ['verified', 'comprovada'], inconclusive: ['inconclusive', 'inconclusiva'], failed: ['failed', 'falhou'], absent: ['idle', 'sem parecer'] };
export const VERIFICATION_TEXT = { pass: 'passou', fail: 'falhou', error: 'erro', cancelled: 'cancelada', timeout: 'tempo esgotado', output_limit: 'saída acima do limite', blocked: 'bloqueada' };

/** "1 tentativa", "3 tentativas (2 retentativas)", "não executada"; ausente => "não informado" (nunca zero). */
export function attemptsText(attempts) {
  const n = count(attempts);
  if (n === null) return 'tentativas: não informado';
  if (n === 0) return 'não executada';
  if (n === 1) return '1 tentativa';
  return `${n} tentativas (${n - 1} ${n - 1 === 1 ? 'retentativa' : 'retentativas'})`;
}
export function retriesText(used) {
  const n = count(used);
  if (n === null) return 'retentativas automáticas: não informado pelo servidor';
  return n === 0 ? 'Nenhuma retentativa automática neste ciclo.' : `${n} ${n === 1 ? 'retentativa automática usada' : 'retentativas automáticas usadas'} neste ciclo.`;
}

/** Configuração real do servidor (/api/state.orchestration), em uma frase; null se o servidor não a informa. */
export function orchestrationNote(o) {
  if (!isObj(o) || typeof o.planMode !== 'boolean' || count(o.stepRetries) === null) return null;
  const plan = o.planMode ? 'Plano em várias etapas: ligado' : 'Plano em várias etapas: desligado (o Planner decide uma tarefa por vez)';
  const retry = o.stepRetries > 0 ? `reparo automático de etapas: ligado (até ${o.stepRetries} ${o.stepRetries === 1 ? 'retentativa' : 'retentativas'} por ciclo; até ${count(o.maxStepAttempts) ?? '?'} tentativas por etapa)` : 'reparo automático de etapas: desligado';
  return `${plan}; ${retry}.`;
}

/**
 * Chave que muda quando o relatório PODE ter mudado (e só então): missão, ciclo, estado, bloqueio, rodadas e a última delas, etapas do plano, aceitação, revisão de integridade e aprovações.
 * Logs, uso de tokens e tarefas de outras missões não entram (chegam o tempo todo): nada de requisição repetida à toa. null = sem missão.
 */
export function deliveryKey(mission) {
  if (!isObj(mission) || typeof mission.id !== 'string') return null;
  const c = mission.cycle;
  if (!isObj(c)) return JSON.stringify([mission.id, 'sem-ciclo', arr(mission.tasks).map((t) => [t?.id, t?.status])]);
  const rounds = arr(c.rounds), last = rounds.at(-1);
  return JSON.stringify([mission.id, c.id ?? null, c.status, c.blockedCode ?? null, c.finishedAt ?? null, rounds.length,
    last ? [last.n, last.status, last.phase ?? null, last.verification ?? null, last.report?.evidence?.level ?? null, last.report?.reverifiedAt ?? null, last.report?.verificationsInterrupted ? 1 : 0] : null,
    arr(c.plan?.steps).map((s) => [s?.id, s?.status, s?.round ?? null]), c.acceptance?.at ?? null, arr(c.integrity?.pending).length, arr(c.approvals).map((a) => a?.status)]);
}

const IDLE = Object.freeze({ missionId: null, key: null, status: 'idle', report: null, error: null });

/**
 * Carregador do relatório por missão, sem React: uma resposta só vale se ainda for a ÚLTIMA pedida (outra missão ou outra chave pedida depois a invalida);
 * a mesma missão com a mesma chave não é pedida de novo (salvo `force`); trocar de missão descarta o relatório antigo na hora.
 * Estados: idle | loading (com `report` só se for a MESMA missão em atualização) | ready | empty | error (sem report: nunca mostra dado possivelmente velho como atual).
 */
export function createDeliveryLoader({ fetchReport, onChange = () => {} }) {
  let seq = 0, disposed = false, current = IDLE;
  const set = (next) => { current = next; if (!disposed) onChange(current); };
  return {
    get state() { return current; },
    async load(missionId, key, { force = false } = {}) {
      if (disposed) return;
      if (typeof missionId !== 'string' || !missionId) { seq++; set(IDLE); return; }
      if (!force && current.missionId === missionId && current.key === key && (current.status === 'loading' || current.status === 'ready' || current.status === 'empty')) return;
      const my = ++seq, same = current.missionId === missionId;
      set({ missionId, key, status: 'loading', report: same ? current.report : null, error: null });
      try {
        const report = await fetchReport(missionId);
        if (my !== seq || disposed) return;
        set(isObj(report) ? { missionId, key, status: 'ready', report, error: null } : { missionId, key, status: 'empty', report: null, error: null });
      } catch (e) {
        if (my !== seq || disposed) return;
        set({ missionId, key, status: 'error', report: null, error: text(e?.message || 'erro desconhecido', 300) });
      }
    },
    dispose() { disposed = true; seq++; },
  };
}

// ---- Integração (Marco D): só apresenta report.integration; ausente => null (a seção nem aparece). Pendente e dado ausente nunca viram sucesso. ----
const INTEGRATION = {
  integrated: ['completed', 'Integrado à branch de destino'], pending: ['unverified', 'Pendente: o trabalho ainda NÃO foi integrado'], blocked: ['blocked', 'Bloqueado: a integração não pode ser confirmada'],
};
const RELATION = { current: 'ciclo atual', past: 'ciclo anterior' };
const ATTEMPT_KIND = { check: 'checagem', integrate: 'integração' };
const ATTEMPT_RESULT = { mergeable: 'pode integrar', conflict: 'conflito', invalid: 'não integrável agora' };
const ATTEMPT_OUTCOME = { integrated: 'integrada', refused: 'recusada', started: 'iniciada, sem desfecho registrado', failed_unchanged: 'falhou (destino intacto)', interrupted_unchanged: 'interrompida (destino intacto)', inconsistent: 'terminou em estado inesperado' };
const PREP_LABEL = {
  none: ['idle', 'Nenhuma preparação de ambiente registrada'], planned: ['unverified', 'Plano criado, sem execução'], approved: ['running', 'Aprovada: execução não confirmada'], running: ['running', 'Em execução (nada concluído ainda)'],
  ready: ['completed', 'Ambiente preparado e verificado pelo backend'], failed: ['failed', 'A preparação falhou'], interrupted: ['interrupted', 'Interrompida: NÃO é um ambiente pronto'], inconclusive: ['blocked', 'Inconclusiva: o worktree continua bloqueado'],
};
/** Preparação de ambiente de um worktree (report.integration.worktrees[].preparation). Ausente => null. "ready" só vale como verificado com verified === true; senão é "não verificado". */
export function preparationView(x) {
  if (!isObj(x)) return null;
  const [value0, label0] = PREP_LABEL[x.state] ?? ['failed', 'Estado de preparação não reconhecido (não é confirmação)'];
  const verified = x.state === 'ready' && x.verified === true;
  const notVerifiedReady = x.state === 'ready' && !verified;
  return { state: PREP_LABEL[x.state] ? x.state : 'unknown', value: notVerifiedReady ? 'unverified' : value0, label: notVerifiedReady ? 'Registrada como pronta, mas NÃO verificada neste relatório' : label0, verified, evidence: text(x.evidence, 20),
    worktreeBlocked: x.worktreeBlocked === true, reasons: arr(x.reasons).filter((r) => typeof r === 'string' && r).map((r) => text(r, 400)),
    detail: [x.dependencies != null ? `${x.dependencies} dependência(s)` : null, Number.isInteger(x.exitCode) ? `código de saída ${x.exitCode}` : null, Number.isFinite(x.durationMs) ? `${Math.round(x.durationMs / 1000)} s` : null, isObj(x.approval) && x.approval.approvedAt ? `aprovada em ${text(x.approval.approvedAt, 40)}` : null].filter(Boolean).join(' · '),
    approvalDigest: isObj(x.approval) && typeof x.approval.digest === 'string' ? text(x.approval.digest, 64) : null };
}
const short = (s) => (typeof s === 'string' && s ? s.slice(0, 12) : null);
const NOT_INTEGRATED = /^Missão concluída, mas o trabalho NÃO está integrado/;
export function integrationView(report) {
  const x = isObj(report) ? report.integration : undefined;
  if (!isObj(x)) return null;
  const [value, label] = INTEGRATION[x.status] ?? ['failed', 'Estado de integração não reconhecido (não é confirmação)'];
  const worktrees = arr(x.worktrees).filter(isObj).map((w) => {
    const [wv, wl] = INTEGRATION[w.status] ?? ['failed', 'Estado não reconhecido'];
    const i = isObj(w.integration) ? w.integration : null, a = isObj(w.lastAttempt) ? w.lastAttempt : null, d = isObj(w.diagnostic) ? w.diagnostic : null;
    const confirmed = w.status === 'integrated' && !!short(w.integratedCommit);
    return {
      id: text(w.id, 40), relation: w.relation === 'past' ? 'past' : 'current', relationLabel: RELATION[w.relation] ?? 'ciclo não informado', cycleId: w.cycleId ? text(w.cycleId, 60) : null,
      value: wv, label: wl, state: text(w.state, 30), branch: text(w.branch, 80), baseBranch: text(w.baseBranch, 80),
      commit: confirmed ? short(w.integratedCommit) : null, commitText: w.status === 'integrated' ? (confirmed ? `commit integrado: ${short(w.integratedCommit)}` : 'commit de integração: não informado') : null,
      digestText: w.status === 'integrated' ? (i?.digest ? `digest da autorização: ${text(i.digest, 64)}` : 'digest da autorização: não informado') : null,
      authorizedText: w.status === 'integrated' ? (i?.authorizedBy ? `autorizada por: ${text(i.authorizedBy, 60)}${i.at ? ` em ${text(i.at, 40)}` : ''}` : 'autorização: não informada') : null,
      attemptText: a ? `última tentativa: ${ATTEMPT_KIND[a.kind] ?? 'não informada'}${a.result ? ` · ${ATTEMPT_RESULT[a.result] ?? text(a.result, 30)}` : ''}${a.outcome ? ` · ${ATTEMPT_OUTCOME[a.outcome] ?? text(a.outcome, 30)}` : ''}${a.at ? ` · ${text(a.at, 40)}` : ''}` : 'última tentativa: nenhuma registrada',
      attemptProblems: a ? arr(a.problems).map((p) => text(p, 60)) : [],
      diagnostic: d ? `${d.code ? `${text(d.code, 60)}: ` : ''}${text(d.reason, 300)}` : null,
      reasons: arr(w.reasons).filter((r) => typeof r === 'string' && r).map((r) => text(r, 400)),
      preparation: preparationView(w.preparation),
    };
  });
  return { value, label, status: x.status ?? null, confirmed: x.status === 'integrated', reasons: arr(x.reasons).filter((r) => typeof r === 'string' && r).map((r) => text(r, 400)), worktrees,
    limitation: arr(report.limitations).find((l) => typeof l === 'string' && NOT_INTEGRATED.test(l)) ?? null };
}

/** Modelo de exibição de um relatório do servidor. Devolve null se não for um relatório (nada é inventado). */
export function deliveryView(report) {
  if (!isObj(report) || !isObj(report.state)) return null;
  const [codeKey, codeLabel] = CODE[report.state.code] ?? CODE.unknown;
  const assuranceIn = isObj(report.assurance) ? report.assurance : {};
  const [aKey, aLabel] = ASSURANCE[assuranceIn.level] ?? ASSURANCE.unverified;
  const completed = report.state.code === 'completed';
  const observed = isObj(report.observed) ? report.observed : {};
  const verified = isObj(report.verified) ? report.verified : {};
  const integration = integrationView(report);
  // a limitação "concluída sem integração" aparece na seção Integração (não duplicada na lista geral)
  const limitations = arr(report.limitations).filter((x) => typeof x === 'string' && x && !(integration && NOT_INTEGRATED.test(x))).map((x) => text(x, 600));
  const steps = arr(observed.steps).filter(isObj).map((s) => ({
    id: text(s.id, 40), title: text(s.title, 200), status: s.status, label: statusLabel(s.status), attempts: count(s.attempts), attemptsText: attemptsText(s.attempts),
    retries: count(s.attempts) ? Math.max(0, s.attempts - 1) : 0, uncertain: !!s.uncertain, executed: !!s.executedByRound,
  }));
  const evidence = arr(verified.evidence).filter(isObj).map((e) => {
    const [k, l] = LEVEL[e.level] ?? LEVEL.absent;
    return { round: e.round, value: k, label: l, basis: text(e.basis, 200), reasons: arr(e.reasons).map((x) => text(x, 300)), expectedFiles: arr(e.expectedFiles).filter(isObj).map((f) => ({ path: text(f.path, 200), ok: !!f.ok, reason: f.reason ? text(f.reason, 200) : null })), integrity: e.integrity ?? null };
  });
  const verifications = arr(verified.verifications).filter(isObj).map((v) => ({
    round: v.round, script: text(v.script, 60), status: v.status, label: VERIFICATION_TEXT[v.status] || text(v.status, 30) || 'sem resultado', required: !!v.required, reason: v.reason ? text(v.reason, 300) : null,
    pass: v.status === 'pass',
  }));
  const reasons = arr(report.state.reasons).filter((x) => typeof x === 'string' && x).map((x) => text(x, 500));
  // aviso explícito: nada que não seja "concluída com garantia verificada" é apresentado como pronto
  const notice = completed && aKey !== 'verified' ? 'Concluída, mas SEM comprovação independente do sistema: veja as limitações abaixo.'
    : !completed && codeKey !== 'running' ? 'Não é uma entrega concluída.' : null;
  return {
    headline: { value: codeKey, label: codeLabel, code: report.state.code ?? null, delivered: completed && report.state.delivered === true },
    reasons, notice,
    assurance: { value: aKey, label: aLabel, level: assuranceIn.level ?? null, basis: assuranceIn.basis ? text(assuranceIn.basis, 300) : null, reasons: arr(assuranceIn.reasons).map((x) => text(x, 400)) },
    steps, hasSteps: steps.length > 0,
    retries: { used: count(observed.retriesUsed), text: retriesText(observed.retriesUsed) },
    limitations, hasLimitations: limitations.length > 0, integration,
    evidence, verifications, missing: arr(verified.missing).filter(isObj).map((m) => ({ script: text(m.script, 60), required: !!m.required, reason: text(m.reason, 200) })),
    rounds: count(report.cycle?.rounds), maxIterations: count(report.cycle?.maxIterations),
  };
}
