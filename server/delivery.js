// Relatório de ENTREGA de uma missão: montado SÓ a partir de registros que o sistema já persistiu (missão, ciclo, rodadas, tarefas, workspace).
// Função pura: não grava, não executa nada e não muda o estado da missão. Nada é inventado: o que não há nos registros vira limitação explícita.
//
// Três camadas que nunca se misturam:
//   declared : o que um AGENTE disse (resumo e evidências textuais do Planner, relatórios e checks autodeclarados do Executor). NÃO é prova.
//   observed : o que o SISTEMA registrou ter acontecido (estado e código de saída de cada rodada, arquivos que o Git mostrou alterados, estado das etapas).
//              É observação, não verificação: a lista de arquivos é PARCIAL por natureza.
//   verified : o que o SISTEMA conferiu por conta própria (verificações reais do workspace, arquivos esperados conferidos no disco, integridade dos testes).
// `assurance` resume o que os registros sustentam. Só "verified" quando a evidência do sistema da ÚLTIMA rodada é "verified"; evidência inconclusiva
// ou ausente nunca vira positiva. A política de conclusão do ciclo NÃO é alterada aqui (este módulo só descreve).
//
// Contrato dos campos de origem (nada do relatório é gravado; só o contexto mínimo `cycle.deliveryContext`):
//   source: 'recomputed'  o relatório é SEMPRE reconstruído na consulta a partir dos registros gravados; não é recuperado de uma cópia completa persistida.
//   context.kind          de onde vêm o workspace e as verificações configuradas do relatório:
//                           'closing_context'  contexto gravado quando o ciclo terminou (cycle.deliveryContext), ligado a ESTE ciclo terminado (id, estado e instante de fim);
//                           'legacy_snapshot'  dado do formato anterior (cycle.delivery, relatório inteiro) que identifica o mesmo ciclo terminado: só workspace e verificações são aproveitados;
//                           'none'             sem contexto válido (ciclo ainda não terminado, retomado, ou terminado sem registro): valem o workspace e a configuração ATUAIS
//                                              (e, se o ciclo já terminou, uma limitação diz que podem diferir dos vigentes no encerramento).
//   mission.workspace.source e verified.configuredSource: 'frozen_at_close' (kind closing_context ou legacy_snapshot) ou 'current' (kind none).
//   currentWorkspace      SÓ existe quando há contexto congelado: mostra à parte a situação ATUAL ({ exists, verificationsChanged, source: 'current' }) sem alterar o histórico.
import crypto from 'node:crypto';
import { roundVerification } from './cycle.js';
import { stepStatusFromRound, retriesUsed } from './plan.js';

export const DELIVERY_SCHEMA = 1;
const MAX_FILES = 200, PER_ROUND_CAP = 50; // buildReport (cycle.js) já corta em 50 arquivos por rodada
const safeVerification = (r) => { try { return roundVerification(r); } catch { return null; } }; // dado malformado nunca derruba o relatório
const clip = (s, n) => String(s ?? '').slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Resumo do que uma aceitação humana de conclusão NÃO verificada viu (cycle.acceptance.digest): ciclo, última rodada, parecer de evidência do sistema, resultado das
 * verificações e alterações de testes pendentes. Se qualquer um mudar depois (rodada nova, parecer diferente, dado adulterado), a aceitação deixa de valer.
 * `rec` (por, instante, rodada e motivo da decisão) também entra na base. É só detecção de mudança acidental ou parcial: o SHA-256 não tem segredo e NÃO prova autoria
 * nem protege contra quem consegue editar o banco (que pode recalculá-lo).
 * Nunca lança: dado malformado gera um resumo diferente (a aceitação deixa de valer), não uma exceção.
 */
export function acceptanceDigest(c, rec = null) {
  const rounds = arr(c?.rounds).filter(isObj), last = rounds.at(-1), ev = isObj(last?.report?.evidence) ? last.report.evidence : null;
  const basis = {
    cycleId: c?.id ?? null, rounds: rounds.length, round: last?.n ?? null, reportStatus: last?.report?.status ?? null,
    evidence: ev ? { level: ev.level ?? null, at: ev.at ?? null, reasons: arr(ev.reasons).map((x) => String(x)) } : null,
    verifications: arr(last?.report?.verifications).filter(isObj).map((v) => [v.id ?? v.script ?? null, v.status ?? null]),
    integrityPending: arr(c?.integrity?.pending).filter(isObj).map((p) => [p.path ?? null, p.hash ?? null]),
    decision: isObj(rec) ? { by: rec.by ?? null, at: rec.at ?? null, round: rec.round ?? null, reason: typeof rec.reason === 'string' ? rec.reason : null } : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

/** Aceitação humana registrada no ciclo (cycle.acceptance) e se AINDA vale. Nada é inventado: sem registro => { recorded: false }. */
function acceptanceSection(c) {
  const a = c?.acceptance;
  if (!isObj(a)) return { recorded: false, valid: false };
  const why = [];
  if (a.kind !== 'unverified_acceptance' || a.by !== 'user') why.push('o registro não é uma decisão humana de aceitação reconhecida');
  if (c.status !== 'completed') why.push('o ciclo não está concluído');
  if (a.cycleId !== c.id) why.push('o registro pertence a outro ciclo');
  if (a.evidence?.level !== 'inconclusive') why.push('a aceitação só existe para evidência inconclusiva');
  if (typeof a.reason !== 'string' || a.reason.trim().length < 10 || typeof a.at !== 'string' || !a.at) why.push('o registro da aceitação está incompleto (motivo ou instante ausente)');
  const lastN = arr(c.rounds).filter(isObj).at(-1)?.n;
  if (!Number.isInteger(a.round) || a.round !== lastN) why.push('a rodada aceita não é a última rodada do ciclo');
  if (typeof a.digest !== 'string' || a.digest !== acceptanceDigest(c, a)) why.push('o estado do ciclo mudou depois da aceitação');
  return {
    recorded: true, valid: why.length === 0, kind: clip(a.kind, 40), by: clip(a.by, 20), at: a.at ?? null, cycleId: a.cycleId ?? null, round: a.round ?? null, reason: clip(a.reason, 500),
    evidenceAtDecision: isObj(a.evidence) ? { level: clip(a.evidence.level, 20), reasons: arr(a.evidence.reasons).slice(0, 8).map((x) => clip(x, 300)) } : null, invalidReasons: why,
  };
}

const STATE = { planning: 'in_progress', running: 'in_progress', blocked: 'blocked', cancelled: 'cancelled', limit_reached: 'limit_reached', completed: 'completed' };
const TERMINAL = ['completed', 'cancelled', 'limit_reached'];

/** Nível de evidência de UMA rodada, só do que está gravado: 'verified' | 'inconclusive' | 'failed' | 'absent' (+ a base do juízo). */
function roundLevel(round) {
  const rep = round?.report;
  if (!rep) return { level: 'absent', basis: 'sem relatório da rodada' };
  const ev = rep.evidence;
  if (isObj(ev) && ['verified', 'inconclusive', 'failed'].includes(ev.level)) return { level: ev.level, basis: `parecer do sistema (${clip(ev.basis, 60) || 'sem base informada'})` };
  // rodada anterior ao parecer de evidência (dados históricos): vale só o resultado das verificações reais gravado
  const v = safeVerification(round);
  if (v === 'passed') return { level: 'inconclusive', basis: 'rodada sem parecer de evidência (dado histórico): as verificações reais gravadas passaram, mas o sistema não gravou parecer; nada é presumido como verificado' };
  if (v === 'failed' || v === 'blocked') return { level: 'failed', basis: `verificações reais: ${v}` };
  if (v === 'skipped') return { level: 'inconclusive', basis: 'verificações reais configuradas, mas não concluídas' };
  return { level: 'absent', basis: 'nenhuma verificação real nem parecer de evidência gravados para esta rodada' };
}

function filesSection(rounds, tasks) {
  const by = new Map(), unknownRounds = [], truncatedRounds = [];
  for (const r of rounds) {
    const rep = r.report;
    if (!rep) continue;
    if (rep.filesKnown === false) unknownRounds.push(r.n);
    const list = arr(rep.filesChanged);
    if (list.length >= PER_ROUND_CAP) truncatedRounds.push(r.n);
    for (const f of list) {
      if (!isObj(f) || typeof f.path !== 'string') continue;
      const cur = by.get(f.path) ?? { path: f.path, status: null, added: null, removed: null, preexisting: true, rounds: [] };
      cur.status = f.status ?? cur.status; cur.added = f.added ?? cur.added; cur.removed = f.removed ?? cur.removed;
      cur.preexisting = cur.preexisting && !!f.preexisting; cur.rounds.push(r.n);
      by.set(f.path, cur);
    }
  }
  for (const t of tasks) for (const f of arr(t.files)) { // tarefas manuais (sem ciclo)
    if (!isObj(f) || typeof f.path !== 'string') continue;
    const cur = by.get(f.path) ?? { path: f.path, status: f.status ?? null, added: f.added ?? null, removed: f.removed ?? null, preexisting: !!f.preexisting, rounds: [] };
    by.set(f.path, cur);
  }
  const all = [...by.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { items: all.slice(0, MAX_FILES), total: all.length, truncatedList: all.length > MAX_FILES, unknownRounds, truncatedRounds };
}

/**
 * @param {object} mission
 * @param {object|null} workspace  workspace cadastrado da missão (para saber quais verificações reais existem)
 * @param {{now?:()=>string, context?:object|null}} [opts]  `context`: contexto histórico JÁ validado (ver frozenContextOf); sem ele vale a configuração ATUAL do workspace
 */
export function buildDelivery(mission, workspace = null, { now = () => new Date().toISOString(), context = null } = {}) {
  const m = mission, c = isObj(m?.cycle) ? m.cycle : null;
  const rounds = c ? arr(c.rounds).filter(isObj) : [], tasks = arr(m?.tasks).filter(isObj);
  const limitations = [];
  const cfgOf = (list) => arr(list).filter(isObj).map((v) => ({ script: v.script, required: !!v.required }));
  const currentConfigured = cfgOf(workspace?.verifications);
  // Histórico x atual: com contexto congelado no encerramento, o workspace e as verificações são os DAQUELE momento; sem ele, são os de AGORA (e, se o ciclo já terminou, isso é dito).
  const configured = context ? context.verifications : currentConfigured;
  const wsIdentity = context ? context.workspace : workspace ? { id: workspace.id, name: workspace.name } : null;
  const terminalCycle = !!c && TERMINAL.includes(c.status);
  if (context) {
    const sameCfg = JSON.stringify(currentConfigured) === JSON.stringify(context.verifications);
    if (context.workspace && !workspace) limitations.push('O workspace foi removido do cadastro depois do encerramento; o relatório usa a identidade e as verificações registradas no encerramento.');
    else if (!sameCfg) limitations.push('A configuração de verificações do workspace mudou depois do encerramento; o relatório usa a configuração do ENCERRAMENTO (a atual está em "currentWorkspace").');
  } else if (terminalCycle) limitations.push('Sem contexto gravado no encerramento do ciclo (dado anterior a este registro): o workspace e as verificações configuradas são os ATUAIS e podem diferir dos vigentes quando o ciclo terminou.');

  // ---- estado da entrega: só "completed" é entrega; o resto NUNCA é apresentado como concluído ----
  let code, reasons = [];
  if (m?.demo) { code = 'demo'; reasons.push('Missão demonstrativa: nada foi executado.'); }
  else if (!c) { code = 'no_cycle'; reasons.push('A missão não tem ciclo autônomo; só há tarefas manuais (se houver), sem decisão de conclusão do Planner.'); }
  else {
    code = STATE[c.status] ?? 'unknown';
    if (code === 'blocked') reasons.push(`Ciclo bloqueado (${c.blockedCode ?? 'sem código'}): ${clip(c.blockedReason, 400) || 'sem motivo gravado'}`);
    if (code === 'cancelled') reasons.push('Ciclo cancelado: o trabalho não foi concluído.');
    if (code === 'limit_reached') reasons.push(`Limite de ${c.maxIterations} rodadas atingido antes da conclusão.`);
    if (code === 'in_progress') reasons.push('O ciclo ainda está em andamento.');
    if (code === 'unknown') reasons.push(`Estado de ciclo não reconhecido: ${clip(c.status, 40)}.`);
  }
  const delivered = code === 'completed';

  // ---- declarado ----
  const declared = {
    note: 'Declarações de agentes. Não são prova de conclusão.',
    // Com aceitação humana registrada, `finalSummary` é o texto da DECISÃO DA PESSOA (cycle.acceptance), nunca uma declaração do Planner.
    plannerSummary: c && c.finalSummary && !isObj(c.acceptance) ? { text: clip(c.finalSummary, 1500), evidence: arr(c.evidence).filter((x) => typeof x === 'string').map((x) => clip(x, 500)), origin: 'planner', label: 'declaração do Planner' } : null,
    cycleAssuranceLabel: c?.assurance ?? null, // rótulo gravado pelo próprio ciclo; NÃO é usado para calcular `assurance` abaixo
    executorReports: rounds.map((r) => ({
      round: r.n, origin: 'executor', summary: clip(r.report?.summary, 600), reportedStatus: r.report?.status ?? null,
      checks: arr(r.report?.checks).slice(0, 20).map((k) => ({ name: clip(k?.name, 200), result: k?.result, detail: clip(k?.detail, 300) })), checksReported: !!r.report?.checksReported,
    })),
    manualTaskReports: tasks.filter((t) => !t.auto && t.report).map((t) => ({ taskId: t.id, title: clip(t.title, 200), status: t.status, report: clip(t.report, 600), origin: 'executor' })),
  };
  if (!declared.plannerSummary) limitations.push(isObj(c?.acceptance) ? 'A conclusão não é uma declaração do Planner: ela consta como decisão humana de aceitação (veja "acceptance").' : c ? 'O Planner não gravou um resumo final (o ciclo não foi concluído por ele).' : 'Não há resumo declarado pelo Planner.');

  // ---- observado ----
  const manual = tasks.filter((t) => !t.auto);
  const files = filesSection(rounds, c ? [] : manual);
  const planSteps = arr(c?.plan?.steps).filter(isObj);
  // attempts: rodadas gravadas com o planId e o stepId da etapa NO PLANO ATUAL (0 = nunca executada; ciclos antigos, que só têm uma rodada por etapa, dão 1). Derivado, nunca gravado.
  const stepsOut = planSteps.map((s) => { const rs = rounds.filter((x) => x.planId === c.plan?.id && x.stepId === s.id), r = rs.at(-1); return { id: s.id, title: clip(s.title, 200), dependsOn: arr(s.dependsOn), status: stepStatusFromRound(r), round: r?.n ?? null, uncertain: !!r?.report?.outcomeUncertain, executedByRound: !!r, attempts: rs.length }; });
  const observed = {
    note: 'Registros do sistema sobre o que aconteceu. Observação não é verificação.',
    rounds: rounds.map((r) => ({
      n: r.n, status: r.status, phase: r.phase ?? null, title: clip(r.plan?.title, 200), agent: r.agent ?? null, stepId: r.stepId ?? null, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
      exitCode: r.report?.exitCode ?? null, executed: r.taskId != null, policy: isObj(r.policy) ? { decision: r.policy.decision, authorizedBy: r.policy.authorizedBy ?? null, outcome: r.policy.outcome ?? null } : null,
      uncertainOutcome: r.report?.outcomeUncertain ? clip(r.report.outcomeUncertain, 300) : null, errors: arr(r.report?.errors).slice(0, 5).map((e) => clip(e, 300)), blockers: arr(r.report?.blockers).slice(0, 5).map((e) => clip(e, 300)),
    })),
    steps: stepsOut,
    retriesUsed: c ? retriesUsed({ rounds }) : 0, // retentativas automáticas do ciclo ATUAL, somando todos os planos dele (rodadas além da primeira de cada planId+stepId); ciclos arquivados não entram
    manualTasks: c ? [] : manual.map((t) => ({ taskId: t.id, title: clip(t.title, 200), status: t.status, exitCode: t.exitCode ?? null })),
    files: {
      source: 'git status/diff do workspace depois de cada execução (task.files)', ...files,
      limitation: 'Lista PARCIAL: reflete o que o Git mostrou alterado ao fim de cada execução; não prova que representa todas as alterações reais do workspace (arquivos criados e revertidos, ignorados pelo Git, fora do Git ou além do limite de listagem não aparecem). "preexisting" = já estava alterado antes da execução.',
    },
  };
  if (files.unknownRounds.length) limitations.push(`Arquivos alterados desconhecidos nas rodadas ${files.unknownRounds.join(', ')} (workspace sem Git ou execução interrompida sem relatório final).`);
  if (files.truncatedRounds.length) limitations.push(`A lista de arquivos pode estar truncada nas rodadas ${files.truncatedRounds.join(', ')} (limite de ${PER_ROUND_CAP} por rodada).`);
  if (files.truncatedList) limitations.push(`Foram listados só ${MAX_FILES} de ${files.total} arquivos.`);
  if (!rounds.length && !manual.some((t) => t.files?.length)) limitations.push('Nenhuma execução registrou arquivos alterados.');
  if (files.items.some((f) => f.preexisting)) limitations.push('Alguns arquivos já estavam alterados antes da execução; a lista não separa o que a execução acrescentou nesses arquivos.');
  for (const r of rounds) if (r.report?.outcomeUncertain) limitations.push(`Rodada ${r.n}: o servidor caiu durante a execução; o resultado e os efeitos no workspace são desconhecidos.`);
  for (const s of stepsOut) if (s.status !== 'completed') limitations.push(`Etapa "${s.id}" do plano não está concluída (estado: ${s.status}).`);

  // ---- verificado ----
  const verifications = [], evidence = [];
  for (const r of rounds) {
    const rep = r.report;
    for (const v of arr(rep?.verifications)) if (isObj(v)) verifications.push({ round: r.n, script: v.script ?? null, command: clip(v.command, 200), required: !!v.required, status: v.status ?? null, exitCode: v.exitCode ?? null, durationMs: v.durationMs ?? null, reason: v.reason ? clip(v.reason, 300) : null, source: v.source ?? null });
    const lv = roundLevel(r), ev = rep?.evidence;
    evidence.push({
      round: r.n, level: lv.level, basis: lv.basis, recordedByEvidenceModule: isObj(ev), reasons: arr(ev?.reasons).slice(0, 8).map((x) => clip(x, 300)),
      expectedFiles: arr(ev?.system?.expectedFiles).map((x) => ({ path: x.path, ok: !!x.ok, reason: x.reason ? clip(x.reason, 200) : null })),
      integrity: ev?.system?.integrity ?? r.integrity?.status ?? null, realVerification: safeVerification(r),
      ...(rep?.verificationsInterrupted ? { verificationsInterrupted: clip(rep.verificationsInterrupted, 300) } : {}), ...(rep?.verificationsSkipped ? { verificationsSkipped: clip(rep.verificationsSkipped, 300) } : {}),
    });
  }
  const last = rounds.at(-1), lastVs = arr(last?.report?.verifications).filter(isObj);
  const missingVerifications = configured.filter((cfg) => !lastVs.some((v) => v.script === cfg.script)).map((cfg) => ({ script: cfg.script, required: cfg.required, reason: last ? 'não executada na última rodada' : 'nenhuma rodada executada' }));
  const verified = {
    note: 'Resultados conferidos pelo próprio sistema (verificações reais do workspace, arquivos esperados no disco, integridade dos testes).',
    configured, configuredSource: context ? 'frozen_at_close' : 'current', verifications, evidence, missing: missingVerifications,
  };
  if (!configured.length) limitations.push('O workspace não tem verificações reais configuradas: não há teste, build nem lint rodado pelo orquestrador.');
  for (const mv of missingVerifications) if (rounds.length) limitations.push(`Verificação "${mv.script}"${mv.required ? ' (obrigatória)' : ''} não foi executada na última rodada.`);
  const pending = arr(c?.integrity?.pending);
  if (pending.length) limitations.push(`Arquivos de teste ou de configuração alterados e ainda não revisados por uma pessoa: ${pending.slice(0, 5).map((p) => p.path).join(', ')}.`);

  // ---- garantia sustentada pelos registros ----
  const acceptance = acceptanceSection(c);
  const assurance = { level: 'not_applicable', basis: 'a missão não foi entregue', reasons: [] };
  if (delivered) {
    const lv = roundLevel(last), why = [];
    if (!last) why.push('conclusão sem nenhuma rodada registrada');
    if (lv.level !== 'verified') why.push(lv.level === 'failed' ? 'a evidência da última rodada FALHOU' : lv.level === 'inconclusive' ? 'a evidência da última rodada é inconclusiva' : 'não há evidência do sistema para a última rodada');
    for (const mv of missingVerifications.filter((x) => x.required)) why.push(`verificação obrigatória "${mv.script}" ausente na última rodada`);
    if (pending.length) why.push('há alterações em testes/configuração não revisadas');
    if (stepsOut.some((s) => s.status !== 'completed')) why.push('o plano tem etapas não concluídas');
    if (last?.report?.status !== 'success') why.push(`a última execução terminou como "${last?.report?.status ?? last?.status ?? 'sem relatório'}"`);
    // Aceitação humana válida de evidência INCONCLUSIVA: rótulo próprio, nunca "verified"; os motivos do sistema continuam listados. Falha, ausência ou QUALQUER outro impedimento
    // (verificação ausente, alterações pendentes, etapas abertas, execução sem sucesso): nunca. O único motivo tolerado é a própria evidência inconclusiva.
    const acceptedByUser = why.length === 1 && acceptance.valid && lv.level === 'inconclusive';
    assurance.level = !why.length ? 'verified' : acceptedByUser ? 'accepted_unverified' : 'unverified';
    assurance.basis = lv.basis; assurance.reasons = why.length ? (acceptedByUser ? [...why, 'conclusão aceita explicitamente por uma pessoa SEM evidência verificada'] : why) : ['evidência do sistema da última rodada: verified'];
    if (why.length) limitations.push(`Conclusão SEM garantia verificada: ${why.join('; ')}.`);
    if (acceptedByUser) limitations.push('Conclusão aceita por decisão humana explícita; o sistema NÃO verificou o trabalho (a evidência original continua inconclusiva).');
  }
  if (acceptance.recorded && !acceptance.valid) limitations.push(`Há uma aceitação humana registrada, mas ela NÃO vale mais: ${acceptance.invalidReasons.join('; ')}.`);

  return {
    schemaVersion: DELIVERY_SCHEMA, generatedAt: now(), source: 'recomputed',
    mission: { id: m?.id ?? null, title: clip(m?.title, 200), objective: clip(m?.objective, 1000), demo: !!m?.demo, origin: m?.origin ?? null, createdAt: m?.createdAt ?? null, workspace: wsIdentity ? { ...wsIdentity, source: context ? 'frozen_at_close' : 'current' } : null },
    cycle: c ? { id: c.id ?? null, status: c.status, rounds: rounds.length, maxIterations: c.maxIterations ?? null, startedAt: c.startedAt ?? null, finishedAt: c.finishedAt ?? null, blockedCode: c.blockedCode ?? null, blockedReason: c.blockedReason ? clip(c.blockedReason, 500) : null } : null,
    state: { code, delivered, reasons, acceptedUnverified: assurance.level === 'accepted_unverified' },
    declared, observed, verified, assurance, acceptance,
    limitations: [...new Set(limitations)],
    context: context ? { kind: context.kind, recordedAt: context.recordedAt ?? null, cycleId: context.cycleId, finishedAt: context.finishedAt } : { kind: 'none', recordedAt: null },
    ...(context ? { currentWorkspace: { exists: !!workspace, verificationsChanged: !!workspace && JSON.stringify(currentConfigured) !== JSON.stringify(context.verifications), source: 'current' } } : {}),
    legend: { declared: 'dito por um agente; não é prova', observed: 'registrado pelo sistema; não é verificação', verified: 'conferido pelo sistema com evidência própria' },
  };
}

/**
 * Contexto histórico MÍNIMO gravado quando o ciclo termina (cycle.deliveryContext): só o que não se reconstrói depois das rodadas (que são imutáveis) e pode mudar
 * fora do ciclo: identidade do workspace e verificações configuradas naquele momento. NÃO guarda o relatório. `cycle` já está no estado final (status/finishedAt).
 */
export function closingContext(mission, workspace, now = () => new Date().toISOString()) {
  const c = mission.cycle;
  return { v: 1, cycleId: c.id ?? null, status: c.status, finishedAt: c.finishedAt ?? null, recordedAt: now(), workspace: workspace ? { id: workspace.id, name: workspace.name } : null, verifications: arr(workspace?.verifications).filter(isObj).map((x) => ({ script: x.script, required: !!x.required })) };
}

const okCtx = (x) => isObj(x) && (x.workspace === null || (isObj(x.workspace) && typeof x.workspace.id === 'string')) && Array.isArray(x.verifications) && x.verifications.every((y) => isObj(y) && typeof y.script === 'string');

/**
 * Contexto histórico VÁLIDO para o ciclo atual da missão, ou null. Só vale para ciclo TERMINADO e só se identificar inequivocamente ESTE ciclo terminado
 * (mesmo id, mesmo estado e mesmo instante de fim): depois de uma retomada (finishedAt volta a null), de um novo ciclo ou de outra mudança de estado, não casa mais.
 * Dado antigo (formato anterior, `cycle.delivery` com o relatório inteiro): o que ele congelou do workspace e das verificações vale como contexto, desde que identifique o mesmo ciclo terminado.
 */
export function frozenContextOf(mission) {
  const c = mission?.cycle;
  if (!isObj(c) || !TERMINAL.includes(c.status) || c.finishedAt == null) return null;
  const x = c.deliveryContext;
  if (okCtx(x) && x.cycleId === c.id && x.status === c.status && x.finishedAt === c.finishedAt) return { kind: 'closing_context', cycleId: x.cycleId, finishedAt: x.finishedAt, recordedAt: x.recordedAt ?? null, workspace: x.workspace, verifications: x.verifications.map((y) => ({ script: y.script, required: !!y.required })) };
  const old = c.delivery; // formato anterior
  if (isObj(old) && old.cycle?.id === c.id && old.cycle?.finishedAt === c.finishedAt && old.cycle?.status === c.status && Array.isArray(old.verified?.configured)) {
    const w = old.mission?.workspace, y = { workspace: w === null ? null : isObj(w) && typeof w.id === 'string' ? { id: w.id, name: w.name } : undefined, verifications: old.verified.configured };
    if (y.workspace !== undefined && okCtx(y)) return { kind: 'legacy_snapshot', cycleId: c.id, finishedAt: c.finishedAt, recordedAt: old.generatedAt ?? null, workspace: y.workspace, verifications: y.verifications.map((z) => ({ script: z.script, required: !!z.required })) };
  }
  return null;
}

/**
 * Relatório para consulta: SEMPRE reconstruído a partir dos registros gravados (nenhuma cópia dele é persistida), com o contexto histórico do encerramento quando ele
 * identifica o ciclo terminado. Nunca lança: devolve { ok:false, error } se os dados forem ilegíveis.
 */
export function deliveryOf(mission, workspace, opts = {}) {
  try { return { ok: true, report: buildDelivery(mission, workspace, { ...opts, context: frozenContextOf(mission) }) }; } catch (e) { return { ok: false, error: `Não foi possível montar o relatório de entrega (${clip(e?.message, 120)}).` }; }
}
