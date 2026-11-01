// Marco B — correções finais: (1) fidelidade da trilha (recomendação x ação iniciada x bloqueada x resultado); (2) prevenção de loop com reconhecimento de PROGRESSO verificável;
// (3) recusas da política avaliadas pelo supervisor antes de outra consulta ao Planner. Puro + ciclo em processo (executor = CLI falsa, Planner e verificador SIMULADOS). Banco/workspace TEMPORÁRIOS.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fid-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const S = await import('../supervisor.js');
const { superviseRound, failureProfile, failureSignature, refusalSignature, trendOf, failedCountHint } = S;

let db, executor, startTaskRun, seq = 0, verCalls = 0, verStatusOf = () => 'pass', execStarts = 0, onBusy = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V5 = ['v1', 'v2', 'v3', 'v4', 'v5'].map((id) => ({ id, script: id, command: 'node --test', required: true, timeoutMs: 60000 }));
before(() => {
  db = store.load(); db.missions = [];
  db.workspaces = [{ id: 'ws', name: 'alvo', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }, { id: 'ws5', name: 'alvo5', path: wsDir, verifications: V5 }];
  db.settings.activeWorkspaceId = 'ws'; store.saveOrThrow();
  const real = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  executor = new Proxy(real, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : k === 'isBusy' ? () => { onBusy?.(); return t.isBusy(); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await sleep(500); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- fixtures puras ----------
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const VER = (id, status, tail = '') => ({ id, script: id, required: true, status, exitCode: status === 'pass' ? 0 : 1, outputTail: tail });
const EV = (failing = [], over = {}) => ({ level: failing.length ? 'failed' : 'verified', basis: 'real_verification', reasons: failing.length ? ['verificação real reprovada: ' + failing.join(', ')] : [], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0 }, system: { verification: failing.length ? 'failed' : 'passed', verifications: [], expectedFiles: null, integrity: 'clean', ...over } });
/** Rodada com as verificações v1..vN, das quais `failing` reprovam. */
const rd = (n, failing, { all = ['v1', 'v2', 'v3', 'v4', 'v5'], tails = {}, stepId = 'a', over = {} } = {}) => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, planId: 'pl', stepId, verification: 'failed', integrity: { status: 'clean' }, policy: { decision: 'allow' },
  report: { status: 'success', filesKnown: true, blockers: [], verifications: all.map((id) => VER(id, failing.includes(id) ? 'fail' : 'pass', tails[id] ?? '')), evidence: EV(failing) }, ...over });
const cyc = (rounds, over = {}) => ({ id: 'c', status: 'running', maxIterations: 8, rounds, integrity: { baseline: {}, pending: [] }, ...over });
const entryOf = (round, action = 'retry') => { const sv = superviseRound({ cycle: cyc([round]), round }); return { round: round.n, step: round.stepId ?? null, action, signature: sv.signature, profile: sv.profile, observation: sv.observation }; };
const REFUSED = (n, { rules = ['unsupported_capability'], outcome = 'denied', summary = 'Bloqueada pela política: A ação pede para publicar, fazer deploy, commit ou push, o que o Executor não faz.', stepId, digest = `d${n}` } = {}) => ({ n, status: 'failed', phase: 'done', taskId: null, ...(stepId ? { planId: 'pl', stepId } : {}), policy: { decision: 'deny', rules, digest, outcome },
  report: { status: 'failed', summary, filesChanged: [], filesKnown: true, checks: [], errors: [], blockers: [summary], exitCode: null, verifications: [], verificationsSkipped: 'a etapa não foi executada (política)', verificationsInterrupted: null }, verification: 'none' });

// =====================================================================================================================
// 2. progresso verificável (puro)
// =====================================================================================================================
test('dica numérica de falhas: node --test, jest/vitest e pytest reconhecidos; qualquer outra saída => null (nunca inventa)', () => {
  assert.equal(failedCountHint('...\nℹ tests 20\nℹ pass 15\nℹ fail 5\nℹ cancelled 0'), 5); assert.equal(failedCountHint('# fail 3\n'), 3);
  assert.equal(failedCountHint('Tests:       2 failed, 10 passed, 12 total'), 2); assert.equal(failedCountHint('==== 4 failed, 6 passed in 0.31s ===='), 4);
  for (const x of ['', null, undefined, 'tudo certo', 'falhou 5 vezes', 'fail 5', 'x fail 5 x', 'ℹ fail cinco']) assert.equal(failedCountHint(x), null, String(x));
});

test('perfil da rodada: identidades ESTÁVEIS (id da verificação e arquivo esperado), aprovadas e dicas — ordenado, sem duplicata e LIMITADO', () => {
  const r = rd(1, ['v3', 'v1'], { tails: { v1: 'ℹ fail 7', v3: 'ℹ fail 1' } }); r.report.evidence.system.expectedFiles = [{ path: 'b.txt', ok: false }, { path: 'a.txt', ok: true }];
  assert.deepEqual(failureProfile(r), { failing: ['file:b.txt', 'v1', 'v3'], passing: ['v2', 'v4', 'v5'], hints: { v1: 7, v3: 1 } });
  const big = rd(1, Array.from({ length: 30 }, (_, i) => `w${i}`), { all: Array.from({ length: 30 }, (_, i) => `w${i}`) }); const p = failureProfile(big);
  assert.equal(p.failing.length, 16, 'identidades limitadas'); assert.ok(JSON.stringify(p).length < 600, 'perfil pequeno');
  assert.deepEqual(failureProfile({}), { failing: [], passing: [], hints: {} });
});

test('trendOf: first / progress (subconjunto estrito ou dica estritamente menor) / regressed / none / changed — trocar por OUTRAS verificações nunca é progresso', () => {
  const P = (failing, hints = {}, passing = ['v1', 'v2', 'v3', 'v4', 'v5', 't', 'u'].filter((x) => !failing.includes(x))) => ({ failing, passing, hints });
  const five = P(['v1', 'v2', 'v3', 'v4', 'v5']);
  assert.equal(trendOf(null, five), 'first'); assert.equal(trendOf(undefined, undefined), 'first');
  assert.equal(trendOf(five, P(['v1', 'v2'])), 'progress', '5 -> 2 (subconjunto estrito)'); assert.equal(trendOf(five, P([])), 'changed', 'sem nenhuma verificação reprovada no perfil atual não há o que comparar');
  assert.equal(trendOf(five, five), 'none'); assert.equal(trendOf(P(['v1', 'v2']), P(['v3', 'v4'])), 'changed', 'mesma contagem, outras verificações'); assert.equal(trendOf(P(['v1', 'v2']), P(['v1', 'v3'])), 'changed', 'troca parcial');
  assert.equal(trendOf(P(['v1', 'v2']), P(['v1', 'v2', 'v3'])), 'regressed'); assert.equal(trendOf(P(['v1', 'v2', 'v3']), P(['v4'])), 'changed', 'menos, mas OUTRA: não é progresso');
  // mesmas identidades: só a dica numérica, e só se for comparável em TODAS e estritamente menor em ao menos uma
  assert.equal(trendOf(P(['t'], { t: 5 }), P(['t'], { t: 2 })), 'progress'); assert.equal(trendOf(P(['t'], { t: 5 }), P(['t'], { t: 5 })), 'none'); assert.equal(trendOf(P(['t'], { t: 2 }), P(['t'], { t: 5 })), 'none', 'piora na dica nunca é progresso');
  assert.equal(trendOf(P(['t']), P(['t'], { t: 1 })), 'none', 'sem dica na anterior: não afirma'); assert.equal(trendOf(P(['t', 'u'], { t: 5, u: 1 }), P(['t', 'u'], { t: 2, u: 3 })), 'none', 'uma melhora e uma piora');
  assert.equal(trendOf(P(['t', 'file:a'], { t: 5 }), P(['t', 'file:a'], { t: 2 })), 'none', 'arquivo esperado reprovado impede a leitura só pela dica');
});

test('EXEMPLO OBRIGATÓRIO: cinco verificações reprovadas e depois só duas NÃO bloqueia como supervisor_loop; as mesmas cinco de novo bloqueia', () => {
  const r1 = rd(1, ['v1', 'v2', 'v3', 'v4', 'v5']), r2 = rd(2, ['v1', 'v2']), r2same = rd(2, ['v1', 'v2', 'v3', 'v4', 'v5']);
  const hist = [entryOf(r1)];
  const prog = superviseRound({ cycle: cyc([r1, r2], { supervision: hist }), round: r2, loopGuard: true, retry: { step: { id: 'a' }, cls: 'R1', attempt: 3 } });
  assert.deepEqual([prog.action, prog.enforce, prog.observation.trend, prog.observation.failing, prog.observation.passing], ['retry', false, 'progress', 2, 3]); assert.match(prog.reason, /progresso verificável/); assert.notEqual(prog.signature, hist[0].signature);
  const rep = superviseRound({ cycle: cyc([r1, r2same], { supervision: hist }), round: r2same, loopGuard: true, retry: { step: { id: 'a' }, cls: 'R1', attempt: 3 } });
  assert.deepEqual([rep.action, rep.code, rep.enforce, rep.observation.trend, rep.observation.repeatedAtRound, rep.signature], ['block', 'supervisor_loop', true, 'none', 1, hist[0].signature]); assert.match(rep.reason, /SEM progresso verificável/);
  const prog2 = superviseRound({ cycle: cyc([r1, r2], { supervision: hist }), round: r2, loopGuard: true }); assert.equal(prog2.action, 'replan', 'sem orçamento de retentativas o progresso apenas NÃO bloqueia: o Planner decide');
});

test('mesma contagem, verificações DIFERENTES: não é progresso ("changed"), mas também não é repetição; voltar à primeira falha É repetição (A -> B -> A)', () => {
  const A = rd(1, ['v1', 'v2']), B = rd(2, ['v3', 'v4']), A2 = rd(3, ['v1', 'v2']);
  const hA = entryOf(A), hB = { ...entryOf(B, 'replan') };
  const b = superviseRound({ cycle: cyc([A, B], { supervision: [hA] }), round: B, loopGuard: true });
  assert.deepEqual([b.action, b.enforce, b.observation.trend, b.observation.failing], ['replan', false, 'changed', 2]); assert.notEqual(b.signature, hA.signature, 'identidades diferentes => assinatura diferente');
  const back = superviseRound({ cycle: cyc([A, B, A2], { supervision: [hA, hB] }), round: A2, loopGuard: true });
  assert.deepEqual([back.action, back.code, back.enforce, back.observation.trend, back.observation.repeatedAtRound], ['block', 'supervisor_loop', true, 'changed', 1], 'trocar e voltar não engana o supervisor: A reapareceu sem progresso');
});

test('mesmas identidades com dica numérica: 5 -> 2 falhas no MESMO script é progresso; 5 -> 5 e 5 -> 7 bloqueiam; texto irrelevante não contorna o bloqueio', () => {
  const mk = (n, c, extra = {}) => rd(n, ['v1'], { all: ['v1'], tails: { v1: `salada de texto ${n}\nℹ tests 20\nℹ fail ${c}\n` }, ...extra });
  const r1 = mk(1, 5), hist = [entryOf(r1)];
  const ok = superviseRound({ cycle: cyc([r1, mk(2, 2)], { supervision: hist }), round: mk(2, 2), loopGuard: true }); assert.deepEqual([ok.enforce, ok.observation.trend, ok.signature], [false, 'progress', hist[0].signature], 'mesma assinatura, mas com progresso: não bloqueia');
  for (const c of [5, 7]) { const bad = superviseRound({ cycle: cyc([r1, mk(2, c)], { supervision: hist }), round: mk(2, c), loopGuard: true }); assert.deepEqual([bad.enforce, bad.code, bad.observation.trend], [true, 'supervisor_loop', 'none'], `5 -> ${c}`); }
  const noisy = mk(2, 5); noisy.report.verifications[0].outputTail = 'ruído totalmente diferente 123 em 99 s\nℹ fail 5\nmais ruído';
  const nz = superviseRound({ cycle: cyc([r1, noisy], { supervision: hist }), round: noisy, loopGuard: true }); assert.deepEqual([nz.enforce, nz.code, nz.observation.trend, nz.signature], [true, 'supervisor_loop', 'none', hist[0].signature], 'ruído na saída do projeto (texto livre) não altera a assinatura nem cria progresso');
});

// =====================================================================================================================
// 3. recusas da política (puro)
// =====================================================================================================================
test('recusa da política: o supervisor NUNCA libera a proposta (replan, nunca retry/complete), mesmo com orçamento de retentativas; registra a causa estruturada', () => {
  const refused = REFUSED(1, { rules: ['unsupported_capability', 'git_internal'] });
  const d = superviseRound({ cycle: cyc([refused]), round: refused, loopGuard: true, retry: { step: { id: 'a' }, cls: 'R1', attempt: 2 } });
  assert.deepEqual([d.action, d.code, d.enforce, d.observation.kind, d.observation.outcome, d.observation.decision, d.observation.rules], ['replan', 'policy_refused', false, 'politica_recusada', 'denied', 'deny', ['git_internal', 'unsupported_capability']]);
  assert.match(d.reason, /NÃO foi nem será executada.*alternativa DIFERENTE.*passará pela política/); assert.match(d.signature, /^[0-9a-f]{16}$/);
  const rej = REFUSED(2, { outcome: 'rejected', rules: ['sensitive_files'] }); const dr = superviseRound({ cycle: cyc([rej]), round: rej, loopGuard: true }); assert.deepEqual([dr.action, dr.observation.outcome], ['replan', 'rejected']); assert.match(dr.reason, /rejeitada pela pessoa/);
  for (const sv of [d, dr]) assert.ok(!['retry', 'complete'].includes(sv.action));
});

test('recusa repetida: proposta EQUIVALENTE (mesma etapa, desfecho, regras e motivo) bloqueia — texto, digest e título diferentes não contornam; outra causa ou outra etapa seguem', () => {
  const r1 = REFUSED(1, { digest: 'AAA' }), r2 = REFUSED(2, { digest: 'BBB' }), hist = [{ round: 1, step: null, action: 'replan', signature: refusalSignature(r1) }];
  assert.equal(refusalSignature(r1), refusalSignature(r2), 'o digest (texto da proposta) não entra na equivalência');
  const rep = superviseRound({ cycle: cyc([r1, r2], { supervision: hist }), round: r2, loopGuard: true });
  assert.deepEqual([rep.action, rep.code, rep.enforce, rep.observation.kind, rep.observation.repeatedAtRound], ['block', 'supervisor_loop', true, 'recusa_repetida', 1]); assert.match(rep.reason, /Nenhuma nova consulta ao Planner/);
  assert.equal(superviseRound({ cycle: cyc([r1, r2], { supervision: hist }), round: r2, loopGuard: false }).enforce, false, 'sem a supervisão ligada nada muda');
  const other = REFUSED(2, { rules: ['outside_workspace'], summary: 'Bloqueada pela política: A ação referencia um caminho fora do espaço de trabalho.' }); assert.notEqual(refusalSignature(other), refusalSignature(r1));
  assert.equal(superviseRound({ cycle: cyc([r1, other], { supervision: hist }), round: other, loopGuard: true }).enforce, false, 'outra causa de recusa segue o fluxo');
  const stepped = REFUSED(2, { stepId: 'a' }); assert.notEqual(refusalSignature(stepped), refusalSignature(r1)); assert.equal(superviseRound({ cycle: cyc([r1, stepped], { supervision: hist }), round: stepped, loopGuard: true }).enforce, false, 'outra etapa');
  const rejected = REFUSED(2, { outcome: 'rejected' }); assert.equal(superviseRound({ cycle: cyc([r1, rejected], { supervision: hist }), round: rejected, loopGuard: true }).enforce, false, 'rejeição humana é outra causa');
  assert.equal(superviseRound({ cycle: cyc([r1, r2], { supervision: [{ round: 1, action: 'block', signature: refusalSignature(r1) }] }), round: r2, loopGuard: true }).enforce, false, 'só replan anterior conta');
});

test('determinismo e imutabilidade: as novas decisões não alteram a entrada e repetem o resultado', () => {
  const r1 = rd(1, ['v1', 'v2', 'v3']), r2 = rd(2, ['v1']), c = deepFreeze(cyc([r1, r2], { supervision: [entryOf(r1)] })), ref = deepFreeze(REFUSED(3));
  assert.deepEqual(superviseRound({ cycle: c, round: r2, loopGuard: true }), superviseRound({ cycle: c, round: r2, loopGuard: true })); assert.deepEqual(superviseRound({ cycle: c, round: ref, loopGuard: true }), superviseRound({ cycle: c, round: ref, loopGuard: true }));
  assert.equal(failureSignature(r2), failureSignature(structuredClone(r2)));
});

// =====================================================================================================================
// 1. trilha fiel + ciclo em processo
// =====================================================================================================================
const J = (o) => JSON.stringify(o);
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const planner = (answers, onCall = null) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, describeTier: () => null, decide: async ({ prompt }) => { calls.push(prompt); onCall?.(calls.length); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) } }; } }; };
const step = (id, file, mode = 'produce') => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: [] });
const planAns = (...steps) => J({ decision: 'plan', rationale: 'dividir', steps });
const cont = (title, instructions, expectedFiles) => J({ decision: 'continue', rationale: title, task: { title, instructions, acceptance: ['o resultado existe'], ...(expectedFiles ? { expectedFiles } : {}) } });
const done = () => J({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => J({ decision: 'blocked', rationale: 'ajuda', blockedReason: 'decisão humana' });
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => { verCalls++; const st = verStatusOf(item, verCalls); return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: st, exitCode: st === 'pass' ? 0 : 1, durationMs: 5, outputTail: st === 'pass' ? '' : 'falhou', truncated: false, reason: st === 'pass' ? null : 'Terminou com código 1' }; } });
const mkCycle = (pl, { retries = 0, supervision = null } = {}) => createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true, stepRetries: retries, supervision, watchdogTickMs: 100, persistRetryMs: [1] });
const mkMission = (ws = 'ws') => { const m = { id: `f${++seq}`, demo: false, title: `M${seq}`, objective: 'obj', workspaceId: ws, createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
function resetWs() { for (const f of fs.readdirSync(wsDir)) if (f !== '.git') fs.rmSync(path.join(wsDir, f), { recursive: true, force: true }); }
async function run(answers, opts = {}, { max = 6, ws = 'ws', status = () => 'pass', busy = null, onCall = null } = {}) {
  resetWs(); verCalls = 0; verStatusOf = status; onBusy = busy; const s0 = execStarts;
  const m = mkMission(ws), pl = planner(answers, onCall), cy = mkCycle(pl, opts);
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle(); onBusy = null;
  return { m, c: m.cycle, cy, pl, starts: () => execStarts - s0, disk: () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id).cycle };
}
const acts = (m, re) => db.activity.filter((a) => a.missionId === m.id && re.test(a.message));
const ON = { enabled: true, maxMs: 0, stallMs: 0, autoResumes: 0 }, REC = { enabled: false, maxMs: 0, stallMs: 0, autoResumes: 1 }; // REC: só registra (nenhum bloqueio por loop)
const failFirst = (item, k) => (k === 1 ? 'fail' : 'pass'), alwaysFail = () => 'fail';
const gitDirty = () => fs.writeFileSync(path.join(wsDir, `alheio-${Date.now()}.txt`), 'outra pessoa\n');

test('retry AUTORIZADO pelo candidato mas barrado por outra proteção (selo do Git): a trilha diz "recomendado" e "NÃO aplicado" — sem falso registro de execução', async () => {
  let fired = false;
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { status: failFirst, busy: () => { if (!fired && execStarts > 0 && db.missions.at(-1).cycle?.rounds[0]?.phase === 'done') { fired = true; gitDirty(); } } });
  assert.equal(fired, true); assert.equal(x.starts(), 1, 'nenhuma segunda execução'); const e = x.c.supervision[0];
  assert.deepEqual([e.action, e.code], ['retry', 'R1'], 'a RECOMENDAÇÃO continua registrada'); assert.deepEqual([e.applied.state, e.applied.by], ['not_applied', 'retry_blocker']); assert.match(e.applied.reason, /Git mudou/); assert.ok(!('round' in e.applied) && !('result' in e.applied), 'nenhuma rodada nem resultado inventados');
  assert.equal(acts(x.m, /Reparo automático da etapa "a": tentativa/).length, 0); assert.equal(x.pl.calls.length, 2, 'o Planner foi consultado'); assert.equal(x.c.blockedCode, 'planner_blocked'); assert.equal(x.disk().supervision[0].applied.state, 'not_applied', 'gravado');
});

test('retry realmente INICIADO e concluído: applied "completed" com a rodada e o resultado; a recomendação e o resultado são campos distintos', async () => {
  const x = await run([planAns(step('a', 'a.txt')), done()], { retries: 1, supervision: ON }, { status: failFirst });
  const [e1, e2] = x.c.supervision; assert.equal(x.c.supervision.length, 2); assert.deepEqual([e1.action, e1.applied.state, e1.applied.round], ['retry', 'completed', 2]); assert.deepEqual(e1.applied.result, { execution: 'succeeded', verification: 'passed', evidence: 'verified' });
  assert.deepEqual([e2.round, e2.action, e2.applied.state], [2, 'complete', 'n/a']); assert.equal(x.c.status, 'completed'); assert.deepEqual(x.disk().supervision[0].applied, e1.applied);
});

test('cancelamento ANTES de a ação recomendada ocorrer: a trilha registra "não aplicada" (por retry_blocker) e o ciclo termina cancelado sem nova execução', async () => {
  let fired = false;
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { status: alwaysFail, busy: () => { const c = db.missions.at(-1).cycle; if (!fired && execStarts > 0 && c?.rounds[0]?.phase === 'done') { fired = true; c.cancelRequested = true; } } });
  assert.equal(fired, true); assert.equal(x.c.status, 'cancelled'); assert.equal(x.starts(), 1); const e = x.c.supervision[0];
  assert.deepEqual([e.action, e.applied.state, e.applied.by], ['retry', 'not_applied', 'retry_blocker']); assert.match(e.applied.reason, /cancelamento/);
});

test('"replan" recomendado e depois executor_failures: a 1ª vira "completed" (o Planner decidiu), a 2ª "NÃO aplicada" (o ciclo parou por executor_failures) — nunca "replan" como feito', async () => {
  const x = await run([cont('um', 'MODE:fail um'), cont('dois', 'MODE:fail dois'), done()], { supervision: REC });
  assert.equal(x.c.blockedCode, 'executor_failures'); assert.equal(x.pl.calls.length, 2, 'não houve 3ª consulta'); assert.equal(x.c.rounds.length, 2);
  const [e1, e2] = x.c.supervision; assert.deepEqual([e1.action, e1.applied.state, e1.applied.by, e1.applied.result], ['replan', 'completed', 'planner', { decision: 'continue' }]);
  assert.deepEqual([e2.action, e2.applied.state, e2.applied.by], ['replan', 'not_applied', 'executor_failures']); assert.match(e2.applied.reason, /Duas execuções seguidas falharam/); assert.ok(e2.applied.reason.length <= 200);
  assert.deepEqual(x.disk().supervision.map((e) => e.applied.state), ['completed', 'not_applied'], 'gravado');
});

test('"replan" recomendado e depois no_progress: a trilha mostra a parada por no_progress como o que de fato aconteceu', async () => {
  const x = await run([cont('um', 'MODE:nofile um'), cont('dois', 'MODE:nofile dois'), done()], { supervision: REC }, { status: alwaysFail });
  assert.equal(x.c.blockedCode, 'no_progress'); const e = x.c.supervision.at(-1); assert.deepEqual([e.round, e.action, e.applied.state, e.applied.by], [2, 'replan', 'not_applied', 'no_progress']); assert.equal(x.c.supervision[0].applied.state, 'completed');
});

test('falha de INTEGRIDADE depois da recomendação: block avisado vira "stopped" por integrity_review, com o motivo limitado a 200 caracteres', async () => {
  const x = await run([planAns(step('a', 'a.txt', 'edittest')), done()], { supervision: ON });
  assert.equal(x.c.blockedCode, 'integrity_review'); const e = x.c.supervision[0]; assert.deepEqual([e.action, e.code, e.applied.state, e.applied.by], ['block', 'integrity', 'stopped', 'integrity_review']); assert.ok(e.applied.reason.length <= 200 && e.applied.reason.length > 20);
});

test('no fim do laço o que ficou pendente é fechado com o motivo real (nada fica "pendente" para sempre)', async () => {
  const x = await run([planAns(step('a', 'a.txt', 'sleep')), blockedAns()], { retries: 0, supervision: { enabled: true, maxMs: 0, stallMs: 600, autoResumes: 0 } });
  assert.equal(x.c.blockedCode, 'stalled'); assert.ok(x.c.supervision.every((e) => !['pending', 'started'].includes(e.applied?.state)), JSON.stringify(x.c.supervision.map((e) => e.applied)));
  assert.deepEqual([x.c.supervision[0].action, x.c.supervision[0].applied.state], ['block', 'stopped']);
});

// ---------- progresso no ciclo ----------
const perId = (failing) => (item) => (failing.includes(item.id) ? 'fail' : 'pass');
test('PROGRESSO no ciclo: 5 verificações reprovadas e, na retentativa, só 2 => NÃO é supervisor_loop (o Planner decide); as mesmas 5 de novo => supervisor_loop', async () => {
  let attempt = 0;
  const prog = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { ws: 'ws5', status: (item, k) => { attempt = Math.ceil(k / 5); return perId(attempt === 1 ? ['v1', 'v2', 'v3', 'v4', 'v5'] : ['v1', 'v2'])(item); } });
  assert.equal(prog.c.blockedCode, 'planner_blocked', `${prog.c.blockedCode}: ${prog.c.blockedReason}`); assert.equal(prog.c.rounds.length, 2); assert.equal(prog.pl.calls.length, 2, 'o Planner foi consultado depois do progresso');
  assert.deepEqual(prog.c.supervision.map((e) => [e.round, e.action, e.observation.trend, e.observation.failing]), [[1, 'retry', 'first', 5], [2, 'replan', 'progress', 2]]); assert.equal(prog.c.supervision[0].applied.state, 'completed');
  const same = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { ws: 'ws5', status: alwaysFail });
  assert.equal(same.c.blockedCode, 'supervisor_loop'); assert.equal(same.c.rounds.length, 2); assert.equal(same.pl.calls.length, 1, 'bloqueou antes de outra consulta'); assert.deepEqual(same.c.supervision.map((e) => [e.action, e.observation.trend]), [['retry', 'first'], ['block', 'none']]);
  assert.deepEqual([same.c.supervision[1].applied.state, same.c.supervision[1].applied.by], ['stopped', 'supervisor_loop']);
});

test('efeito sobre stepRetries: o orçamento (máx. 2) NÃO cresce — com progresso a 3ª tentativa só ocorre se o orçamento do Marco A ainda permitir; sem progresso, bloqueia na 2ª', async () => {
  let k = 0;
  const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 2, supervision: ON }, { ws: 'ws5', status: (item, call) => { k = Math.ceil(call / 5); return perId(k === 1 ? ['v1', 'v2', 'v3', 'v4', 'v5'] : k === 2 ? ['v1', 'v2', 'v3'] : ['v1'])(item); } });
  assert.equal(x.c.rounds.length, 3, 'progresso 5 -> 3 -> 1: as 2 retentativas do orçamento foram usadas'); assert.deepEqual(x.c.supervision.map((e) => [e.action, e.observation.trend]), [['retry', 'first'], ['retry', 'progress'], ['replan', 'progress']]);
  assert.equal(x.c.blockedCode, 'planner_blocked'); assert.equal(x.starts(), 3, 'nunca mais que 3 tentativas (1 + stepRetries)');
});

// ---------- recusas da política no ciclo ----------
const PUSH = (t, i) => cont(t, `Faça git push para o remoto (${i})`), OUT = (t, f) => cont(t, `Edite C:/Windows/${f}`);
test('POLÍTICA: a recusa é registrada e avaliada ANTES de outra consulta ao Planner; proposta EQUIVALENTE recusada de novo bloqueia sem nenhuma execução', async () => {
  let seen = null;
  const x = await run([PUSH('Publicar', 1), cont('Publicar de outro jeito', 'Execute git push --force agora'), done()], { supervision: ON }, { onCall: (n) => { if (n === 2) seen = JSON.parse(JSON.stringify(db.missions.at(-1).cycle.supervision)); } });
  assert.equal(seen?.length, 1, 'quando o Planner foi consultado pela 2ª vez a recusa JÁ estava registrada'); assert.deepEqual([seen[0].round, seen[0].action, seen[0].code, seen[0].observation.kind, seen[0].observation.outcome], [1, 'replan', 'policy_refused', 'politica_recusada', 'denied']); assert.equal(seen[0].applied.state, 'started', 'a consulta ao Planner era a ação em curso');
  assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, 'supervisor_loop'); assert.match(x.c.blockedReason, /política recusou de novo uma proposta equivalente/); assert.equal(x.pl.calls.length, 2, 'nenhuma 3ª consulta'); assert.equal(x.starts(), 0, 'nada foi executado');
  assert.deepEqual(x.c.rounds.map((r) => [r.n, r.taskId, r.policy.outcome]), [[1, null, 'denied'], [2, null, 'denied']]); assert.equal(x.c.approvals, undefined, 'nenhuma aprovação foi criada: a política segue absoluta');
  assert.deepEqual(x.c.supervision.map((e) => [e.round, e.action, e.code, e.applied.state]), [[1, 'replan', 'policy_refused', 'completed'], [2, 'block', 'supervisor_loop', 'stopped']]); assert.equal(x.c.supervision[0].applied.result.decision, 'continue'); assert.equal(x.c.supervision[0].signature, x.c.supervision[1].signature);
  assert.equal(x.disk().supervision.length, 2, 'gravado');
});

test('POLÍTICA: proposta DIFERENTE e permitida segue o fluxo normal (executa, verifica e conclui); a recusa anterior fica só como histórico', async () => {
  const x = await run([PUSH('Publicar', 1), cont('Criar o arquivo', 'MODE:produce FILE:ok.txt criar', ['ok.txt']), done()], { supervision: ON });
  assert.equal(x.c.status, 'completed', `${x.c.blockedCode}: ${x.c.blockedReason}`); assert.equal(x.starts(), 1); assert.equal(x.pl.calls.length, 3); assert.equal(x.c.assurance, 'verified');
  assert.deepEqual(x.c.rounds.map((r) => [r.n, r.taskId === null ? 'recusada' : 'executada']), [[1, 'recusada'], [2, 'executada']]); assert.deepEqual(x.c.supervision.map((e) => [e.round, e.action, e.applied.state]), [[1, 'replan', 'completed'], [2, 'complete', 'n/a']]);
});

test('POLÍTICA: outra CAUSA de recusa segue, e só a repetição dessa outra causa bloqueia; com a supervisão DESLIGADA o comportamento é o de antes (sem registro nem bloqueio)', async () => {
  const x = await run([PUSH('a', 1), OUT('b', 'system.ini'), OUT('c', 'win.ini'), done()], { supervision: ON });
  assert.equal(x.c.blockedCode, 'supervisor_loop'); assert.equal(x.c.rounds.length, 3); assert.equal(x.starts(), 0); assert.equal(x.pl.calls.length, 3);
  assert.deepEqual(x.c.supervision.map((e) => [e.round, e.action]), [[1, 'replan'], [2, 'replan'], [3, 'block']]); assert.notEqual(x.c.supervision[0].signature, x.c.supervision[1].signature); assert.equal(x.c.supervision[1].signature, x.c.supervision[2].signature);
  const off = await run([PUSH('a', 1), PUSH('b', 2), blockedAns()]);
  assert.equal(off.c.blockedCode, 'planner_blocked', 'sem supervisão o ciclo consulta o Planner de novo, como no Marco A'); assert.equal(off.c.rounds.length, 2); assert.ok(!('supervision' in off.c));
  const rec = await run([PUSH('a', 1), PUSH('b', 2), blockedAns()], { supervision: REC }); assert.equal(rec.c.blockedCode, 'planner_blocked', 'só registrar (sem o guarda ligado) não bloqueia'); assert.equal(rec.c.supervision.length, 2);
});

// ---------- persistência e recuperação ----------
test('PERSISTÊNCIA E RECUPERAÇÃO: o desfecho gravado sobrevive ao reinício; decisões "pendentes/iniciadas" na queda viram "não concluídas" UMA vez e nada é reaplicado nem executado', async () => {
  const m = mkMission(); const entry = (over) => ({ at: 'T', round: 1, step: 'a', observation: { kind: 'verificacao_reprovada' }, signature: 'abc', budget: {}, ...over });
  m.cycle = { id: 'cyc_q', status: 'running', maxIterations: 6, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, cancelRequested: false, startedAt: 'T0', finishedAt: null, rounds: [],
    supervision: [entry({ action: 'retry', code: 'R1', reason: 'r', applied: { state: 'started', round: 2 } }), entry({ round: 2, action: 'replan', code: 'replan', reason: 'r', applied: { state: 'pending' } }), entry({ round: 3, action: 'block', code: 'integrity', reason: 'r', applied: { state: 'pending' } }), entry({ round: 4, action: 'complete', code: 'verified', reason: 'r', applied: { state: 'n/a' } }), entry({ round: 5, action: 'replan', code: 'replan', reason: 'r', applied: { state: 'completed', by: 'planner', result: { decision: 'continue' } } })] };
  store.saveOrThrow(); const s0 = execStarts;
  db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor })); const pl = planner([planAns(step('a', 'a.txt'))]), cy = mkCycle(pl, { retries: 1, supervision: ON });
  cy.recover(); await cy.idle(); const c = db.missions.find((x) => x.id === m.id).cycle;
  assert.equal(c.blockedCode, 'restarted'); assert.deepEqual(c.supervision.map((e) => [e.applied.state, e.applied.by]), [['stopped', 'restarted'], ['not_applied', 'restarted'], ['stopped', 'restarted'], ['n/a', undefined], ['completed', 'planner']]);
  assert.equal(c.supervision[0].applied.round, 2, 'o que já se sabia da ação iniciada é preservado'); assert.match(c.supervision[1].applied.reason, /servidor reiniciou/);
  const snap = JSON.stringify(c); cy.recover(); cy.recover(); await cy.idle(); assert.equal(JSON.stringify(c), snap, 'recover() repetido não muda nada'); assert.equal(pl.calls.length, 0, 'o boot não consulta o Planner'); assert.equal(execStarts, s0, 'nem executa');
  const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id).cycle; assert.equal(JSON.stringify(disk), snap, 'o que está no disco é o estado recuperado');
  db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor })); const cy2 = mkCycle(planner([]), { retries: 1, supervision: ON }); cy2.recover(); await cy2.idle(); assert.equal(JSON.stringify(db.missions.find((x) => x.id === m.id).cycle), snap, 'um segundo boot também não altera');
});

// =====================================================================================================================
// Microajustes finais: precisão da tendência, memória de controle, transições de desfecho e encerramento por erro
// =====================================================================================================================
test('tendência precisa: só é progresso com perfis de verificação comparáveis e as que saíram agora APROVADAS; sem perfil (execução falhou, inconclusiva) nunca', () => {
  const r1 = rd(1, ['v1', 'v2', 'v3', 'v4', 'v5']), hist = [entryOf(r1)], loop = (round) => superviseRound({ cycle: cyc([r1, round], { supervision: hist }), round, loopGuard: true });
  // redução real: 5 -> 2, as 3 que saíram constam como aprovadas
  const real = loop(rd(2, ['v1', 'v2'])); assert.deepEqual([real.observation.trend, real.enforce], ['progress', false]);
  // as que saíram não aparecem como aprovadas (não rodaram): não afirma progresso
  assert.equal(trendOf({ failing: ['v1', 'v2', 'v3'], passing: [], hints: {} }, { failing: ['v1'], passing: [], hints: {} }), 'changed');
  assert.equal(trendOf({ failing: ['v1', 'v2', 'v3'], passing: [], hints: {} }, { failing: ['v1'], passing: ['v2', 'v3'], hints: {} }), 'progress');
  // verificação reprovada seguida de falha de execução (sem verificações): perfil vazio => não é progresso
  const crash = rd(2, []); crash.status = 'failed'; crash.report.status = 'failed'; crash.report.verifications = []; crash.report.evidence = { level: 'failed', reasons: ['execução falhou'], system: { expectedFiles: null } };
  const c = loop(crash); assert.deepEqual([c.observation.kind, c.observation.trend, c.enforce, c.action], ['execucao_falhou', 'changed', false, 'replan']); assert.doesNotMatch(c.reason, /progresso verificável/);
  // evidência inconclusiva (verificações todas aprovadas, mas sem comprovação): idem
  const inc = rd(2, []); inc.report.evidence = { level: 'inconclusive', reasons: ['sem comprovação'], system: { expectedFiles: null } };
  const i = loop(inc); assert.deepEqual([i.observation.kind, i.observation.trend, i.enforce], ['inconclusiva', 'changed', false]);
  // dois perfis vazios (a mesma falha sem verificações) continuam 'none' e a repetição continua bloqueada
  const e1 = rd(1, []); e1.status = 'failed'; e1.report.status = 'failed'; e1.report.verifications = []; const e2 = structuredClone(e1); e2.n = 2;
  const rep = superviseRound({ cycle: cyc([e1, e2], { supervision: [entryOf(e1)] }), round: e2, loopGuard: true }); assert.deepEqual([rep.observation.trend, rep.enforce, rep.code], ['none', true, 'supervisor_loop']);
  // mesma contagem, verificações diferentes
  const diff = superviseRound({ cycle: cyc([rd(1, ['v1', 'v2']), rd(2, ['v3', 'v4'])], { supervision: [entryOf(rd(1, ['v1', 'v2']))] }), round: rd(2, ['v3', 'v4']), loopGuard: true }); assert.deepEqual([diff.observation.trend, diff.enforce], ['changed', false]);
  // a prevenção não enfraquece: as mesmas cinco continuam bloqueando
  assert.equal(loop(rd(2, ['v1', 'v2', 'v3', 'v4', 'v5'])).enforce, true);
  assert.equal(trendOf({ failing: [], passing: [], hints: {} }, { failing: ['v1'], passing: [], hints: {} }), 'changed'); assert.equal(trendOf({ failing: [], passing: [] }, { failing: [], passing: [] }), 'none');
});

test('memória de CONTROLE independe do log visível: assinaturas e retomadas sobrevivem a mais de 60 eventos e a ciclos antigos (sem supControl)', () => {
  const { controlMemory, autoResumeDecision, transitionApplied, SUPERVISION_LOG_MAX } = S;
  const r1 = rd(1, ['v1', 'v2']), r2 = rd(2, ['v1', 'v2']), sig = failureSignature(r1), filler = Array.from({ length: SUPERVISION_LOG_MAX + 10 }, (_, i) => ({ round: 3 + i, action: 'block', signature: null }));
  // log sem a falha antiga (já descartada), mas com o controle: ainda bloqueia
  const lost = superviseRound({ cycle: cyc([r1, r2], { supervision: filler }), round: r2, loopGuard: true }); assert.equal(lost.enforce, false, 'sem nenhuma memória nada bloqueia');
  const kept = superviseRound({ cycle: cyc([r1, r2], { supervision: filler, supControl: { resumes: 0, sigs: { [sig]: { round: 1, action: 'retry' } } } }), round: r2, loopGuard: true });
  assert.deepEqual([kept.enforce, kept.code, kept.observation.repeatedAtRound], [true, 'supervisor_loop', 1]);
  const ref1 = REFUSED(1), ref2 = REFUSED(2), rsig = refusalSignature(ref1);
  assert.equal(superviseRound({ cycle: cyc([ref1, ref2], { supervision: filler, supControl: { resumes: 0, sigs: { [rsig]: { round: 1, action: 'replan' } } } }), round: ref2, loopGuard: true }).enforce, true, 'recusa repetida lembrada pelo controle');
  // retomadas: o controle manda; ciclo antigo (só log) continua contando pelo log
  const base = { status: 'blocked', blockedCode: 'planner_error', rounds: [], approvals: [] };
  const spent = autoResumeDecision({ cycle: { ...base, supervision: filler, supControl: { resumes: 2, sigs: {} } }, autoResumes: 2 }); assert.deepEqual([spent.ok, spent.used], [false, 2]);
  assert.equal(autoResumeDecision({ cycle: { ...base, supervision: [{ action: 'resume' }, { action: 'resume' }] }, autoResumes: 2 }).ok, false, 'ciclo antigo: o log ainda conta');
  assert.equal(autoResumeDecision({ cycle: { ...base, supervision: filler, supControl: { resumes: 1, sigs: {} } }, autoResumes: 2 }).ok, true); assert.deepEqual(controlMemory({}), { sigs: {}, resumes: 0 });
  assert.deepEqual(controlMemory({ supervision: [{ round: 4, action: 'retry', signature: 'a' }, { round: 2, action: 'replan', signature: 'a' }, { round: 5, action: 'block', signature: 'b' }], supControl: { sigs: { c: { round: 1, action: 'retry' }, d: 'lixo' }, resumes: 'x' } }), { sigs: { a: { round: 4, action: 'retry' }, c: { round: 1, action: 'retry' } }, resumes: 0 });
  assert.deepEqual(controlMemory({ supervision: [{ round: 2, action: 'retry', signature: 'a' }] }, 2).sigs, {}, 'a rodada em avaliação não conta');
  // transições do desfecho: estados finais nunca mudam (nem voltam a "iniciada")
  for (const fin of ['completed', 'not_applied', 'stopped', 'n/a']) for (const nxt of ['started', 'pending', 'stopped', 'completed']) assert.deepEqual(transitionApplied({ state: fin, by: 'x' }, { state: nxt }), { state: fin, by: 'x' }, `${fin} -> ${nxt}`);
  assert.deepEqual(transitionApplied({ state: 'pending' }, { state: 'started' }), { state: 'started' }); assert.deepEqual(transitionApplied({ state: 'started' }, { state: 'completed' }), { state: 'completed' }); assert.deepEqual(transitionApplied(undefined, { state: 'pending' }), { state: 'pending' });
});

// ---------- encerramento por erro com decisão pendente ----------
function errorEndTest(label, mkErr, code, tag) {
  test(`ERRO durante decisão pendente (${label}): o desfecho registra o motivo REAL (${code}), não o estado anterior; a recuperação é idempotente`, async () => {
    let fired = false; const err = mkErr();
    const x = await run([planAns(step('a', 'a.txt')), blockedAns()], { retries: 1, supervision: ON }, { status: failFirst, busy: () => { if (!fired && execStarts > 0 && db.missions.at(-1).cycle?.rounds[0]?.phase === 'done') { fired = true; throw err; } } });
    assert.equal(fired, true); assert.equal(x.c.status, 'blocked'); assert.equal(x.c.blockedCode, code); assert.equal(x.starts(), 1, 'nenhuma nova execução');
    const e = x.c.supervision[0]; assert.deepEqual([e.action, e.applied.state, e.applied.by], ['retry', 'not_applied', code]); assert.ok(e.applied.reason.includes(tag), e.applied.reason); assert.ok(e.applied.reason.length <= 200);
    assert.ok(x.c.supervision.every((s) => !['pending', 'started'].includes(s.applied?.state)));
    store.saveOrThrow(); const snap = JSON.stringify(x.disk().supervision), s0 = execStarts;
    db = store.load(); ({ startTaskRun } = setupExecution(express(), { db, executor })); const pl2 = planner([]), cy2 = mkCycle(pl2, { retries: 1, supervision: ON });
    cy2.recover(); cy2.recover(); await cy2.idle();
    const after = db.missions.find((m) => m.id === x.m.id).cycle; assert.equal(JSON.stringify(after.supervision), snap, 'recuperação não altera nenhum desfecho'); assert.equal(after.blockedCode, code); assert.equal(pl2.calls.length, 0); assert.equal(execStarts, s0);
  });
}
errorEndTest('erro interno', () => new Error('falha interna simulada'), 'internal_error', 'erro interno do ciclo: falha interna simulada');
errorEndTest('falha de persistência', () => Object.assign(new Error('disco cheio simulado'), { persistence: true }), 'persistence_failed', 'falha de persistência: disco cheio simulado');
