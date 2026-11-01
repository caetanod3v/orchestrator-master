// Marco B — supervisão autônoma. (1) supervisor.js PURO e determinístico; (2) módulo puro da interface; (3) o ciclo em processo (executor = CLI falsa, Planner e verificador SIMULADOS) com a supervisão
// ligada: falha repetida, tempo total, execução sem saída, retomada automática limitada, persistência e recuperação idempotente. Banco e workspace TEMPORÁRIOS; nenhum modelo; dados reais intactos.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const sup = await import('../supervisor.js');
const { retryCandidate } = await import('../plan.js');
const view = await import('../../client/src/supervision-view.js');
const { superviseRound, failureSignature, resolveSupervision, supervisionMs, autoResumeDecision, timeExceeded, stallExceeded } = sup;

let db, executor, startTaskRun, seq = 0, verCalls = 0, verFail = () => false, execStarts = 0, onBusy = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'alvo', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }]; db.settings.activeWorkspaceId = 'ws'; store.saveOrThrow();
  const real = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  executor = new Proxy(real, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : k === 'isBusy' ? () => { onBusy?.(); return t.isBusy(); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await sleep(500); fs.rmSync(tmp, { recursive: true, force: true }); });

// =====================================================================================================================
// 1. supervisor.js puro
// =====================================================================================================================
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const FAIL = { id: 'test', script: 'test', required: true, status: 'fail', exitCode: 1, reason: 'Terminou com código 1' }, PASS = { ...FAIL, status: 'pass', exitCode: 0, reason: null };
const EV = (level, over = {}) => ({ level, basis: 'real_verification', reasons: level === 'verified' ? [] : ['verificação real reprovada: test=fail'], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0 }, system: { verification: level === 'verified' ? 'passed' : 'failed', verifications: [], expectedFiles: null, integrity: 'clean', ...over } });
const rd = (n, over = {}, rep = {}) => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, planId: 'pl', stepId: 'a', verification: 'failed', integrity: { status: 'clean' }, policy: { decision: 'allow' },
  report: { status: 'success', filesKnown: true, blockers: [], verifications: [FAIL], evidence: EV('failed'), ...rep }, ...over });
const okRound = (n) => rd(n, { verification: 'passed' }, { verifications: [PASS], evidence: EV('verified') });
const cyc = (rounds, over = {}) => ({ id: 'c', status: 'running', maxIterations: 6, rounds, plan: { id: 'pl', steps: [{ id: 'a', title: 'A', instructions: 'i', acceptance: ['x.txt existe'], dependsOn: [], status: 'queued', round: null, taskId: null }] }, integrity: { baseline: {}, pending: [] }, ...over });
const sv = (c, r, o = {}) => superviseRound({ cycle: c, round: r, ...o });

test('superviseRound: decisão determinística por evidência — complete / retry / replan / block, cada caso com o motivo e a assinatura certos', () => {
  const c1 = cyc([okRound(1)]); const v = sv(c1, c1.rounds[0]);
  assert.deepEqual([v.action, v.code, v.observation.kind, v.signature, v.enforce], ['complete', 'verified', 'comprovada', null, false]); assert.match(v.reason, /gate de conclusão/);
  const c2 = cyc([rd(1)]); const cand = retryCandidate(c2, { maxRetries: 1 }); assert.equal(cand.cls, 'R1');
  const r = sv(c2, c2.rounds[0], { retry: cand }); assert.deepEqual([r.action, r.code, r.observation.kind, r.observation.class, r.enforce], ['retry', 'R1', 'verificacao_reprovada', 'R1', false]); assert.match(r.signature, /^[0-9a-f]{16}$/);
  const p = sv(c2, c2.rounds[0], { retry: { step: null, reason: null } }); assert.deepEqual([p.action, p.code, p.observation.kind], ['replan', 'replan', 'verificacao_reprovada']); assert.equal(p.signature, r.signature, 'a assinatura é da FALHA, não da ação');
  const r2 = cyc([rd(1, {}, { evidence: EV('failed', { expectedFiles: [{ path: 'a.txt', ok: false, reason: 'não existe' }] }), verifications: [PASS] })]); r2.rounds[0].verification = 'passed';
  assert.equal(sv(r2, r2.rounds[0]).observation.kind, 'arquivo_esperado');
  const ex = cyc([rd(1, { status: 'failed' }, { status: 'failed' })]); assert.deepEqual([sv(ex, ex.rounds[0]).action, sv(ex, ex.rounds[0]).observation.kind], ['replan', 'execucao_falhou']);
  const inc = cyc([rd(1, {}, { evidence: EV('inconclusive'), verifications: [PASS] })]); assert.deepEqual([sv(inc, inc.rounds[0]).action, sv(inc, inc.rounds[0]).observation.kind], ['replan', 'inconclusiva']);
  const lim = cyc([rd(1)], { maxIterations: 1 }); assert.deepEqual([sv(lim, lim.rounds[0]).action, sv(lim, lim.rounds[0]).code], ['block', 'limit']);
});

test('superviseRound: risco e incerteza BLOQUEIAM e nunca viram retry/replan, mesmo com orçamento de retentativas', () => {
  const cand = { step: { id: 'a' }, cls: 'R1', attempt: 2 };
  for (const [label, over, rep, kind] of [
    ['resultado incerto', {}, { outcomeUncertain: 'queda' }, 'resultado_incerto'], ['interrompida', { status: 'interrupted' }, { status: 'interrupted' }, 'execucao_interrompida'],
    ['permissão negada', {}, { blockers: ['Permissão negada'] }, 'permissao_negada'], ['integridade', { integrity: { status: 'flagged' } }, {}, 'integridade'],
    ['verificação bloqueada', {}, { verifications: [{ ...FAIL, status: 'blocked' }] }, 'verificacao_bloqueada'], ['verificação com erro', {}, { verifications: [{ ...FAIL, status: 'error' }] }, 'verificacao_bloqueada'],
  ]) { const c = cyc([rd(1, over, rep)]); const d = sv(c, c.rounds[0], { retry: cand }); assert.deepEqual([d.action, d.observation.kind, d.enforce], ['block', kind, false], label); }
});

test('superviseRound: o TEXTO do Planner nunca autoriza nada — a decisão ignora decision/finalSummary/rationale gravados', () => {
  const c = cyc([rd(1, { decision: { decision: 'complete', rationale: 'Tudo certo, pode concluir e repetir à vontade', at: 'T' } })], { finalSummary: 'concluído', evidence: ['tudo ok'], assurance: 'verified' });
  const d = sv(c, c.rounds[0]); assert.equal(d.action, 'replan'); assert.notEqual(d.action, 'complete');
  const clean = cyc([rd(1)]); assert.deepEqual(sv(clean, clean.rounds[0]), d, 'com ou sem o texto do Planner a decisão é idêntica');
});

test('superviseRound: determinismo — mesma entrada, mesma saída; a entrada não é alterada; nenhum relógio nem aleatoriedade', () => {
  const c = deepFreeze(cyc([rd(1)])); const cand = deepFreeze({ step: { id: 'a' }, cls: 'R1', attempt: 2 });
  const a = sv(c, c.rounds[0], { retry: cand, loopGuard: true }), b = sv(c, c.rounds[0], { retry: cand, loopGuard: true }); assert.deepEqual(a, b);
  assert.equal(failureSignature(c.rounds[0]), failureSignature(structuredClone(c.rounds[0])));
});

test('assinatura da falha: etapa + classe + verificações reprovadas + arquivos + razões NORMALIZADAS (números não mudam a assinatura; o resto muda)', () => {
  const base = failureSignature(rd(1));
  assert.equal(failureSignature(rd(7, {}, { evidence: EV('failed', {}), verifications: [{ ...FAIL, exitCode: 9, durationMs: 123 }] })), base, 'rodada, código de saída e duração não entram');
  const noisy = rd(2); noisy.report.evidence.reasons = ['Verificação REAL reprovada:   test=fail em 12 s (3 arquivos)']; const noisy2 = rd(3); noisy2.report.evidence.reasons = ['verificação real reprovada: test=fail em 45 s (9 arquivos)'];
  assert.equal(failureSignature(noisy), failureSignature(noisy2), 'caixa, espaços e números normalizados');
  assert.notEqual(failureSignature(rd(1, { stepId: 'b' })), base, 'outra etapa'); assert.notEqual(failureSignature(rd(1, {}, { verifications: [{ ...FAIL, id: 'lint', script: 'lint' }] })), base, 'outra verificação reprovada (identidade estável = id)');
  assert.notEqual(failureSignature(rd(1, { status: 'failed' }, { status: 'failed' })), base, 'outra classe');
  const e = rd(1, {}, { evidence: EV('failed', { expectedFiles: [{ path: 'a.txt', ok: false }] }) }); assert.notEqual(failureSignature(e), base, 'arquivo esperado reprovado entra');
  const o = rd(1); o.report.evidence.reasons = ['arquivo esperado "b.txt": o arquivo não existe']; assert.notEqual(failureSignature(o), base, 'razão diferente');
});

test('prevenção de loop: a MESMA falha já vista bloqueia (enforce) ANTES de outra rodada; sem o guarda só registra; falha diferente não bloqueia', () => {
  const sig = failureSignature(rd(2)), seen = [{ round: 1, action: 'retry', signature: sig }];
  const c = cyc([rd(1), rd(2)], { supervision: seen });
  const d = sv(c, c.rounds[1], { loopGuard: true, retry: { step: { id: 'a' }, cls: 'R1', attempt: 3 } });
  assert.deepEqual([d.action, d.code, d.enforce, d.signature, d.observation.kind, d.observation.repeatedAtRound], ['block', 'supervisor_loop', true, sig, 'falha_repetida', 1]); assert.match(d.reason, /rodada 1.*rodada 2/);
  assert.deepEqual([sv(c, c.rounds[1], { loopGuard: false, retry: { step: { id: 'a' }, cls: 'R1', attempt: 3 } }).action, sv(c, c.rounds[1], { loopGuard: false }).enforce], ['retry', false], 'sem a supervisão ligada não bloqueia');
  const other = cyc([rd(1), rd(2, { stepId: 'b' })], { supervision: seen }); assert.equal(sv(other, other.rounds[1], { loopGuard: true }).enforce, false, 'outra etapa = outra falha');
  const same = cyc([rd(1)], { supervision: [{ round: 1, action: 'retry', signature: sig }] }); assert.equal(sv(same, same.rounds[0], { loopGuard: true }).enforce, false, 'a própria rodada não conta como repetição');
  const blk = cyc([rd(1), rd(2)], { supervision: [{ round: 1, action: 'block', signature: sig }] }); assert.equal(sv(blk, blk.rounds[1], { loopGuard: true }).enforce, false, 'só retry/replan anteriores contam');
});

test('limites puros: tempo total e ausência de saída (0 = desligado; exatamente no limite estoura)', () => {
  assert.equal(timeExceeded(999, 1000), false); assert.equal(timeExceeded(1000, 1000), true); assert.equal(timeExceeded(10 ** 9, 0), false, '0 = sem limite');
  assert.equal(stallExceeded(1500, 1000, 500), true); assert.equal(stallExceeded(1499, 1000, 500), false); assert.equal(stallExceeded(10 ** 9, 1000, 0), false); assert.equal(stallExceeded(10 ** 9, NaN, 5), false, 'sem referência não afirma nada');
});

test('autoResumeDecision: SÓ bloqueio transitório do Planner, dentro do orçamento e sem execução ambígua — cada impedimento tem o seu motivo', () => {
  const ok = (over = {}, world = {}) => autoResumeDecision({ cycle: { status: 'blocked', blockedCode: 'planner_error', rounds: [okRound(1)], approvals: [], supervision: [], ...over }, autoResumes: 2, world });
  assert.deepEqual([ok().ok, ok().used], [true, 0]); assert.equal(ok({ blockedCode: 'planner_invalid' }).ok, true);
  const no = (label, d, re) => { assert.equal(d.ok, false, label); assert.match(d.reason, re, label); };
  no('desligado', autoResumeDecision({ cycle: { status: 'blocked', blockedCode: 'planner_error', rounds: [] }, autoResumes: 0 }), /desligada/);
  for (const code of ['restarted', 'approval_required', 'needs_approval', 'integrity_review', 'planner_blocked', 'cost_budget_reached', 'planner_call_cap', 'planner_calls_limit', 'verification_blocked', 'interrupted', 'stalled', 'time_limit', 'supervisor_loop', 'persistence_failed', 'internal_error', 'no_progress', 'executor_failures', 'plan_invalid']) no(code, ok({ blockedCode: code }), /não é um bloqueio transitório do Planner/);
  no('não bloqueado', ok({ status: 'running' }), /não está bloqueado/); no('cancelamento', ok({ cancelRequested: true }), /cancelamento/);
  no('orçamento', ok({ supervision: [{ action: 'resume' }, { action: 'resume' }] }), /orçamento de 2.*esgotado/); assert.equal(ok({ supervision: [{ action: 'resume' }] }).ok, true, 'a 2ª ainda cabe'); assert.equal(ok({ supervision: [{ action: 'block' }, { action: 'retry' }] }).used, 0, 'só "resume" gasta o orçamento');
  no('aprovação pendente', ok({ approvals: [{ status: 'pending' }] }), /aprovação pendente/); no('rodada incerta', ok({ rounds: [rd(1, {}, { outcomeUncertain: 'x' })] }), /ambígua/); no('rodada interrompida', ok({ rounds: [rd(1, { status: 'interrupted' })] }), /ambígua/); no('rodada em andamento', ok({ rounds: [rd(1, { status: 'running' })] }), /ambígua/);
  no('integridade pendente', ok({ integrity: { pending: [{ path: 't' }] } }), /revisão/); no('executor ocupado', ok({}, { executorBusy: true }), /execução em andamento/); no('tarefa rodando', ok({}, { runningTask: true }), /execução em andamento/);
  no('planner ocupado', ok({}, { plannerBusy: true }), /Planner está ocupado/); no('limite', ok({}, { limitReason: 'orçamento de custo atingido' }), /orçamento de custo atingido/);
});

test('configuração da supervisão: padrão tudo desligado; ambiente > configurações > padrão; ambiente inválido lança; configuração inválida é ignorada; minutos viram milissegundos', () => {
  const D = { supervisor: false, maxMinutes: 0, stallMinutes: 0, autoResumes: 0, source: { supervisor: 'default', maxMinutes: 'default', stallMinutes: 'default', autoResumes: 'default' } };
  assert.deepEqual(resolveSupervision({ env: {}, settings: {} }), D); assert.deepEqual(resolveSupervision({ env: {} }), D);
  assert.deepEqual(resolveSupervision({ env: {}, settings: { supervisor: true, maxMinutes: 30, stallMinutes: 5, autoResumes: 2 } }), { supervisor: true, maxMinutes: 30, stallMinutes: 5, autoResumes: 2, source: { supervisor: 'settings', maxMinutes: 'settings', stallMinutes: 'settings', autoResumes: 'settings' } });
  const mix = resolveSupervision({ env: { ORCH_CYCLE_SUPERVISOR: 'off', ORCH_CYCLE_MAX_MINUTES: '10', ORCH_CYCLE_AUTO_RESUMES: '0' }, settings: { supervisor: true, maxMinutes: 30, stallMinutes: 5, autoResumes: 2 } });
  assert.deepEqual([mix.supervisor, mix.maxMinutes, mix.stallMinutes, mix.autoResumes], [false, 10, 5, 0]); assert.deepEqual(mix.source, { supervisor: 'env', maxMinutes: 'env', stallMinutes: 'settings', autoResumes: 'env' });
  for (const env of [{ ORCH_CYCLE_SUPERVISOR: 'talvez' }, { ORCH_CYCLE_MAX_MINUTES: '1441' }, { ORCH_CYCLE_MAX_MINUTES: 'x' }, { ORCH_CYCLE_MAX_MINUTES: '-5' }, { ORCH_CYCLE_STALL_MINUTES: '241' }, { ORCH_CYCLE_STALL_MINUTES: '1.5' }, { ORCH_CYCLE_AUTO_RESUMES: '3' }, { ORCH_CYCLE_AUTO_RESUMES: 'sim' }]) assert.throws(() => resolveSupervision({ env }), /ORCH_CYCLE_/, JSON.stringify(env));
  assert.deepEqual(resolveSupervision({ env: { ORCH_CYCLE_MAX_MINUTES: ' off ', ORCH_CYCLE_STALL_MINUTES: '0', ORCH_CYCLE_AUTO_RESUMES: '' } }).source, { supervisor: 'default', maxMinutes: 'env', stallMinutes: 'env', autoResumes: 'default' });
  for (const settings of [{ supervisor: 'on', maxMinutes: -1, stallMinutes: 241, autoResumes: 3 }, { maxMinutes: 1.5, autoResumes: '1' }, null, []]) assert.deepEqual(resolveSupervision({ env: {}, settings }), D, JSON.stringify(settings));
  assert.deepEqual(supervisionMs({ supervisor: true, maxMinutes: 2, stallMinutes: 1, autoResumes: 2 }), { enabled: true, maxMs: 120000, stallMs: 60000, autoResumes: 2 }); assert.deepEqual(supervisionMs(resolveSupervision({ env: {} })), { enabled: false, maxMs: 0, stallMs: 0, autoResumes: 0 });
});

// =====================================================================================================================
// 2. interface (módulo puro)
// =====================================================================================================================
test('supervisionView: cada decisão com ação, observação, motivo, assinatura e orçamento do que o servidor gravou; malformado é ignorado', () => {
  const rows = view.supervisionView([
    { at: 'T', round: 1, step: 'a', observation: { kind: 'verificacao_reprovada' }, action: 'retry', code: 'R1', reason: 'Falha recuperável', signature: 'abc123', budget: { retriesUsed: 0, retriesMax: 1, autoResumes: 0, autoResumesMax: 0, plannerCalls: 1, activeMinutes: 0.5 } },
    { round: 2, observation: { kind: 'falha_repetida' }, action: 'block', reason: 'Repetida', signature: 'abc123', budget: { retriesUsed: 1, retriesMax: 1 } },
    { round: 2, observation: { kind: 'sem_saida', uncertain: true }, action: 'block', reason: 'sem saída' }, { round: 3, action: 'resume', reason: 'auto', budget: { autoResumes: 1, autoResumesMax: 2 } },
    null, 'x', { action: 7 }, { round: 4, action: 'inventada', reason: 'r', observation: { kind: 'inventado' } },
  ]);
  assert.deepEqual(rows.map((r) => [r.round, r.action, r.status, r.actionLabel]), [[1, 'retry', 'unverified', 'repetir (retentativa)'], [2, 'block', 'blocked', 'bloquear'], [2, 'block', 'blocked', 'bloquear'], [3, 'resume', 'running', 'retomada automática'], [4, 'inventada', 'idle', 'inventada']]);
  assert.deepEqual([rows[0].observationLabel, rows[0].step, rows[0].signature, rows[0].reason], ['verificação real reprovada', 'a', 'abc123', 'Falha recuperável']); assert.equal(rows[0].budget, 'retentativas 0/1 · consultas ao Planner 1 · tempo ativo 0.5 min');
  assert.equal(rows[1].observationLabel, 'falha repetida'); assert.equal(rows[1].budget, 'retentativas 1/1'); assert.deepEqual([rows[2].uncertain, rows[2].observationLabel], [true, 'execução sem saída']); assert.equal(rows[3].budget, 'retomadas automáticas 1/2');
  assert.equal(rows[4].observationLabel, 'inventado', 'tipo desconhecido aparece como veio, sem inventar rótulo'); assert.deepEqual(view.supervisionView(undefined), []); assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'chaves únicas');
  assert.equal(view.budgetText(null), null); assert.equal(view.budgetText({}), null);
  // fidelidade da trilha: recomendação (action) x o que aconteceu (applied) x tendência
  const fid = view.supervisionView([
    { round: 1, action: 'retry', observation: { kind: 'verificacao_reprovada', trend: 'first' }, applied: { state: 'completed', round: 2, result: { execution: 'succeeded', verification: 'passed', evidence: 'verified' } } },
    { round: 2, action: 'retry', observation: { kind: 'verificacao_reprovada', trend: 'progress' }, applied: { state: 'not_applied', by: 'retry_blocker', reason: 'o Git mudou' } },
    { round: 3, action: 'replan', observation: { kind: 'politica_recusada' }, applied: { state: 'completed', by: 'planner', result: { decision: 'continue' } } },
    { round: 4, action: 'block', observation: { kind: 'recusa_repetida', trend: 'none' }, applied: { state: 'stopped', by: 'supervisor_loop' } },
    { round: 5, action: 'complete', applied: { state: 'n/a' } }, { round: 6, action: 'replan', applied: { state: 'inventado' } }, { round: 7, action: 'replan', observation: { trend: 'inventada' } },
  ]);
  assert.deepEqual(fid.map((r) => [r.appliedState, r.trend]), [['completed', null], ['not_applied', 'progress'], ['completed', null], ['stopped', 'none'], ['n/a', null], ['inventado', null], [null, null]]);
  assert.equal(fid[0].appliedLabel, 'concluída · rodada 2: execução succeeded, verificação passed, evidência verified'); assert.equal(fid[1].appliedLabel, 'NÃO aplicada · por retry_blocker · o Git mudou'); assert.equal(fid[2].appliedLabel, 'concluída · o Planner decidiu: continue · por planner');
  assert.equal(fid[3].appliedLabel, 'o ciclo parou · por supervisor_loop'); assert.equal(fid[4].appliedLabel, null, 'n/a: nada a aplicar'); assert.equal(fid[5].appliedLabel, null, 'estado desconhecido não é inventado'); assert.equal(fid[6].trendLabel, null);
  assert.match(fid[1].trendLabel, /progresso verificável/); assert.match(fid[3].trendLabel, /sem progresso/); assert.equal(fid[2].observationLabel, 'proposta recusada pela política'); assert.equal(fid[3].observationLabel, 'proposta equivalente recusada de novo');
  assert.equal(view.appliedText(null), null); assert.equal(view.appliedText({ state: 'started', round: 3 }), 'iniciada · rodada 3');
});

test('supervisionForm: valores, origem, travas do ambiente e ciclo ativo; opção atual sempre presente; ausência do servidor => null', () => {
  const S = (over = {}, src = {}) => ({ supervisor: false, maxMinutes: 0, stallMinutes: 0, autoResumes: 0, source: { supervisor: 'default', maxMinutes: 'default', stallMinutes: 'default', autoResumes: 'default', ...src }, ...over });
  const f = view.supervisionForm(S()); assert.deepEqual([f.supervisor.value, f.supervisor.sourceLabel, f.supervisor.disabled, f.maxMinutes.disabled], [false, 'padrão (desligado)', false, false]);
  const env = view.supervisionForm(S({ maxMinutes: 7 }, { maxMinutes: 'env' })); assert.deepEqual([env.maxMinutes.locked, env.maxMinutes.disabled], [true, true]); assert.match(env.maxMinutes.reason, /ORCH_CYCLE_MAX_MINUTES.*altere o ambiente/); assert.ok(env.maxChoices.includes(7), 'o valor real aparece mesmo fora da lista'); assert.equal(env.supervisor.locked, false);
  const busy = view.supervisionForm(S(), { activeCycle: true }); assert.ok([busy.supervisor, busy.maxMinutes, busy.stallMinutes, busy.autoResumes].every((x) => x.disabled && /ciclo em andamento/.test(x.reason)));
  assert.deepEqual(view.supervisionForm(S()).maxChoices, [0, 15, 30, 60, 120, 240, 480, 1440]); assert.deepEqual(view.supervisionForm(S()).resumeChoices, [0, 1, 2]); assert.match(f.notes.join(' '), /nunca pelo texto do Planner/); assert.match(f.notes.join(' '), /NÃO prova inatividade/); assert.match(f.notes.join(' '), /Não existe rollback/);
  for (const bad of [undefined, null, {}, S({ supervisor: 'on' }), S({ maxMinutes: 'x' }), []]) assert.equal(view.supervisionForm(bad), null);
  assert.deepEqual([view.minutesLabel(0), view.minutesLabel(15), view.minutesLabel(60), view.minutesLabel(90), view.minutesLabel(120)], ['desligado (padrão)', '15 min', '1 h', '90 min', '2 h']); assert.deepEqual([view.resumeLabel(0), view.resumeLabel(1), view.resumeLabel(2)], ['desligada (padrão)', '1 retomada por ciclo', '2 retomadas por ciclo']);
});

// =====================================================================================================================
// 3. ciclo em processo
// =====================================================================================================================
const J = (o) => JSON.stringify(o);
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
/** Roteiro de respostas do Planner; um item { error } simula falha do próprio Planner (transitória). */
const planner = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, describeTier: () => null, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : typeof x === 'object' ? x : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) } }; } }; };
const step = (id, file, mode = 'produce') => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: [] });
const planAns = (...steps) => J({ decision: 'plan', rationale: 'dividir em etapas', steps });
const done = () => J({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => J({ decision: 'blocked', rationale: 'ajuda', blockedReason: 'decisão humana' });
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => { verCalls++; const bad = verFail(verCalls); return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: bad ? 'fail' : 'pass', exitCode: bad ? 1 : 0, durationMs: 5, outputTail: bad ? 'falhou: 1 teste' : '', truncated: false, reason: bad ? 'Terminou com código 1' : null }; } });
const mkCycle = (pl, { retries = 0, supervision = null, tickMs = 100, limits = null } = {}) => createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true, stepRetries: retries, supervision, watchdogTickMs: tickMs, limits, persistRetryMs: [1] });
const mkMission = () => { const m = { id: `s${++seq}`, demo: false, title: `M${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
function resetWs() { for (const f of fs.readdirSync(wsDir)) if (f !== '.git') fs.rmSync(path.join(wsDir, f), { recursive: true, force: true }); }
async function run(answers, opts = {}, { max = 6, fail = () => false } = {}) {
  resetWs(); verCalls = 0; verFail = fail; const s0 = execStarts;
  const m = mkMission(), pl = planner(answers), cy = mkCycle(pl, opts);
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, pl, starts: () => execStarts - s0, db: () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id) };
}
const acts = (m, re) => db.activity.filter((a) => a.missionId === m.id && re.test(a.message));
const ON = { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 0 };

test('PADRÃO DESLIGADO: sem habilitar nada o ciclo não grava supervision nem activeMs e se comporta como antes (falha repetida cai no Planner)', async () => {
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1 }, { fail: () => true });
  assert.equal(x.starts(), 2); assert.equal(x.pl.calls.length, 2, 'o Planner é consultado depois da retentativa, como no Marco A'); assert.equal(x.c.blockedCode, 'planner_blocked');
  assert.ok(!('supervision' in x.c) && !('activeMs' in x.c), 'nenhum campo novo no ciclo'); assert.doesNotMatch(x.pl.calls[1], /SUPERVISÃO/);
});

test('falha REPETIDA: a retentativa falha igual => supervisor_loop ANTES de outra rodada, sem consultar o Planner; decisões registradas e gravadas', async () => {
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { fail: () => true });
  assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'supervisor_loop'); assert.match(x.c.blockedReason, /mesma falha.*rodada 1.*rodada 2/);
  assert.equal(x.starts(), 2, 'duas execuções e nenhuma a mais'); assert.equal(x.c.rounds.length, 2); assert.equal(x.pl.calls.length, 1, 'só o plano: o Planner não foi consultado depois do bloqueio');
  assert.deepEqual(x.c.supervision.map((e) => [e.round, e.action, e.code]), [[1, 'retry', 'R1'], [2, 'block', 'supervisor_loop']]);
  const [e1, e2] = x.c.supervision; assert.equal(e1.signature, e2.signature); assert.match(e1.signature, /^[0-9a-f]{16}$/); assert.deepEqual([e1.step, e1.observation.kind, e2.observation.kind, e2.observation.repeatedAtRound], ['a', 'verificacao_reprovada', 'falha_repetida', 1]);
  assert.deepEqual([e1.budget.retriesUsed, e1.budget.retriesMax, e2.budget.retriesUsed, e2.budget.plannerCalls], [0, 1, 1, 1], 'orçamento usado em cada decisão'); assert.ok(e1.at && e1.reason);
  assert.deepEqual(x.db().cycle.supervision, x.c.supervision, 'o histórico está no disco'); assert.deepEqual(x.c.rounds.map((r) => [r.n, r.stepId, r.verification]), [[1, 'a', 'failed'], [2, 'a', 'failed']]);
  // recuperação idempotente: reiniciar sobre o disco não repete nada nem altera o histórico
  const before = JSON.stringify(x.db().cycle), s0 = execStarts; db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor }));
  const cy2 = mkCycle(planner([]), { retries: 1, supervision: ON }); cy2.recover(); cy2.recover(); await cy2.idle();
  assert.equal(JSON.stringify(db.missions.find((m) => m.id === x.m.id).cycle), before, 'recover() repetido não muda o ciclo'); assert.equal(execStarts, s0, 'a recuperação não executa nada'); assert.equal(JSON.stringify(x.db().cycle), before);
});

test('falha DIFERENTE não é loop: a 2ª rodada falha por outro motivo e segue o fluxo (replan => Planner), com a decisão registrada', async () => {
  let k = 0; const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { fail: () => ++k === 1 }); // 1ª: verificação reprova; 2ª: passa
  assert.equal(x.c.rounds.length, 2); assert.deepEqual(x.c.supervision.map((e) => [e.round, e.action]), [[1, 'retry'], [2, 'complete']]); assert.equal(x.c.blockedCode, 'planner_blocked', 'o plano acabou e o Planner (simulado) bloqueou: nada a ver com loop');
});

test('replan: sem orçamento de retentativas a decisão é replanejar; o Planner recebe o diagnóstico FACTUAL e a mesma falha em outra tarefa é bloqueada', async () => {
  const cont = (t) => J({ decision: 'continue', rationale: t, task: { title: t, instructions: `MODE:produce FILE:b.txt ${t}`, acceptance: ['b.txt existe'], expectedFiles: ['b.txt'] } });
  const x = await run([planAns(step('a', 'a.txt')), cont('tentar de outro jeito'), blockedAns()], { retries: 0, supervision: ON }, { fail: () => true });
  assert.deepEqual(x.c.supervision.slice(0, 1).map((e) => [e.round, e.action, e.observation.kind]), [[1, 'replan', 'verificacao_reprovada']]);
  assert.match(x.pl.calls[1], /SUPERVISÃO \(decisões determinísticas.*nunca autoriza uma ação por si só\)/); assert.match(x.pl.calls[1], /\[rodada 1\] observação: verificacao_reprovada \| ação: replan \| assinatura da falha: [0-9a-f]{16}/);
  assert.equal(x.c.rounds.length, 2, 'a tarefa avulsa nova rodou (é outra etapa); não foi loop'); assert.equal(x.c.supervision[1].action, 'replan');
  const again = await run([planAns(step('a', 'a.txt')), cont('um'), cont('dois'), blockedAns()], { retries: 0, supervision: ON }, { fail: () => true });
  assert.equal(again.c.blockedCode, 'supervisor_loop', 'tarefas avulsas diferentes que falham IGUAL: a 3ª repetição da mesma falha avulsa bloqueia'); assert.equal(again.c.rounds.length, 3);
});

test('supervisor sozinho (sem retentativas, sem limites): o retry só acontece pelo mecanismo do Marco A — nunca por um segundo caminho', async () => {
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 0, supervision: ON }, { fail: () => true });
  assert.equal(x.starts(), 1); assert.deepEqual(x.c.supervision.map((e) => e.action), ['replan']); assert.equal(x.c.blockedCode, 'planner_blocked');
  assert.equal(acts(x.m, /Reparo automático da etapa/).length, 0);
});

test('LIMITE TOTAL de duração: estoura com a execução em andamento => interrompe, preserva o estado como INCERTO, registra, bloqueia e não retoma além do limite', async () => {
  const x = await run([planAns(step('a', 'a.txt', 'sleep')), blockedAns()], { retries: 2, supervision: { enabled: false, maxMs: 700, stallMs: 0, autoResumes: 0 } });
  assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'time_limit'); assert.match(x.c.blockedReason, /Limite de duração do ciclo atingido/); assert.equal(x.starts(), 1, 'nada foi reexecutado'); assert.equal(executor.isBusy(), false, 'o processo foi encerrado');
  const r = x.c.rounds[0]; assert.deepEqual([r.status, r.report.status], ['interrupted', 'interrupted']); assert.match(r.report.outcomeUncertain, /limite de duração do ciclo.*incerto/); assert.equal(x.c.plan.steps[0].uncertain, true);
  assert.equal(x.m.tasks[0].status, 'interrupted'); assert.ok(x.c.activeMs >= 700, `tempo ativo acumulado (${x.c.activeMs})`);
  assert.deepEqual(x.c.supervision.map((e) => [e.action, e.code, e.observation.kind]), [['block', 'time_limit', 'tempo_esgotado']]); assert.equal(x.pl.calls.length, 1, 'o Planner não foi consultado de novo');
  const res = await x.cy.resume(x.m.id); assert.equal(res.status, 409); assert.match(res.error, /limite de duração total do ciclo.*já foi atingido/); assert.equal(x.c.status, 'blocked', 'a retomada recusada não mudou nada');
  // com o limite aumentado a retomada volta a ser aceita (o histórico e a evidência foram mantidos)
  const startsBefore = execStarts, cy2 = mkCycle(planner([blockedAns()]), { retries: 2, supervision: { enabled: false, maxMs: 60000, stallMs: 0, autoResumes: 0 } }); const r2 = await cy2.resume(x.m.id); assert.equal(r2.status, 202); await cy2.idle();
  assert.equal(x.c.rounds.length, 1, 'a etapa interrompida/incerta não foi refeita'); assert.equal(execStarts, startsBefore, 'nenhuma execução nova'); assert.equal(x.c.blockedCode, 'planner_blocked', 'o Planner decidiu (sem etapa elegível)');
});

test('EXECUÇÃO SEM SAÍDA: interrompe pelo caminho do cancelamento, registra que o estado real é DESCONHECIDO, trata como incerto e NUNCA repete (mesmo com retentativas ligadas)', async () => {
  const x = await run([planAns(step('a', 'a.txt', 'sleep')), done()], { retries: 2, supervision: { enabled: true, maxMs: 0, stallMs: 600, autoResumes: 2 } });
  assert.equal(x.c.blockedCode, 'stalled'); assert.match(x.c.blockedReason, /sem nenhuma saída.*não prova inatividade.*DESCONHECIDO.*INCERTO/); assert.equal(x.starts(), 1); assert.equal(executor.isBusy(), false);
  const r = x.c.rounds[0]; assert.equal(r.status, 'interrupted'); assert.match(r.report.outcomeUncertain, /por falta de saída.*não se sabe se estava ociosa ou trabalhando/); assert.equal(x.c.plan.steps[0].status, 'interrupted'); assert.equal(x.c.plan.steps[0].uncertain, true);
  assert.deepEqual(x.c.supervision.map((e) => [e.action, e.code, e.observation.kind, e.observation.uncertain]), [['block', 'stalled', 'sem_saida', true]]);
  assert.equal(x.pl.calls.length, 1, 'o Planner não foi consultado'); assert.ok(!x.c.supervision.some((e) => e.action === 'resume'), '"stalled" nunca é retomado automaticamente'); assert.equal(acts(x.m, /Reparo automático da etapa/).length, 0);
});

test('sem falso positivo: execução que produz saída dentro do limite de ausência de saída e dentro do tempo total conclui normalmente', async () => {
  const x = await run([planAns(step('a', 'a.txt', 'slowproduce')), done()], { retries: 0, supervision: { enabled: true, maxMs: 60000, stallMs: 30000, autoResumes: 0 } });
  assert.equal(x.c.status, 'completed'); assert.equal(x.c.assurance, 'verified'); assert.ok(!x.c.supervision.some((e) => e.action === 'block')); assert.deepEqual(x.c.supervision.map((e) => e.action), ['complete']);
  assert.ok(x.c.activeMs >= 2000 && x.c.activeMs < 30000, `tempo ativo gravado só com o limite de tempo ligado (${x.c.activeMs})`);
});

test('RETOMADA AUTOMÁTICA: falhas transitórias do Planner são retomadas até 2 vezes e o ciclo conclui; cada retomada fica registrada com o orçamento', async () => {
  const x = await run([{ error: 'falha transitória 1' }, { error: 'falha transitória 2' }, planAns(step('a', 'a.txt')), done()], { retries: 0, supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } });
  assert.equal(x.c.status, 'completed', `${x.c.blockedCode}: ${x.c.blockedReason}`); assert.equal(x.pl.calls.length, 4);
  const resumes = x.c.supervision.filter((e) => e.action === 'resume'); assert.deepEqual(resumes.map((e) => [e.code, e.budget.autoResumes, e.budget.autoResumesMax]), [['auto_resume', 0, 2], ['auto_resume', 1, 2]]);
  assert.match(resumes[0].reason, /Retomada automática 1 de 2/); assert.match(resumes[1].reason, /Retomada automática 2 de 2/); assert.equal(acts(x.m, /retomado automaticamente pela supervisão/).length, 2); assert.equal(acts(x.m, /retomado por um humano/).length, 0);
  assert.equal(x.c.rounds.length, 1); assert.deepEqual(x.db().cycle.supervision.filter((e) => e.action === 'resume').length, 2);
});

test('retomada automática: o LIMITE de 2 vale — a 3ª falha transitória fica bloqueada, com o motivo registrado e sem nenhuma execução', async () => {
  const x = await run([{ error: 'f1' }, { error: 'f2' }, { error: 'f3' }, planAns(step('a', 'a.txt'))], { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } });
  assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'planner_error'); assert.equal(x.pl.calls.length, 3, 'o 4º item do roteiro nunca foi pedido'); assert.equal(x.starts(), 0); assert.equal(x.c.rounds.length, 0);
  assert.deepEqual(x.c.supervision.map((e) => [e.action, e.code]), [['resume', 'auto_resume'], ['resume', 'auto_resume'], ['block', 'auto_resume_refused']]); assert.match(x.c.supervision[2].reason, /Retomada automática NÃO feita: orçamento de 2.*esgotado/);
});

test('retomada automática: NUNCA para bloqueios que exigem decisão (o Planner pediu ajuda, aprovação, política, execução incerta) — fica bloqueado sem tentar', async () => {
  const x = await run([planAns(step('a', 'a.txt')), blockedAns(), done()], { retries: 0, supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } }, { fail: () => true });
  assert.equal(x.c.blockedCode, 'planner_blocked'); assert.equal(x.pl.calls.length, 2, 'não houve nova consulta'); assert.ok(!x.c.supervision.some((e) => e.action === 'resume' || e.code === 'auto_resume_refused'), 'nem tentativa nem recusa registrada: não era candidato');
  const s = await run([planAns(step('a', 'a.txt', 'sleep')), done()], { retries: 0, supervision: { enabled: true, maxMs: 0, stallMs: 500, autoResumes: 2 } });
  assert.equal(s.c.blockedCode, 'stalled'); assert.equal(s.pl.calls.length, 1); assert.equal(s.starts(), 1);
});

test('retomada automática: respeita os limites existentes — com o teto de chamadas do Planner atingido ela é recusada e registrada', async () => {
  const x = await run([{ error: 'f1' }, { error: 'f2' }, planAns(step('a', 'a.txt')), done()], { limits: { maxPlannerCalls: 1, maxEstimatedCostUsd: null }, supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } });
  assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'planner_error'); assert.equal(x.pl.calls.length, 1, 'nenhuma nova consulta'); assert.equal(x.c.rounds.length, 0);
  assert.deepEqual(x.c.supervision.map((e) => [e.action, e.code]), [['block', 'auto_resume_refused']]); assert.match(x.c.supervision[0].reason, /Retomada automática NÃO feita: Limite de 1 chamada/);
});

test('RECUPERAÇÃO: depois de reiniciar o servidor com o ciclo bloqueado por retomada recusada, nada é retomado nem executado por causa do boot', async () => {
  const x = await run([{ error: 'f1' }, { error: 'f2' }, { error: 'f3' }], { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } });
  const before = JSON.stringify(x.db().cycle), s0 = execStarts; db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor }));
  const pl2 = planner([planAns(step('a', 'a.txt'))]), cy2 = mkCycle(pl2, { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 } }); cy2.recover(); await cy2.idle();
  assert.equal(JSON.stringify(db.missions.find((m) => m.id === x.m.id).cycle), before); assert.equal(pl2.calls.length, 0, 'o boot não consulta o Planner'); assert.equal(execStarts, s0);
});

// =====================================================================================================================
// Microajustes finais: orçamento de retomadas fora do log visível e desfecho da retomada automática
// =====================================================================================================================
test('ORÇAMENTO de retomadas separado do log: com >60 eventos e o log truncado o limite de 2 continua valendo, inclusive após reiniciar; ciclo antigo (só log) é compatível', async () => {
  const SUP = { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 };
  const x = await run([{ error: 'f1' }, { error: 'f2' }, { error: 'f3' }], { supervision: SUP });
  assert.equal(x.c.blockedCode, 'planner_error'); assert.equal(x.c.supControl.resumes, 2); assert.equal(x.c.supervision.filter((e) => e.action === 'resume').length, 2);
  // desfecho das retomadas aceitas: concluídas (a retomada), nunca "stopped" pelo fim do laço retomado
  assert.deepEqual(x.c.supervision.filter((e) => e.action === 'resume').map((e) => [e.applied.state, e.applied.by]), [['completed', 'resume'], ['completed', 'resume']]);
  // simula a retenção do log: 70 eventos de enchimento no lugar de tudo (as retomadas somem do log)
  x.c.supervision = Array.from({ length: 70 }, (_, i) => ({ at: 'T', round: 1, step: null, observation: { kind: 'x' }, action: 'block', code: 'enchimento', reason: `e${i}`, signature: null, applied: { state: 'stopped' } }));
  const pl2 = planner([{ error: 'f4' }, planAns(step('a', 'a.txt'))]), cy2 = mkCycle(pl2, { supervision: SUP }); const r = await cy2.resume(x.m.id); assert.equal(r.status, 202); await cy2.idle();
  assert.equal(pl2.calls.length, 1, 'nenhuma retomada automática nova: o 2º item do roteiro nunca foi pedido'); assert.equal(x.c.blockedCode, 'planner_error'); assert.ok(x.c.supervision.length <= 60, 'log continua limitado');
  assert.equal(x.c.supervision.filter((e) => e.action === 'resume').length, 0, 'as retomadas saíram do log'); assert.equal(x.c.supControl.resumes, 2); const last = x.c.supervision.at(-1); assert.deepEqual([last.code, last.action], ['auto_resume_refused', 'block']); assert.match(last.reason, /orçamento de 2.*esgotado/);
  // reinício: o orçamento persistido não zera e nada é retomado
  assert.equal(x.db().cycle.supControl.resumes, 2); db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor })); const pl3 = planner([planAns(step('a', 'a.txt'))]), cy3 = mkCycle(pl3, { supervision: SUP }); cy3.recover(); await cy3.idle();
  assert.equal(pl3.calls.length, 0); assert.equal(db.missions.find((m) => m.id === x.m.id).cycle.supControl.resumes, 2);
  // ciclo gravado antes de existir supControl: o log ainda conta e o controle é inicializado a partir dele
  const old = await run([{ error: 'g1' }, { error: 'g2' }, { error: 'g3' }], { supervision: SUP }); delete old.c.supControl;
  const pl4 = planner([{ error: 'g4' }, planAns(step('a', 'a.txt'))]), cy4 = mkCycle(pl4, { supervision: SUP }); assert.equal((await cy4.resume(old.m.id)).status, 202); await cy4.idle();
  assert.equal(pl4.calls.length, 1, 'o orçamento do log antigo foi respeitado'); assert.equal(old.c.supControl.resumes, 2);
});

test('retomada automática aceita fecha como "completed" e nada a faz voltar a "started" depois (o laço retomado não fecha a decisão do chamador)', async () => {
  const x = await run([{ error: 'f1' }, planAns(step('a', 'a.txt')), done()], { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 1 } });
  assert.equal(x.c.status, 'completed'); const res = x.c.supervision.filter((e) => e.action === 'resume'); assert.equal(res.length, 1); assert.deepEqual([res[0].applied.state, res[0].applied.by], ['completed', 'resume']);
  assert.ok(x.c.supervision.every((e) => !['pending', 'started'].includes(e.applied?.state)), JSON.stringify(x.c.supervision.map((e) => e.applied)));
});

// =====================================================================================================================
// Última rodada: decisão "resume" nunca presa; regressões das mutações M10, M12, M14, M15, M16; falha de gravação na retomada
// =====================================================================================================================
const SUP2 = { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 2 };
const TMP_BLOCK = () => `${DB_FILE}.tmp`; // um DIRETÓRIO no lugar do temporário faz o save() falhar na hora (erro de E/S real, sem espera)
const isAutoWindow = () => { const c = db.missions.at(-1)?.cycle; return c?.status === 'blocked' && c.blockedCode === 'planner_error'; };
const until = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(10); return cond(); };

test('M12 — o ciclo REAL grava as assinaturas em supControl.sigs (memória própria, persistida), sem ninguém injetá-las', async () => {
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { fail: () => true });
  const retry = x.c.supervision.find((e) => e.action === 'retry'); assert.ok(retry?.signature);
  assert.deepEqual(x.c.supControl, { resumes: 0, sigs: { [retry.signature]: { round: 1, action: 'retry' } } }, 'só retry/replan com assinatura; o bloqueio (block) não entra');
  assert.deepEqual(x.db().cycle.supControl, x.c.supControl, 'gravado em disco');
  // com o log inteiro descartado, a mesma falha na rodada seguinte ainda é reconhecida pelo estado de controle
  x.c.supervision = []; const again = superviseRound({ cycle: x.c, round: { ...x.c.rounds[1], n: 3 }, loopGuard: true }); assert.deepEqual([again.enforce, again.code], [true, 'supervisor_loop']);
});

test('M16/M15 — "started" é gravado ANTES de resume(); uma decisão que já foi fechada nunca é reaberta nem sobrescrita', async () => {
  let calls = 0, seen = null, entry = null;
  onBusy = () => { if (!isAutoWindow()) return; if (++calls === 2) { entry = db.missions.at(-1).cycle.supervision.find((e) => e.action === 'resume'); seen = entry.applied.state; entry.applied = { state: 'stopped', by: 'outro', reason: 'fechada por outro caminho' }; } }; // 2ª chamada = dentro de resume()
  try {
    const x = await run([{ error: 'f1' }, blockedAns()], { supervision: SUP2 }); assert.equal(await until(() => x.pl.calls.length === 2), true, 'a retomada ocorreu'); await x.cy.idle(); await sleep(50);
    assert.equal(seen, 'started', 'a decisão já estava "started" quando resume() foi chamado (M16)');
    assert.deepEqual([entry.applied.state, entry.applied.by], ['stopped', 'outro'], 'o "completed" posterior NÃO sobrescreve uma decisão já fechada (M15)');
  } finally { onBusy = null; }
});

test('M10 — o fim de um laço NÃO fecha a decisão "resume" de outro dono (autoResume); fecha as demais pendentes', async () => {
  const x = await run([{ error: 'f1' }], { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 0 } }); assert.equal(x.c.blockedCode, 'planner_error');
  const E = (over) => ({ at: 'T', round: 0, step: null, observation: { kind: 'x' }, reason: 'semeada', signature: null, budget: {}, ...over });
  (x.c.supervision ??= []).push(E({ action: 'resume', code: 'auto_resume', applied: { state: 'started', by: 'resume' } }), E({ action: 'replan', code: 'replan', applied: { state: 'pending' } }));
  const cy2 = mkCycle(planner([blockedAns()]), { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 0 } }); assert.equal((await cy2.resume(x.m.id)).status, 202); await cy2.idle();
  const [res, rep] = x.c.supervision.slice(-2); assert.equal(res.action, 'resume'); assert.equal(res.applied.state, 'started', 'o laço retomado não é dono desta decisão');
  assert.deepEqual([rep.action, rep.applied.state], ['replan', 'not_applied'], 'a pendente comum foi fechada');
});

test('M14 / falha de GRAVAÇÃO na retomada: nada é retomado, o orçamento é devolvido e memória, disco e auditoria ficam coerentes', async () => {
  let fired = false;
  onBusy = () => { if (!fired && isAutoWindow()) { fired = true; fs.mkdirSync(TMP_BLOCK()); } }; // 1ª chamada = do próprio autoResume, antes de registrar a decisão
  try {
    const x = await run([{ error: 'f1' }, planAns(step('a', 'a.txt')), done()], { supervision: SUP2 }); await sleep(100);
    assert.equal(fired, true); assert.equal(x.pl.calls.length, 1, 'nenhuma retomada (o 2º item do roteiro nunca foi pedido)'); assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'planner_error');
    assert.equal(x.c.supControl?.resumes ?? 0, 0, 'orçamento devolvido (M14)'); assert.equal(x.c.supervision.filter((e) => e.action === 'resume').length, 0, 'nenhuma decisão fantasma na auditoria');
    fs.rmSync(TMP_BLOCK(), { recursive: true, force: true }); store.saveOrThrow(); // o disco volta a gravar: o que está em memória é o que vai para o disco
    assert.deepEqual(x.db().cycle.supControl ?? { resumes: 0 }, x.c.supControl ?? { resumes: 0 }); assert.deepEqual(x.db().cycle.supervision, x.c.supervision);
    // e o orçamento inteiro (2) continua disponível para uma retomada humana seguida de falha transitória
    const pl2 = planner([{ error: 'f2' }, { error: 'f3' }, { error: 'f4' }]), cy2 = mkCycle(pl2, { supervision: SUP2 }); assert.equal((await cy2.resume(x.m.id)).status, 202); await cy2.idle(); await until(() => pl2.calls.length === 3);
    assert.equal(pl2.calls.length, 3, 'as 2 retomadas automáticas ainda existiam'); assert.equal(x.c.supControl.resumes, 2);
  } finally { onBusy = null; fs.rmSync(TMP_BLOCK(), { recursive: true, force: true }); }
});

test('resume() LANÇA exceção depois de "started": a decisão fecha como incerta (stopped/resume_error), nada é relançado e o orçamento já gasto não volta', async () => {
  let calls = 0; onBusy = () => { if (isAutoWindow() && ++calls === 2) throw new Error('falha simulada em resume'); };
  try {
    const x = await run([{ error: 'f1' }, planAns(step('a', 'a.txt')), done()], { supervision: SUP2 }); const res = () => x.c.supervision.find((e) => e.action === 'resume');
    assert.equal(await until(() => res()?.applied.state === 'stopped'), true, JSON.stringify(res()?.applied));
    assert.deepEqual([res().applied.by, x.c.status, x.c.blockedCode, x.pl.calls.length], ['resume_error', 'blocked', 'planner_error', 1]); assert.match(res().applied.reason, /falha simulada em resume.*incerto.*nada é relançado/); assert.ok(res().applied.reason.length <= 200);
    assert.equal(x.c.supControl.resumes, 1, 'conservador: a tentativa gastou o orçamento'); assert.equal(x.starts(), 0);
    assert.equal(x.db().cycle.supervision.find((e) => e.action === 'resume').applied.by, 'resume_error', 'gravado');
  } finally { onBusy = null; }
});

test('QUEDA entre "started" e o retorno de resume(): no boot o ciclo BLOQUEADO tem a decisão aberta fechada como incerta, uma vez, sem relançar nada', async () => {
  const x = await run([{ error: 'f1' }], { supervision: { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 0 } }); assert.equal(x.c.blockedCode, 'planner_error');
  const E = (over) => ({ at: 'T', round: 0, step: null, observation: { kind: 'x' }, reason: 'semeada', signature: null, budget: {}, ...over });
  (x.c.supervision ??= []).push(E({ action: 'resume', code: 'auto_resume', applied: { state: 'started', by: 'resume' } }), E({ action: 'resume', code: 'auto_resume', applied: { state: 'pending' } }), E({ action: 'block', code: 'x', applied: { state: 'stopped', by: 'antes' } }));
  store.saveOrThrow(); const s0 = execStarts; db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor })); const pl = planner([planAns(step('a', 'a.txt'))]), cy = mkCycle(pl, { supervision: SUP2 });
  cy.recover(); await cy.idle(); const c = db.missions.find((m) => m.id === x.m.id).cycle, last3 = c.supervision.slice(-3);
  assert.deepEqual(last3.map((e) => [e.applied.state, e.applied.by]), [['stopped', 'restarted'], ['not_applied', 'restarted'], ['stopped', 'antes']], 'started vira stopped, pending vira not_applied; a já final não muda'); assert.match(last3[0].applied.reason, /incerto/);
  assert.equal(c.status, 'blocked'); assert.equal(pl.calls.length, 0, 'nada relançado'); assert.equal(execStarts, s0);
  const snap = JSON.stringify(c); cy.recover(); cy.recover(); await cy.idle(); assert.equal(JSON.stringify(c), snap, 'idempotente'); assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((m) => m.id === x.m.id).cycle), snap, 'gravado');
});
