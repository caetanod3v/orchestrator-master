// Gate ESTRITO de conclusão (Incremento 2): "complete" só vale com evidência do SISTEMA "verified" na última rodada; o rótulo `assurance` vem desse parecer.
// Banco TEMPORÁRIO, workspaces TEMPORÁRIOS, CLI FALSA, Planner e verificador SIMULADOS. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'), bigDir = path.join(tmp, 'big'); fs.mkdirSync(wsDir); fs.mkdirSync(bigDir);
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { deliveryOf } = await import('../delivery.js');

let db, executor, startTaskRun, seq = 0, verStatus = 'pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
const OPT = [{ id: 'lint', script: 'lint', command: 'node lint', required: false, timeoutMs: 60000 }];
before(() => {
  db = store.load(); db.missions = [];
  db.workspaces = [{ id: 'wsN', name: 'sem', path: wsDir }, { id: 'wsR', name: 'obrigatoria', path: wsDir, verifications: REQ }, { id: 'wsO', name: 'opcional', path: wsDir, verifications: OPT }, { id: 'wsBig', name: 'grande', path: bigDir, verifications: REQ }];
  store.saveOrThrow();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
  fs.mkdirSync(path.join(bigDir, 'tests'));
  for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(bigDir, 'tests', `t${i}.test.js`), `// ${i}\n`); // acima do limite de arquivos vigiados: a integridade fica "desconhecida"
});
after(async () => { await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } }; };
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: verStatus, exitCode: verStatus === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: verStatus === 'pass' ? null : 'Terminou com código 1.' }) });
const mk = (planner, { ver = verifier(), multiStep = false } = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: ver, listFiles: () => [], multiStep });
const mkMission = (ws) => { const m = { id: `g${++seq}`, demo: false, title: `Missão G${seq}`, objective: 'obj', workspaceId: ws, createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const task = (title, { expected = true, file = 'x.txt', mode = 'produce' } = {}) => JSON.stringify({ decision: 'continue', rationale: title, task: { title, instructions: `MODE:${mode} FILE:${file} ${title}`, acceptance: [`${file} existe com o conteúdo gerado`], ...(expected ? { expectedFiles: [file] } : {}) } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['o Planner afirma que está pronto'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'sem prova', blockedReason: 'preciso de intervenção humana' });
async function run(ws, answers, { ver, max = 6, clean = true } = {}) {
  if (clean) for (const d of [wsDir]) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
  verStatus = 'pass';
  const m = mkMission(ws), planner = scripted(answers), cy = mk(planner, { ver });
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner };
}
const wsOf = (m) => db.workspaces.find((w) => w.id === m.workspaceId);

test('1. evidência inconclusiva sem comprovação suficiente: "complete" é rejeitado com motivo acionável, o ciclo não conclui e o Planner é reconsultado', async () => {
  const { c, planner } = await run('wsN', [task('criar x', { expected: false }), done(), blockedAns()]);
  assert.equal(c.rounds[0].report.evidence.level, 'inconclusive'); assert.equal(c.rounds[0].report.status, 'success');
  assert.equal(c.rejections.length, 1); assert.match(c.rejections[0].problem, /evidência do sistema para a última rodada é "inconclusive"/);
  assert.match(planner.calls[2], /REJEITADA/); assert.match(planner.calls[2], /expectedFiles/); assert.match(planner.calls[2], /"blocked"/);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_blocked'); assert.equal(c.assurance, undefined); assert.equal(c.deliveryContext?.status, undefined);
});

test('2. evidência "failed": a rejeição que já existia continua valendo (arquivo esperado ausente)', async () => {
  const { c } = await run('wsN', [task('criar x', { mode: 'nofile' }), done(), blockedAns()]);
  assert.equal(c.rounds[0].report.evidence.level, 'failed'); assert.match(c.rejections[0].problem, /a evidência da última rodada falhou/); assert.notEqual(c.status, 'completed');
});

test('3. integridade desconhecida: mesmo com a verificação obrigatória aprovada o ciclo não conclui nem recebe assurance "verified"', async () => {
  const { c, m } = await run('wsBig', [task('criar x'), done(), blockedAns()], { clean: false });
  const ev = c.rounds[0].report.evidence;
  assert.equal(c.rounds[0].report.verifications[0].status, 'pass'); assert.equal(ev.system.integrity, 'unknown'); assert.equal(ev.level, 'inconclusive');
  assert.match(ev.reasons.join(' '), /integridade dos testes não verificável/);
  assert.match(c.rejections[0].problem, /não "verified"/); assert.notEqual(c.status, 'completed'); assert.equal(c.assurance, undefined);
  assert.equal(deliveryOf(m, wsOf(m)).report.state.delivered, false);
});

test('4. verificação configurada e não executada (verificador indisponível): o Executor não a substitui por check autodeclarado, nem com arquivos esperados ok', async () => {
  for (const ws of ['wsO', 'wsR']) { // opcional e obrigatória
    const { c } = await run(ws, [task('criar x'), done(), blockedAns()], { ver: null });
    assert.equal(c.rounds[0].report.verificationsSkipped, 'o verificador não está disponível');
    assert.equal(c.rejections.length, 1, ws); assert.match(c.rejections[0].problem, /verifica[çc][ãa]o (real )?(configurada|obrigatória) não executada/, ws); assert.notEqual(c.status, 'completed', ws);
  }
});

test('5. fluxo válido: arquivos esperados conferidos + integridade aprovada conclui como "verified"; com verificação obrigatória aprovada também; relatório de entrega coerente', async () => {
  const a = await run('wsN', [task('criar x'), done()]);
  assert.equal(a.c.status, 'completed', a.c.blockedReason); assert.equal(a.c.assurance, 'verified'); assert.equal(a.c.rounds[0].report.evidence.level, 'verified');
  const ra = deliveryOf(a.m, wsOf(a.m)).report; assert.equal(ra.assurance.level, 'verified'); assert.equal(ra.declared.cycleAssuranceLabel, 'verified'); assert.equal(ra.state.delivered, true);
  const b = await run('wsR', [task('criar x'), done()]);
  assert.equal(b.c.status, 'completed', b.c.blockedReason); assert.equal(b.c.assurance, 'verified'); assert.equal(deliveryOf(b.m, wsOf(b.m)).report.assurance.level, 'verified');
});

test('6. retomada depois de limit_reached e depois de queda: o gate estrito continua valendo', async () => {
  // limit_reached -> retomar -> conclusão sem evidência é rejeitada; com evidência conclui
  const bare = (t) => task(t, { expected: false });
  const r = await run('wsN', [bare('a'), bare('b'), bare('c'), done(), task('d'), done()], { max: 1 });
  assert.equal(r.c.status, 'limit_reached');
  await sleep(5); assert.equal((await r.cy.resume(r.m.id, { maxIterations: 4 })).status, 202); await r.cy.idle();
  assert.match(r.c.rejections.at(-1).problem, /evidência do sistema/); assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified'); assert.equal(r.c.rounds.at(-1).report.evidence.level, 'verified');
  // queda: ciclo ativo com a última rodada sem prova independente -> recover() bloqueia; ao retomar, "complete" ainda é rejeitado
  const q = await run('wsN', [bare('a'), blockedAns(), done(), blockedAns()]);
  assert.equal(q.c.blockedCode, 'planner_blocked'); q.c.status = 'running'; q.c.blockedCode = null; q.cy.recover();
  assert.equal(q.c.blockedCode, 'restarted'); assert.equal((await q.cy.resume(q.m.id)).status, 202); await q.cy.idle();
  assert.match(q.c.rejections.at(-1).problem, /evidência do sistema/); assert.notEqual(q.c.status, 'completed');
});

test('7. registro histórico sem parecer de evidência: a conclusão segue as regras anteriores, mas NENHUMA evidência é inventada e a garantia não é "verified"', async () => {
  const { m, c, cy } = await run('wsR', [task('criar x'), blockedAns(), done()]);
  assert.equal(c.blockedCode, 'planner_blocked');
  delete c.rounds[0].report.evidence; delete c.rounds[0].integrity; // como um ciclo gravado antes do parecer do sistema
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'self-declared'); assert.equal(c.rounds[0].report.evidence, undefined);
  const r = deliveryOf(m, wsOf(m)).report; assert.equal(r.assurance.level, 'unverified'); assert.equal(r.verified.evidence[0].level, 'inconclusive'); assert.equal(r.verified.evidence[0].recordedByEvidenceModule, false);
});

test('8. prompt do Planner coerente com a regra: exige evidência "verified", não aceita checks do Executor e cita expectedFiles', async () => {
  const { planner } = await run('wsN', [task('criar x', { expected: false }), blockedAns()]);
  const p = planner.calls[1];
  assert.match(p, /"expectedFiles"/); assert.match(p, /nível "verified"/); assert.match(p, /REJEITA "complete" quando o nível é "inconclusive" ou "failed"/); assert.match(p, /nunca substituem essa evidência/);
  assert.match(p, /checks autodeclarados do Executor NÃO valem como prova/);
  assert.ok(!/o backend rejeita "complete" sem isso/.test(p), 'a frase antiga (só "verificações aprovadas") saiu do prompt');
});
