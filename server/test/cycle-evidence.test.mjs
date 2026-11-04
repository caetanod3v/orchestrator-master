// M8: uma etapa só conclui com evidência INDEPENDENTE do relato do Executor. Banco TEMPORÁRIO, workspace TEMPORÁRIO (sem Git), CLI FALSA (que também sabe mexer em testes e
// configuração), Planner e verificador SIMULADOS; os únicos processos são a CLI falsa e filhos `node -e` deste teste. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m8-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`; // diretório no lugar do .tmp => EISDIR (erro NÃO transitório)
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { syncPlan } = await import('../plan.js');
const { snapshotWorkspace, hashesOf } = await import('../evidence.js');
const { DEFAULT_AGENT } = await import('../agents.js');
const { killTreeSync } = await import('../orphans.js');

let db, executor, startTaskRun, execStarts = 0, onStart = null, seq = 0, verStatus = () => 'pass', verRuns = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; };
const VERIFS = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: VERIFS }, { id: 'ws0', name: 'ws0', path: wsDir }]; store.saveOrThrow(); bootExecutor(); });
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

/** O workspace volta ao estado inicial de cada teste: um teste antigo e nada mais. */
function resetWs() { for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true }); fs.mkdirSync(path.join(wsDir, 'tests')); fs.writeFileSync(path.join(wsDir, 'tests', 'old.test.js'), '// teste original\n'); }
function bootExecutor() {
  const real = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  executor = new Proxy(real, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; onStart?.(execStarts); return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
}
/** Reinício de verdade: relê o banco do disco, executor novo, tarefas/processos órfãos tratados e ciclo recuperado. */
function restart(planner, opts = {}) { db = store.load(); bootExecutor(); const cy = mk(planner, opts); cy.recover(); return cy; }

const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) } }; } };
};
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => { verRuns++; const st = verStatus(item); return { id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: st, exitCode: st === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: st === 'pass' ? null : 'Terminou com código 1.' }; } });
const mk = (planner, { limits = null, multiStep = true, ver = verifier() } = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: ver, listFiles: () => ['config.json'], limits, multiStep, persistRetryMs: [1] });
const mkMission = (ws = 'ws') => { const m = { id: `e${++seq}`, demo: false, title: `Missão E${seq}`, objective: 'obj', workspaceId: ws, createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
async function run(answers, { max = 6, ws = 'ws', ...opts } = {}) {
  resetWs(); verStatus = () => 'pass';
  const m = mkMission(ws), planner = scripted(answers), cy = mk(planner, opts), s0 = execStarts;
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, starts: () => execStarts - s0 };
}

const step = (id, deps = [], mode = 'produce', file = `${id}.txt`) => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: deps });
const plan = (steps) => JSON.stringify({ decision: 'plan', rationale: 'dividir em etapas', steps });
const cont = (title, mode = 'produce', file = 'x.txt') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} FILE:${file} ${title}`, acceptance: [`${file} existe com o conteúdo gerado`] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'preciso de ajuda', blockedReason: 'decisão humana' });
const onDisk = (m) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);
const statuses = (c) => Object.fromEntries(c.plan.steps.map((s) => [s.id, s.status]));
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const snap = (x) => JSON.stringify(x);

// ---- fixtures de banco (o que o servidor deixa gravado), no estilo do M7 ----
const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const EV_OK = { level: 'verified', basis: 'real_verification', reasons: [], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0, note: 'relato do Executor: não é prova de conclusão' }, system: { verification: 'passed', verifications: [{ script: 'test', status: 'pass', required: true }], expectedFiles: null, integrity: 'clean' }, at: 'T0' };
const report = (over = {}) => ({ status: 'success', summary: 'ok', filesChanged: [], filesKnown: false, checks: [{ name: 'x', result: 'pass', detail: '' }], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [REAL_PASS], verificationsSkipped: null, verificationsInterrupted: null, ...over });
const task = (id, status, over = {}) => ({ id, title: `[Rodada] ${id}`, status, authorized: false, authorizedBy: 'cycle', auto: true, instructions: 'MODE:produce', acceptance: ['x.txt existe com o conteúdo gerado'], dependsOn: [], report: status === 'completed' ? 'Relatório.\n```json\n{"summary":"ok","checks":[{"name":"x","result":"pass","detail":""}]}\n```' : '', files: [], log: [], agent: DEFAULT_AGENT,
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z', exitCode: status === 'completed' ? 0 : null, error: null, ...over });
const round = (n, stepId, taskId, over = {}) => ({ n, status: 'succeeded', taskId, fingerprint: `f${n}`, agent: DEFAULT_AGENT, plan: { rationale: 'r', title: `Etapa ${stepId}`, instructions: 'MODE:produce', acceptance: ['x.txt existe com o conteúdo gerado'] }, planId: 'pl', stepId,
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: report({ evidence: EV_OK }), verification: 'passed', phase: 'done', integrity: { status: 'clean', changes: [], pending: [] }, decision: null, ...over });
const runningRound = (n, stepId, taskId) => round(n, stepId, taskId, { status: 'running', finishedAt: null, report: null, verification: undefined, phase: undefined, integrity: undefined });
function seed({ status = 'blocked', steps, rounds = [], tasks = [], ws = 'ws', integrity = true, cycle = {} }) {
  const m = mkMission(ws); m.tasks = tasks;
  m.cycle = { id: `cyc_${m.id}`, status, maxIterations: 6, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: status === 'blocked' ? 'restarted' : null, blockedReason: status === 'blocked' ? 'x' : null, finalSummary: null, evidence: null, cancelRequested: false, startedAt: 'T0', finishedAt: null, rounds,
    ...(steps ? { plan: { id: 'pl', createdAt: 'T0', rationale: 'r', steps: steps.map((s) => ({ ...s, status: 'queued', round: null, taskId: null })) } } : {}),
    ...(integrity ? (() => { const s = snapshotWorkspace(wsDir, { commands: ws === 'ws' ? ['node --test'] : [] }); return { integrity: { baseline: hashesOf(s), last: hashesOf(s), at: 'T0', pending: [] } }; })() : {}), ...cycle };
  if (steps) syncPlan(m.cycle);
  store.saveOrThrow(); return m;
}
const live = (id) => db.missions.find((x) => x.id === id);

// ---------- 1: etapa concluída com evidências válidas ----------
test('etapa concluída com evidências válidas: relato do Executor e veredito do sistema ficam separados, e o resultado já está no disco antes da etapa seguinte começar', async () => {
  let atSecondStart = null; resetWs(); onStart = (n) => { if (n === execStarts && !atSecondStart && n % 2 === 0) atSecondStart = onDisk(m); };
  const m = mkMission(), planner = scripted([plan([step('a'), step('b', ['a'])]), done()]), cy = mk(planner); execStarts = 0;
  try { assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle(); } finally { onStart = null; }
  const c = m.cycle;
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified'); assert.deepEqual(statuses(c), { a: 'completed', b: 'completed' });
  for (const r of c.rounds) {
    const ev = r.report.evidence;
    assert.equal(ev.level, 'verified'); assert.equal(ev.basis, 'real_verification+expected_files'); assert.deepEqual(ev.reasons, []);
    assert.equal(ev.executorClaim.status, 'success'); assert.match(ev.executorClaim.note, /não é prova/); assert.equal(ev.system.verification, 'passed'); assert.equal(ev.system.integrity, 'clean');
    assert.equal(ev.system.expectedFiles[0].ok, true); assert.equal(ev.system.expectedFiles[0].changed, true); assert.equal(r.integrity.status, 'clean');
  }
  assert.ok(atSecondStart, 'a segunda etapa começou'); assert.equal(atSecondStart.cycle.rounds[0].report.evidence.level, 'verified', 'a evidência de "a" já estava gravada no disco quando "b" começou'); assert.equal(atSecondStart.cycle.plan.steps[0].status, 'completed');
  assert.match(planner.calls[1], /EVIDÊNCIA \(nível: verified; base: real_verification\+expected_files\): relato do Executor = success \(declarado, NÃO é prova\)/); assert.match(planner.calls[1], /integridade dos testes = clean/);
  assert.equal(onDisk(m).cycle.status, 'completed');
});

// ---------- 2: o Executor declara sucesso, a verificação falha ----------
test('o Executor declara sucesso mas a verificação real falha: a etapa NÃO conclui, nada roda por cima e o Planner recebe o motivo objetivo; sem alterações pendentes não há o que aprovar', async () => {
  resetWs(); const m = mkMission(), planner = scripted([plan([step('a'), step('b', ['a'])]), blockedAns()]), cy = mk(planner), s0 = execStarts; verStatus = () => 'fail';
  assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle();
  const c = m.cycle, ev = c.rounds[0].report.evidence;
  assert.equal(c.rounds[0].report.status, 'success', 'o Executor disse que deu certo'); assert.equal(ev.executorClaim.status, 'success'); assert.equal(ev.level, 'failed'); assert.match(ev.reasons.join(), /verificação real reprovada: test=fail/);
  assert.deepEqual(statuses(c), { a: 'failed', b: 'queued' }); assert.equal(execStarts - s0, 1, 'b não executou'); assert.notEqual(c.status, 'completed');
  assert.match(planner.calls[1], /\[a\] Etapa a \| estado: failed \(rodada 1\) \[motivo: verificação real reprovada: test=fail/); assert.match(planner.calls[1], /EVIDÊNCIA \(nível: failed/);
  assert.equal(c.blockedCode, 'planner_blocked'); verStatus = () => 'pass';
  const noPend = await cy.resume(m.id, { approveIntegrity: true }); assert.equal(noPend.status, 409); assert.match(noPend.error, /Não há alterações em testes/); assert.equal((await cy.resume(m.id, { approveIntegrity: 'sim' })).status, 400);
});

// ---------- 3: verificação indisponível ou inconclusiva ----------
test('verificação indisponível ou inconclusiva nunca vira sucesso presumido: sem verificador, sem verificação nem arquivos esperados, e "complete" é rejeitado', async () => {
  const a = await run([plan([step('a'), step('b', ['a'])]), done(), done()], { ver: null });
  const ev = a.c.rounds[0].report.evidence;
  assert.equal(ev.level, 'inconclusive'); assert.match(ev.reasons.join(), /verificação real não concluída: o verificador não está disponível/); assert.notEqual(a.c.plan.steps[0].status, 'completed'); assert.equal(a.starts(), 1);
  assert.notEqual(a.c.status, 'completed'); assert.ok(a.c.rejections.length >= 1, '"complete" foi rejeitado');

  // workspace SEM verificações e etapa SEM arquivos esperados (plano gravado antes do M8): só o relato do Executor => "unverified"
  resetWs(); const m = seed({ ws: 'ws0', steps: [{ id: 'a', title: 'Etapa a', instructions: 'MODE:produce FILE:a.txt a', acceptance: ['a.txt existe e foi gerado'], dependsOn: [] }, { id: 'b', title: 'Etapa b', instructions: 'MODE:produce FILE:b.txt b', acceptance: ['b.txt existe e foi gerado'], dependsOn: ['a'] }], integrity: false });
  const planner = scripted([blockedAns()]), cy = mk(planner), s0 = execStarts; assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  const c = live(m.id).cycle, e2 = c.rounds[0].report.evidence;
  assert.equal(c.rounds[0].status, 'succeeded', 'a execução deu certo...'); assert.equal(e2.level, 'inconclusive'); assert.equal(e2.basis, 'executor_claim_only'); assert.match(e2.reasons.join(), /sem verificação real configurada nem arquivos esperados: só há o relato do Executor, que não é prova/);
  assert.deepEqual(statuses(c), { a: 'unverified', b: 'queued' }, '...mas o sistema não conseguiu comprovar'); assert.equal(execStarts - s0, 1); assert.match(planner.calls[0], /\[a\] Etapa a \| estado: unverified \(rodada 1\) \[motivo: sem verificação real configurada/);
});

// ---------- 4 e 12: testes alterados pelo Executor ----------
for (const [mode, file, change, cat] of [['edittest', 'tests/extra.test.js', 'created', 'test'], ['modtest', 'tests/old.test.js', 'modified', 'test'], ['deltest', 'tests/old.test.js', 'deleted', 'test'], ['editconf', 'jest.config.js', 'created', 'config']]) {
  test(`testes/configuração alterados pelo Executor (${mode}): a verificação real passa, mas a etapa NÃO é aceita; o ciclo pede revisão, nada segue e o motivo é compreensível`, async () => {
    const r = await run([plan([step('a', [], mode), step('b', ['a'])]), done(), done()]);
    const c = r.c, rd = c.rounds[0];
    assert.equal(rd.verification, 'passed', 'a verificação real do orquestrador passou...'); assert.equal(rd.report.status, 'success', '...e o Executor declarou sucesso, MAS'); assert.equal(rd.integrity.status, 'flagged');
    assert.deepEqual(rd.integrity.changes.map((x) => [x.path, x.change, x.category]), [[file, change, cat]], 'a alteração foi detectada por conteúdo');
    assert.equal(rd.report.evidence.level, 'inconclusive'); assert.equal(rd.report.evidence.system.integrity, 'flagged'); assert.match(rd.report.evidence.reasons.join(), /testes ou configuração de validação foram alterados e ainda não foram revisados/); assert.match(rd.report.evidence.reasons.join(), /não prova a conclusão/);
    assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'integrity_review'); assert.match(c.blockedReason, /NÃO foi concluída/); assert.match(c.blockedReason, new RegExp(file.replace('.', '\\.')));
    assert.deepEqual(statuses(c), { a: 'unverified', b: 'queued' }); assert.equal(r.starts(), 1, 'b não executou'); assert.equal(r.planner.calls.length, 1, 'o Planner não foi consultado');
    assert.equal(c.integrity.pending.length, 1); assert.equal(c.integrity.pending[0].path, file); assert.equal(c.integrity.pending[0].change, change); assert.equal(c.integrity.pending[0].round, 1);
    if (mode === 'edittest') { // retomar SEM aprovar: o Planner decide, vê o estado, e "complete" continua rejeitado
      assert.equal((await r.cy.resume(r.m.id)).status, 202); await r.cy.idle();
      assert.match(r.planner.calls[1], /\[a\] Etapa a \| estado: unverified \(rodada 1\) \[motivo: testes ou configuração de validação foram alterados/); assert.match(r.planner.calls[1], /integridade dos testes = flagged/);
      assert.match(c.rejections[0].problem, /"complete" rejeitado: arquivos de teste ou de configuração de validação foram alterados e não foram revisados/); assert.notEqual(c.status, 'completed'); assert.equal(c.plan.steps[0].status, 'unverified');
    }
  });
}

test('alterar um arquivo que NÃO valida nada (código comum) não aciona a revisão; a etapa conclui normalmente', async () => {
  const r = await run([plan([step('a', [], 'produce', 'src/app.js'), step('b', ['a'])]), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.rounds[0].integrity.status, 'clean'); assert.deepEqual(r.c.integrity.pending, []);
});

// ---------- 5: alteração legítima de testes, aprovada ----------
test('alteração legítima de testes: aprovada por uma pessoa SOBRE O CONTEÚDO EXATO verificado, a etapa conclui, o ciclo segue sem consultar o Planner e nada é refeito', async () => {
  const r = await run([plan([step('a', [], 'edittest'), step('b', ['a'])]), done()]), { c, cy, m } = r;
  assert.equal(c.blockedCode, 'integrity_review'); const before = snap(c), acts = db.activity.length;
  fs.writeFileSync(path.join(wsDir, 'tests', 'extra.test.js'), '// outra coisa, escrita depois da verificação\n');
  const drift = await cy.resume(m.id, { approveIntegrity: true }); assert.equal(drift.status, 409); assert.match(drift.error, /mudaram depois da última verificação/); assert.match(drift.error, /tests\/extra\.test\.js/); assert.equal(snap(c), before, 'nada foi aprovado nem alterado'); assert.equal(db.activity.length, acts);
  fs.writeFileSync(path.join(wsDir, 'tests', 'extra.test.js'), '// criado pelo Executor\n'); // volta ao conteúdo que foi verificado e revisado
  const s0 = execStarts, v0 = verRuns; assert.equal((await cy.resume(m.id, { approveIntegrity: true })).status, 202); await cy.idle();
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified'); assert.deepEqual(statuses(c), { a: 'completed', b: 'completed' });
  assert.equal(c.rounds[0].integrity.status, 'reviewed'); assert.ok(c.rounds[0].integrity.reviewedAt); assert.equal(c.rounds[0].report.evidence.level, 'verified'); assert.equal(c.rounds[0].report.evidence.system.integrity, 'reviewed');
  assert.equal(c.integrity.reviews.length, 1); assert.equal(c.integrity.reviews[0].files[0].path, 'tests/extra.test.js'); assert.deepEqual(c.integrity.pending, []); assert.ok('tests/extra.test.js' in c.integrity.baseline, 'o conteúdo revisado é o novo estado de referência');
  assert.equal(execStarts - s0, 1, 'só b executou (a não foi refeita)'); assert.equal(verRuns - v0, 1); assert.equal(r.planner.calls.length, 2, 'plano + conclusão: nenhuma consulta entre a aprovação e b');
  assert.ok(db.activity.some((a) => a.missionId === m.id && /revisadas e aprovadas por uma pessoa/.test(a.message)));
  assert.equal(c.rounds[1].integrity.status, 'clean', 'a etapa seguinte parte do conteúdo aprovado');
});

test('mudanças ENTRE rodadas (feitas por uma pessoa) entram no estado de referência; o que o Executor alterou continua pendente mesmo se uma edição posterior mexer no mesmo arquivo', async () => {
  resetWs(); const a = round(1, 'a', 'ta'), ta = task('ta', 'completed');
  const m = seed({ steps: [step('a'), step('b', ['a'])], rounds: [a], tasks: [ta] }), planner = scripted([blockedAns()]);
  fs.writeFileSync(path.join(wsDir, 'tests', 'old.test.js'), '// uma pessoa melhorou este teste com o ciclo parado\n'); // fora de qualquer rodada
  const cy = mk(planner); assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  const c = live(m.id).cycle;
  assert.equal(c.rounds[1].integrity.status, 'clean'); assert.deepEqual(c.integrity.external[0].files, [{ path: 'tests/old.test.js', change: 'modified' }]); assert.equal(c.plan.steps[1].status, 'completed'); assert.deepEqual(c.integrity.pending, []);

  resetWs(); const hash = hashesOf(snapshotWorkspace(wsDir)); fs.writeFileSync(path.join(wsDir, 'tests', 'extra.test.js'), '// do Executor\n');
  const cur = snapshotWorkspace(wsDir), flagged = round(1, 'a', 'tb', { integrity: { status: 'flagged', changes: [], pending: ['tests/extra.test.js'] }, report: report({ evidence: { ...EV_OK, level: 'inconclusive', reasons: ['alterado'] } }) });
  const m2 = seed({ steps: [step('a'), step('b', ['a'])], rounds: [flagged], tasks: [task('tb', 'completed')], integrity: false, cycle: { integrity: { baseline: hash, last: hashesOf(cur), at: 'T0', pending: [{ path: 'tests/extra.test.js', change: 'created', category: 'test', hash: cur.files['tests/extra.test.js'].h, round: 1 }] } } });
  fs.writeFileSync(path.join(wsDir, 'tests', 'extra.test.js'), '// o arquivo pendente foi editado de novo\n'); // não "lava" a pendência
  const cy2 = mk(scripted([blockedAns()])); assert.equal((await cy2.resume(m2.id)).status, 202); await cy2.idle();
  assert.deepEqual(live(m2.id).cycle.integrity.pending.map((p) => p.path), ['tests/extra.test.js']); assert.equal(live(m2.id).cycle.rounds.length, 1, 'a etapa "a" segue não comprovada: nada rodou por cima');
});

// ---------- 6: critérios insuficientes ----------
test('critérios de aceitação insuficientes não viram plano nem sucesso: genérico, sem caminho de evidência e plano semeado sem como ser comprovado; o Planner corrige e então executa', async () => {
  const weak = { ...step('a'), acceptance: ['tudo ok'] };
  const g = await run([plan([weak]), plan([weak])]);
  assert.equal(g.c.blockedCode, 'planner_invalid'); assert.match(g.c.rejections[0].problem, /acceptance: o critério "tudo ok" é genérico demais/); assert.equal(g.starts(), 0); assert.ok(!g.c.plan);
  const bare = { ...step('a'), expectedFiles: undefined }; delete bare.expectedFiles;
  const w = await run([plan([bare]), plan([bare])], { ws: 'ws0' });
  assert.equal(w.c.blockedCode, 'planner_invalid'); assert.match(w.c.rejections[0].problem, /não tem verificações reais configuradas e as etapas "a" não declaram "expectedFiles"/); assert.equal(w.starts(), 0);
  resetWs(); const m = mkMission('ws0'); const refused = await mk(scripted([])).start(m.id, 5, { plan: { steps: [bare] } });
  assert.equal(refused.status, 400); assert.match(refused.error, /Plano sem como ser comprovado/); assert.ok(!m.cycle);
  const fix = await run([plan([bare]), plan([step('a'), step('b', ['a'])]), done()], { ws: 'ws0' });
  assert.equal(fix.c.status, 'completed', fix.c.blockedCode); assert.equal(fix.c.assurance, 'verified', 'a garantia vem do parecer do sistema (arquivos esperados conferidos, integridade limpa)'); assert.equal(fix.c.rounds[0].report.evidence.basis, 'expected_files'); assert.equal(fix.c.rounds[0].report.evidence.level, 'verified', 'arquivos esperados conferidos pelo sistema bastam quando não há verificações');
  const lie = await run([plan([step('a', [], 'nofile'), step('b', ['a'])]), blockedAns()], { ws: 'ws0' });
  assert.equal(lie.c.rounds[0].report.status, 'success', 'o Executor declarou sucesso sem produzir o arquivo'); assert.equal(lie.c.rounds[0].report.evidence.level, 'failed'); assert.match(lie.c.rounds[0].report.evidence.reasons.join(), /arquivo esperado "a\.txt": o arquivo não existe/);
  assert.deepEqual(statuses(lie.c), { a: 'failed', b: 'queued' }); assert.equal(lie.starts(), 1);
});

// ---------- 7: falha de persistência impede o avanço ----------
test('falha de persistência: se o resultado da verificação não pode ser gravado a etapa seguinte NÃO começa; com o disco de volta a verificação é refeita e avaliada, e "a" nunca é executada de novo', async () => {
  resetWs(); const m = mkMission(), planner = scripted([plan([step('a'), step('b', ['a']), step('c', ['b'])]), blockedAns()]), s0 = execStarts;
  const base = verifier(); let broke = false;
  const cy = mk(planner, { ver: { ...base, run: async (w, item) => { const res = await base.run(w, item); if (!broke) { broke = true; fs.mkdirSync(BLOCK_TMP); } return res; } } });
  try { await quiet(async () => { assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle(); }); } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(execStarts - s0, 1, 'só "a" iniciou'); assert.notEqual(c.plan.steps[0].status, 'completed', 'resultado não gravado não conclui a etapa');
  assert.equal(onDisk(m).cycle.status, 'running', 'o disco ficou com o último estado gravado'); assert.equal(planner.calls.length, 1);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.deepEqual(c.rounds.map((r) => r.stepId), ['a', 'b', 'c']); assert.equal(execStarts - s0, 3, '"a" executou uma vez só'); assert.equal(c.rounds[0].report.evidence.level, 'verified'); assert.deepEqual(statuses(c), { a: 'completed', b: 'completed', c: 'completed' });
  assert.deepEqual(onDisk(m).cycle.rounds.map((r) => r.report.evidence.level), ['verified', 'verified', 'verified'], 'a evidência está gravada');
});

// ---------- 8 e 9: reinício ----------
test('reinício: etapas concluídas e verificadas (inclusive as gravadas antes do M8) não são executadas de novo; só a próxima roda', async () => {
  resetWs(); const legacy = round(2, 'x', 'tx', { report: report(), integrity: undefined }); // gravada antes do M8: sem evidência
  const ra = round(1, 'a', 'ta');
  const m = seed({ steps: [step('a'), step('x'), step('b', ['a', 'x'])], rounds: [ra, legacy], tasks: [task('ta', 'completed'), task('tx', 'completed')] });
  const before = [snap(ra), snap(legacy)], planner = scripted([done()]), s0 = execStarts, cy = restart(planner);
  assert.deepEqual(statuses(live(m.id).cycle), { a: 'completed', x: 'completed', b: 'queued' });
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); const c = live(m.id).cycle;
  assert.equal(execStarts - s0, 1, 'só b'); assert.deepEqual(c.rounds.map((r) => r.stepId), ['a', 'x', 'b']); assert.deepEqual([snap(c.rounds[0]), snap(c.rounds[1])], before, 'as evidências gravadas não foram tocadas'); assert.equal(c.status, 'completed', c.blockedReason); assert.equal(planner.calls.length, 1);
});

test('reinício: etapa interrompida ou de resultado incerto nunca vira sucesso sem nova verificação baseada em evidência', async () => {
  // (i) Executor encerrado no meio: interrompida, sem parecer do sistema, nada é refeito e o Planner decide
  resetWs(); const m1 = seed({ status: 'running', steps: [step('a'), step('b', ['a'])], rounds: [runningRound(1, 'a', 'ta')], tasks: [task('ta', 'running', { pid: 999999 })] });
  const p1 = scripted([blockedAns()]), s0 = execStarts, cy1 = restart(p1), c1 = live(m1.id).cycle;
  assert.deepEqual(statuses(c1), { a: 'interrupted', b: 'queued' }); assert.equal(c1.plan.steps[0].uncertain, true); assert.ok(!c1.rounds[0].report.evidence, 'o sistema nunca avaliou esta rodada');
  assert.equal((await cy1.resume(m1.id)).status, 202); await cy1.idle(); assert.equal(execStarts, s0); assert.equal(p1.calls.length, 1); assert.equal(c1.plan.steps[0].status, 'interrupted'); assert.match(p1.calls[0], /RESULTADO INCERTO/);

  // (ii) o Executor terminou e mexeu em testes, e o servidor caiu antes de avaliar: a re-verificação passa, mas a integridade acusa => NÃO conclui
  resetWs(); const m2 = seed({ status: 'running', steps: [step('a'), step('b', ['a'])], rounds: [runningRound(1, 'a', 'ta2')], tasks: [task('ta2', 'completed')] });
  fs.writeFileSync(path.join(wsDir, 'tests', 'extra.test.js'), '// criado pelo Executor antes da queda\n');
  const p2 = scripted([blockedAns()]), cy2 = restart(p2), c2 = live(m2.id).cycle;
  assert.equal(c2.rounds[0].status, 'succeeded'); assert.equal(c2.rounds[0].report.evidence.level, 'inconclusive', 'parecer provisório do boot: inconclusivo'); assert.notEqual(c2.plan.steps[0].status, 'completed');
  const s1 = execStarts, v1 = verRuns; assert.equal((await cy2.resume(m2.id)).status, 202); await cy2.idle();
  assert.equal(verRuns - v1, 1, 'a verificação real foi refeita'); assert.equal(execStarts, s1, 'o Executor NÃO foi repetido'); assert.equal(c2.rounds[0].integrity.status, 'flagged'); assert.equal(c2.plan.steps[0].status, 'unverified'); assert.equal(c2.plan.steps[1].status, 'queued'); assert.equal(p2.calls.length, 1);

  // (iii) mesmo cenário sem mexer em testes: verificação refeita + integridade limpa => conclui e a etapa seguinte roda sem Planner
  resetWs(); const m3 = seed({ status: 'running', steps: [step('a'), step('b', ['a'])], rounds: [runningRound(1, 'a', 'ta3')], tasks: [task('ta3', 'completed')] });
  const p3 = scripted([done()]), cy3 = restart(p3), s2 = execStarts; assert.equal((await cy3.resume(m3.id)).status, 202); await cy3.idle(); const c3 = live(m3.id).cycle;
  assert.equal(c3.rounds[0].report.evidence.level, 'verified'); assert.deepEqual(c3.rounds.map((r) => r.stepId), ['a', 'b']); assert.equal(execStarts - s2, 1, 'só b'); assert.equal(c3.status, 'completed', c3.blockedReason);
});

// ---------- 10: compatibilidade ----------
test('ciclos sem plano e com ORCH_CYCLE_PLAN desligado: o gate de conclusão também vale (evidência inconclusiva é rejeitada); a violação de integridade de testes continua exigindo revisão', async () => {
  const a = await run([cont('Criar x'), done(), blockedAns()], { multiStep: false, ws: 'ws0' });
  assert.notEqual(a.c.status, 'completed'); assert.equal(a.c.blockedCode, 'planner_blocked'); assert.ok(!a.c.plan); assert.equal(a.c.rounds[0].report.evidence.level, 'inconclusive'); assert.match(a.c.rejections[0].problem, /evidência do sistema para a última rodada é "inconclusive"/); assert.equal(a.c.assurance, undefined);
  const plain = await run([cont('Criar x'), done()], { multiStep: false }); assert.equal(plain.c.status, 'completed'); assert.equal(plain.c.assurance, 'verified'); assert.equal(plain.c.rounds[0].report.evidence.level, 'verified');
  const off = await run([plan([step('a')]), plan([step('a')]), blockedAns()], { multiStep: false }); assert.equal(off.c.blockedCode, 'planner_invalid'); assert.match(off.c.rejections[0].problem, /chaves não permitidas: steps/);
  // violação de integridade no modo avulso: bloqueia; sem revisão "complete" é rejeitado; com revisão conclui
  const t = await run([cont('Mexer nos testes', 'edittest', 'x.txt'), done(), done()], { multiStep: false });
  assert.equal(t.c.blockedCode, 'integrity_review'); assert.equal((await t.cy.resume(t.m.id)).status, 202); await t.cy.idle(); assert.match(t.c.rejections[0].problem, /não foram revisados/); assert.notEqual(t.c.status, 'completed');
  const ok = await run([cont('Mexer nos testes', 'edittest', 'x.txt'), done()], { multiStep: false });
  assert.equal((await ok.cy.resume(ok.m.id, { approveIntegrity: true })).status, 202); await ok.cy.idle(); assert.equal(ok.c.status, 'completed', ok.c.blockedReason); assert.equal(ok.c.assurance, 'verified'); assert.equal(ok.c.rounds[0].integrity.status, 'reviewed');
});

// ---------- 11: cancelamento e limites ----------
test('cancelamento e limites continuam valendo: cancelar em integrity_review é terminal; cancelar no meio da etapa não gera evidência; o teto de chamadas bloqueia sem apagar a evidência', async () => {
  const r = await run([plan([step('a', [], 'edittest'), step('b', ['a'])])]);
  assert.equal(r.c.blockedCode, 'integrity_review'); assert.equal((await r.cy.cancel(r.m.id)).status, 200); assert.equal(r.c.status, 'cancelled'); assert.equal(r.c.plan.steps[0].status, 'unverified', 'cancelar não aprova nada'); assert.equal((await r.cy.resume(r.m.id, { approveIntegrity: true })).status, 409); assert.equal(r.starts(), 1);

  resetWs(); const m = mkMission(), planner = scripted([plan([step('a', [], 'sleep'), step('b', ['a'])]), done()]), cy = mk(planner), s0 = execStarts;
  assert.equal((await cy.start(m.id, 5)).status, 202); assert.ok(await until(() => m.cycle.rounds[0]?.status === 'running' && executor.isBusy()), 'a etapa começou');
  assert.equal((await cy.cancel(m.id)).status, 200); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.deepEqual(statuses(m.cycle), { a: 'interrupted', b: 'queued' }); assert.ok(!m.cycle.rounds[0].report.evidence, 'etapa interrompida não tem parecer de sucesso'); assert.equal(execStarts - s0, 1);

  const cap = await run([plan([step('a'), step('b', ['a'])]), done()], { limits: { maxPlannerCalls: 1, maxEstimatedCostUsd: null } });
  assert.equal(cap.c.blockedCode, 'planner_call_cap'); assert.deepEqual(statuses(cap.c), { a: 'completed', b: 'completed' }); assert.equal(cap.c.rounds[1].report.evidence.level, 'verified'); assert.equal((await cap.cy.resume(cap.m.id)).status, 409);
});

// ---------- entregável pedido pelo usuário com "test" no nome NÃO é adulteração da validação ----------
test('o Executor cria o arquivo pedido "orchestrator-worktree-test.txt": integridade limpa, sem integrity_review, etapa comprovada pelo arquivo esperado e pela verificação real', async () => {
  const r = await run([plan([step('a', [], 'produce', 'orchestrator-worktree-test.txt')]), done()]), c = r.c, rd = c.rounds[0];
  assert.equal(fs.existsSync(path.join(wsDir, 'orchestrator-worktree-test.txt')), true, 'o Executor criou o arquivo');
  assert.equal(rd.integrity.status, 'clean'); assert.deepEqual(rd.integrity.changes, []); assert.notEqual(c.blockedCode, 'integrity_review', `${c.blockedCode}: ${c.blockedReason}`);
  assert.equal(rd.report.evidence.level, 'verified'); assert.equal(rd.report.evidence.basis, 'real_verification+expected_files'); assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'verified'); assert.equal(c.integrity.pending.length, 0);
});

test('sem verificações reais configuradas, o entregável criado NÃO vira falha de integridade: a base da evidência é só o arquivo esperado conferido no disco (nunca "real_verification")', async () => {
  const r = await run([plan([step('a', [], 'produce', 'orchestrator-worktree-test.txt')]), done()], { ws: 'ws0' }), rd = r.c.rounds[0];
  assert.equal(rd.integrity.status, 'clean'); assert.notEqual(r.c.blockedCode, 'integrity_review');
  assert.notEqual(rd.report.evidence.system.integrity, 'flagged'); assert.ok(!/testes ou configuração de validação foram alterados/.test(rd.report.evidence.reasons.join()), 'o motivo não é adulteração');
  assert.equal(rd.report.evidence.system.expectedFiles?.[0]?.ok, true, 'o arquivo esperado foi conferido no disco'); assert.equal(rd.report.evidence.basis, 'expected_files', 'sem verificação real a base é só o arquivo esperado'); assert.deepEqual(rd.report.verifications ?? [], [], 'nenhuma verificação real rodou');
});

test('um teste criado com nome de teste de CÓDIGO (src/x.test.js) continua acionando integrity_review, mesmo junto de um entregável de texto', async () => {
  const r = await run([plan([step('a', [], 'edittest'), step('b', ['a'], 'produce', 'orchestrator-worktree-test.txt')]), done()]);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'integrity_review'); assert.deepEqual(r.c.rounds[0].integrity.changes.map((x) => x.path), ['tests/extra.test.js']);
});

// ---------- escopo: arquivo sensível/de segredo alterado FORA do que a etapa autorizou ----------
const stepOut = (id, file, expected = ['a.txt']) => ({ ...step(id, [], 'produce', file), expectedFiles: expected, acceptance: [`${expected[0]} existe e foi gerado nesta etapa`] }); // o Executor escreve `file`, mas a etapa só autorizou `expected`

test('escopo: arquivo sensível FORA do escopo (Dockerfile) bloqueia com scope_exceeded; a rodada não é comprovada, nada segue e as evidências ficam preservadas', async () => {
  const r = await run([plan([stepOut('a', 'Dockerfile'), step('b', ['a'])]), done(), done()]), c = r.c, rd = c.rounds[0];
  assert.equal(fs.existsSync(path.join(wsDir, 'Dockerfile')), true, 'o Executor realmente criou o arquivo');
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'scope_exceeded'); assert.match(c.blockedReason, /FORA do escopo autorizado/); assert.match(c.blockedReason, /Dockerfile \(criado; sensível\)/); assert.match(c.blockedReason, /retomar não aceita o desvio/);
  assert.deepEqual([rd.scope.status, rd.scope.files], ['exceeded', [{ path: 'Dockerfile', change: 'created', category: 'sensitive' }]]); assert.deepEqual(rd.scope.authorized, ['a.txt']);
  assert.equal(rd.report.evidence.level, 'failed'); assert.equal(rd.report.evidence.system.scope, 'exceeded'); assert.match(rd.report.evidence.reasons.join(), /fora do escopo autorizado.*Dockerfile criado/);
  assert.notEqual(statuses(c).a, 'completed'); assert.equal(statuses(c).b, 'queued'); assert.equal(r.starts(), 1, 'a etapa seguinte não executou'); assert.equal(r.planner.calls.length, 1, 'o Planner não foi consultado');
  assert.deepEqual(onDisk(r.m).cycle.rounds[0].scope.files, rd.scope.files, 'gravado no banco, com a rodada'); assert.ok(c.blocks.some((b) => b.code === 'scope_exceeded'), 'histórico de bloqueios preservado');
});

test('escopo: segredo (.env) fora do escopo bloqueia, identifica o arquivo e NÃO revela o conteúdo em lugar nenhum (bloqueio, evidência, banco)', async () => {
  const SEG = 'SEGREDO-TOPO-123'; onStart = () => fs.writeFileSync(path.join(wsDir, '.env'), SEG); // aparece DURANTE a execução, depois do instantâneo de antes
  let r; try { r = await run([plan([stepOut('a', 'b.txt')]), done()]); } finally { onStart = null; }
  const c = r.c, rd = c.rounds[0]; assert.equal(c.blockedCode, 'scope_exceeded'); assert.match(c.blockedReason, /\.env \(criado; segredo\)/); assert.deepEqual(rd.scope.files, [{ path: '.env', change: 'created', category: 'secret' }]);
  const everything = JSON.stringify([c, onDisk(r.m)]) + fs.readFileSync(DB_FILE, 'utf8'); assert.ok(!everything.includes(SEG), 'o conteúdo do segredo não aparece');
  assert.equal(rd.report.evidence.level, 'failed');
});

test('escopo: arquivo sensível AUTORIZADO pela etapa (expectedFiles + aprovação humana desta ação) NÃO é desvio e o ciclo conclui', async () => {
  const r = await run([plan([step('a', [], 'produce', 'Dockerfile')]), done()]), c0 = r.c; // Dockerfile em expectedFiles => a política exige a aprovação humana ANTES de executar
  assert.equal(c0.blockedCode, 'approval_required'); assert.equal(r.starts(), 0); const a = c0.approvals[0]; assert.equal(r.cy.decideApproval(r.m.id, a.id, { decision: 'approve', digest: a.digest }).status, 200);
  assert.equal((await r.cy.resume(r.m.id)).status, 202); await r.cy.idle();
  const c = r.m.cycle, rd = c.rounds[0]; assert.notEqual(c.blockedCode, 'scope_exceeded', `${c.blockedCode}: ${c.blockedReason}`); assert.deepEqual([rd.scope.status, rd.scope.files, rd.scope.changed], ['clean', [], 1]); assert.deepEqual(rd.scope.authorized, ['Dockerfile']);
  assert.equal(rd.report.evidence.level, 'verified'); assert.equal(c.status, 'completed');
});

test('escopo: só arquivo COMUM fora do escopo mantém o comportamento atual (sem scope_exceeded, sem tocar a evidência por escopo)', async () => {
  const r = await run([plan([stepOut('a', 'outro.txt')]), blockedAns()]), c = r.c, rd = c.rounds[0];
  assert.equal(fs.existsSync(path.join(wsDir, 'outro.txt')), true); assert.deepEqual([rd.scope.status, rd.scope.files, rd.scope.changed], ['clean', [], 0]); assert.notEqual(c.blockedCode, 'scope_exceeded');
  assert.ok(!/fora do escopo autorizado/.test(rd.report.evidence.reasons.join()), 'a falha existente (arquivo esperado ausente) segue sendo a única razão');
});

test('escopo: o desvio sobrevive a reinício e a retomada — continua bloqueado, a evidência continua "failed" e o Planner NÃO consegue concluir sobre a rodada', async () => {
  const r = await run([plan([stepOut('a', 'Dockerfile')]), done(), done(), done()]); assert.equal(r.c.blockedCode, 'scope_exceeded'); const s0 = execStarts;
  // reinício de verdade: o banco é relido do disco
  const cy2 = restart(scripted([done(), done(), done()])), m2 = db.missions.find((x) => x.id === r.m.id), c2 = m2.cycle; await cy2.idle();
  assert.equal(c2.status, 'blocked'); assert.equal(c2.blockedCode, 'scope_exceeded', 'a recuperação não transforma o desvio em sucesso'); assert.equal(c2.rounds[0].scope.status, 'exceeded'); assert.equal(c2.rounds[0].report.evidence.level, 'failed'); assert.equal(execStarts, s0, 'nada foi executado');
  // retomada humana: o desvio gravado vale; a conclusão do Planner sobre essa rodada é recusada e a etapa não vira concluída
  const cy3 = mk(scripted([done(), done(), done()])); assert.equal((await cy3.resume(m2.id)).status, 202); await cy3.idle();
  assert.notEqual(m2.cycle.status, 'completed'); assert.notEqual(statuses(m2.cycle).a, 'completed'); assert.equal(m2.cycle.rounds[0].report.evidence.level, 'failed'); assert.equal(m2.cycle.rounds[0].scope.status, 'exceeded'); assert.notEqual(m2.cycle.assurance, 'verified');
});

// ---------- autorização prévia de etapas sensíveis ao aprovar o plano ----------
async function runAuth(answers, { steps, authorized = [], max = 6, retries = 0, hook = null, start = null } = {}) {
  resetWs(); verStatus = () => 'pass';
  const m = mkMission('ws'), planner = scripted(answers), s0 = execStarts;
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier: verifier(), listFiles: () => ['config.json'], limits: null, multiStep: true, stepRetries: retries, persistRetryMs: [1] });
  if (hook) onStart = (k) => hook(k - s0, m); // k relativo a ESTE teste (o contador de execuções é do arquivo todo)
  let res; try { res = await cy.start(m.id, max, start ?? { plan: { rationale: 'plano aprovado', steps }, authorizedSteps: authorized }); await cy.idle(); } finally { onStart = null; }
  return { m, c: m.cycle, cy, planner, res, starts: () => execStarts - s0 };
}
const planApprovals = (c) => (c?.approvals ?? []).filter((a) => a.origin === 'plan_approval');

test('autorização do plano: aprovar o plano SEM selecionar a etapa sensível continua pedindo aprovação (nada é autorizado por padrão)', async () => {
  const r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile')] });
  assert.equal(r.res.status, 202); assert.equal(r.c.blockedCode, 'approval_required'); assert.equal(r.starts(), 0); assert.deepEqual(planApprovals(r.c), []); assert.equal(r.c.approvals.length, 1); assert.equal(r.c.approvals[0].status, 'pending');
});

test('autorização do plano: etapa sensível SELECIONADA executa sem nova pergunta; fica registrada com origem e responsável, ligada ao plano, à etapa e ao digest, e é consumida', async () => {
  const r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile')], authorized: ['a'] }), c = r.c, [a] = planApprovals(c);
  assert.equal(c.status, 'completed', `${c.blockedCode}: ${c.blockedReason}`); assert.equal(r.starts(), 1); assert.equal(c.approvals.length, 1, 'nenhum pedido de aprovação foi feito');
  assert.deepEqual([a.origin, a.decidedBy, a.status, a.stepId, a.planId], ['plan_approval', 'user', 'consumed', 'a', c.plan.id]); assert.match(a.digest, /^[0-9a-f]{64}$/); assert.deepEqual([a.uses, a.usesLeft, a.consumedRounds, a.consumedRound], [1, 0, [1], 1]);
  const rd = c.rounds[0]; assert.deepEqual([rd.policy.authorizedBy, rd.policy.origin, rd.policy.approvalId, rd.approvalId], ['user', 'plan_approval', a.id, a.id]); assert.equal(c.policyLog.at(-1).origin ?? c.policyLog[0].origin, 'plan_approval'); assert.equal(rd.scope.status, 'clean');
  assert.equal(onDisk(r.m).cycle.approvals[0].origin, 'plan_approval', 'gravado junto com o ciclo');
});

test('autorização do plano: vale SÓ para a etapa escolhida; outra etapa sensível não escolhida continua pedindo aprovação', async () => {
  const r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile'), step('b', ['a'], 'produce', 'requirements.txt')], authorized: ['a'] }), c = r.c;
  assert.equal(r.starts(), 1, 'só a etapa a executou'); assert.equal(c.blockedCode, 'approval_required'); assert.deepEqual(planApprovals(c).map((x) => [x.stepId, x.status]), [['a', 'consumed']]);
  const pend = c.approvals.filter((x) => x.status === 'pending'); assert.equal(pend.length, 1); assert.equal(pend[0].stepId, 'b'); assert.equal(pend[0].origin, undefined, 'a aprovação pendente é uma solicitação normal, decidida por uma pessoa');
});

test('autorização do plano: replanejamento (novo planId) ou ação alterada (digest) INVALIDA a autorização: a etapa volta a pedir aprovação', async () => {
  for (const [label, mutate, why] of [['digest alterado', (m) => { m.cycle.plan.steps.find((s) => s.id === 'b').instructions += ' (alterada depois)'; }, /mudou desde a autorização/], ['novo planId', (m) => { m.cycle.plan.id = 'plan_substituto'; }, /plano foi substituído/]]) {
    const r = await runAuth([done()], { steps: [step('a'), step('b', ['a'], 'produce', 'Dockerfile')], authorized: ['b'], hook: (k, m) => { if (k === 1) mutate(m); } }), c = r.c;
    const [pa] = planApprovals(c); assert.equal(pa.status, 'void', label); assert.match(pa.voidReason, why); assert.ok(c.rounds.every((x) => x.policy?.origin !== 'plan_approval'), `${label}: nenhuma rodada usou a autorização invalidada`);
    if (label === 'digest alterado') { assert.equal(c.blockedCode, 'approval_required', label); assert.equal(r.starts(), 1, `${label}: b NÃO executou`); assert.equal(c.approvals.filter((x) => x.status === 'pending').length, 1, label); }
    else assert.ok(!c.rounds.some((x) => x.stepId === 'b'), 'com outro plano a etapa b não rodou com a autorização do plano antigo');
  }
});

test('autorização do plano: nunca para deny, segredo, etapa que não precisa nem etapa inexistente; entrada inválida; nada é iniciado e nenhuma autorização é criada', async () => {
  const bad = async (steps, authorized, status, re, start = undefined) => { const r = await runAuth([done()], { steps, authorized, start }); assert.equal(r.res.status, status, JSON.stringify(r.res)); assert.match(r.res.error, re); assert.equal(r.m.cycle, undefined); assert.equal(r.starts(), 0); };
  await bad([step('a', [], 'produce', '.env')], ['a'], 409, /segredo.*aprovação individual/);
  await bad([{ ...step('a'), instructions: 'MODE:produce FILE:a.txt rode git push para o remoto' }], ['a'], 409, /proibida pela política/);
  await bad([step('a')], ['a'], 409, /não precisa de autorização/);
  await bad([step('a', [], 'produce', 'Dockerfile')], ['zzz'], 400, /não existe no plano/);
  await bad([step('a', [], 'produce', 'Dockerfile')], 'a', 400, /lista de ids/); await bad([step('a', [], 'produce', 'Dockerfile')], ['a', 'a'], 400, /sem repetição/);
  await bad(null, null, 400, /Só um plano aprovado pode autorizar etapas/, { authorizedSteps: ['a'] });
});

test('autorização do plano: Planner, rota HTTP e recuperação NÃO criam autorizações (só start() em processo, com o plano aprovado por uma pessoa)', async () => {
  const injected = JSON.stringify({ decision: 'plan', rationale: 'x', steps: [step('a', [], 'produce', 'Dockerfile')], authorizedSteps: ['a'], authorized: true, approved: true, origin: 'plan_approval' });
  const r = await run([injected, done()]); assert.ok(['planner_invalid', 'approval_required'].includes(r.c.blockedCode), r.c.blockedCode); assert.deepEqual(planApprovals(r.c), []); assert.equal(r.starts(), 0, 'o Planner não se autorizou (campos extras são recusados ou ignorados)');
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cycle.js'), 'utf8').replace(/\r\n/g, '\n'); assert.match(src, /cycle\/start', asyncRoute\(async \(req, res\) => reply\(res\)\(await cycle\.start\(req\.params\.id, body\(req\)\.maxIterations\)\)\)/, 'a rota só repassa maxIterations');
  // recuperação (reinício) de um ciclo com autorização consumida e aprovação pendente: não cria, não reaproveita, não altera
  const a = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile'), step('b', ['a'], 'produce', 'requirements.txt')], authorized: ['a'] }); const before = JSON.stringify(a.c.approvals), s0 = execStarts;
  const cy2 = restart(scripted([done()])), m2 = db.missions.find((x) => x.id === a.m.id); await cy2.idle(); assert.equal(JSON.stringify(m2.cycle.approvals), before); assert.equal(m2.cycle.blockedCode, 'approval_required'); assert.equal(execStarts, s0); assert.equal(planApprovals(m2.cycle).length, 1);
});

test('autorização do plano: retentativas — o orçamento é 1 + stepRetries, o consumo é registrado por rodada e o registro continua consistente', async () => {
  const r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile')], authorized: ['a'], retries: 1 }), [a] = planApprovals(r.c);
  assert.deepEqual([a.uses, a.usesLeft, a.status, a.consumedRounds], [2, 1, 'approved', [1]], 'um uso gasto, um restante (a retentativa só pode usar o que sobrou)'); assert.equal(r.c.status, 'completed');
  const { approvalProblem } = await import('../policy.js'); assert.equal(approvalProblem(r.c), null);
  r.c.rounds[0].approvalId = 'apr_inexistente'; assert.match(approvalProblem(r.c), /autorização/); r.c.rounds[0].approvalId = a.id; a.consumedRounds = [7]; assert.match(approvalProblem(r.c), /rodada 7/); a.consumedRounds = [1]; assert.equal(approvalProblem(r.c), null);
});

test('autorização do plano: a etapa autorizada NÃO pode alterar OUTRO arquivo sensível: scope_exceeded continua valendo (a autorização cobre só o que foi aprovado)', async () => {
  const r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile')], authorized: ['a'], hook: (k) => { if (k === 1) fs.writeFileSync(path.join(wsDir, 'requirements.txt'), 'flask'); } }), c = r.c, rd = c.rounds[0];
  assert.equal(c.blockedCode, 'scope_exceeded'); assert.deepEqual(rd.scope.files, [{ path: 'requirements.txt', change: 'created', category: 'sensitive' }]); assert.ok(rd.scope.authorized.includes('Dockerfile')); assert.equal(rd.report.evidence.level, 'failed');
});

test('autorização do plano: falha ao gravar o ciclo com as autorizações => a missão NÃO começa (nada executa, nenhum ciclo nem autorização fica para trás)', async () => {
  fs.mkdirSync(`${DB_FILE}.tmp`); let r; try { r = await runAuth([done()], { steps: [step('a', [], 'produce', 'Dockerfile')], authorized: ['a'] }); } finally { fs.rmSync(`${DB_FILE}.tmp`, { recursive: true, force: true }); }
  assert.notEqual(r.res.status, 202); assert.equal(r.m.cycle, undefined); assert.equal(r.starts(), 0); assert.equal(fs.existsSync(path.join(wsDir, 'Dockerfile')), false); store.saveOrThrow();
});
