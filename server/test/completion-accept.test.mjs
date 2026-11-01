// Incremento 2.1: aceitação HUMANA e explícita de uma conclusão SEM evidência "verified" (cycle.acceptUnverified + rota + relatório de entrega).
// Banco TEMPORÁRIO, workspaces TEMPORÁRIOS, CLI FALSA, Planner e verificador SIMULADOS. Nenhum modelo é chamado e nenhum dado real é tocado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-accept-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`;
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, setupCycle } = await import('../cycle.js');
const { deliveryOf, acceptanceDigest } = await import('../delivery.js');

let db, executor, startTaskRun, seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
before(() => {
  db = store.load(); db.missions = [];
  db.workspaces = [{ id: 'wsN', name: 'sem', path: wsDir }, { id: 'wsR', name: 'obrigatoria', path: wsDir, verifications: REQ }];
  store.saveOrThrow();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const scripted = (answers) => ({ busy: () => false, cancel: async () => {}, decide: async () => { const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } });
const verifier = (status = 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'Terminou com código 1.' }) });
const deps = (planner, ver) => ({ db, executor, planner, startTaskRun, verifier: ver === undefined ? verifier() : ver, listFiles: () => [], multiStep: false });
const mkMission = (ws) => { const m = { id: `a${++seq}`, demo: false, title: `Missão A${seq}`, objective: 'obj', workspaceId: ws, createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const task = (title, { expected = true, file = 'x.txt', mode = 'produce' } = {}) => JSON.stringify({ decision: 'continue', rationale: title, task: { title, instructions: `MODE:${mode} FILE:${file} ${title}`, acceptance: [`${file} existe com o conteúdo gerado`], ...(expected ? { expectedFiles: [file] } : {}) } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['o Planner afirma que está pronto'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'sem prova', blockedReason: 'preciso de intervenção humana' });
async function run(ws, answers, { ver } = {}) {
  for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true });
  const m = mkMission(ws), cy = createCycle(deps(scripted(answers), ver));
  assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy };
}
// Ciclo bloqueado pelo Planner depois de rejeitar "complete" por evidência INCONCLUSIVA (o cenário elegível para a aceitação).
const inconclusive = () => run('wsN', [task('criar x', { expected: false }), done(), blockedAns()]);
const wsOf = (m) => db.workspaces.find((w) => w.id === m.workspaceId);
const body = (c, over = {}) => ({ cycleId: c.id, round: c.rounds.at(-1).n, evidenceLevel: c.rounds.at(-1).report.evidence.level, reason: 'Revisei o resultado manualmente e aceito.', confirm: true, ...over });
const report = (m) => deliveryOf(m, wsOf(m)).report;
const snap = (c) => JSON.stringify({ s: c.status, f: c.finishedAt, bc: c.blockedCode, br: c.blockedReason, fs: c.finalSummary, a: c.assurance, acc: c.acceptance, ctx: c.deliveryContext, d: c.delivery, r: c.rounds });

test('1. conclusão normal com evidência "verified": continua igual e não há aceitação humana', async () => {
  const { m, c } = await run('wsN', [task('criar x'), done()]);
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified'); assert.equal(c.acceptance, undefined);
  const r = report(m); assert.equal(r.assurance.level, 'verified'); assert.equal(r.state.acceptedUnverified, false); assert.deepEqual(r.acceptance, { recorded: false, valid: false });
});

test('2. sem evidência verificada e sem aceitação humana: "complete" continua rejeitado, o ciclo fica bloqueado e nada é aceito sozinho', async () => {
  const { m, c } = await inconclusive();
  assert.equal(c.rounds[0].report.evidence.level, 'inconclusive'); assert.equal(c.rejections.length, 1);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_blocked'); assert.equal(c.acceptance, undefined); assert.equal(c.assurance, undefined);
  const r = report(m); assert.equal(r.state.code, 'blocked'); assert.equal(r.state.delivered, false); assert.equal(r.state.acceptedUnverified, false); assert.equal(r.assurance.level, 'not_applicable'); assert.equal(r.acceptance.recorded, false);
});

test('3. aceitação explícita válida: conclui SEM virar verified, preserva a evidência original e fica registrada', async () => {
  const { m, c, cy } = await inconclusive();
  const evBefore = JSON.stringify(c.rounds[0].report.evidence), roundsBefore = JSON.stringify(c.rounds);
  await sleep(5);
  const res = cy.acceptUnverified(m.id, body(c)); assert.equal(res.status, 200, res.error);
  assert.equal(c.status, 'completed'); assert.equal(c.blockedCode, null); assert.notEqual(c.finishedAt, null);
  assert.equal(c.assurance, 'self-declared', 'o rótulo do ciclo nunca vira verified'); assert.equal(JSON.stringify(c.rounds[0].report.evidence), evBefore); assert.equal(JSON.stringify(c.rounds), roundsBefore, 'nenhuma rodada foi alterada');
  const a = c.acceptance;
  assert.equal(a.kind, 'unverified_acceptance'); assert.equal(a.by, 'user'); assert.equal(a.cycleId, c.id); assert.equal(a.round, 1); assert.equal(a.reason, 'Revisei o resultado manualmente e aceito.'); assert.ok(a.at);
  assert.equal(a.evidence.level, 'inconclusive'); assert.ok(a.evidence.reasons.length > 0); assert.equal(a.priorBlock.code, 'planner_blocked'); assert.equal(a.digest, acceptanceDigest(c, a));
  assert.equal(c.deliveryContext.status, 'completed'); assert.equal(c.deliveryContext.cycleId, c.id);
  const r = report(m);
  assert.equal(r.state.code, 'completed'); assert.equal(r.state.delivered, true); assert.equal(r.state.acceptedUnverified, true);
  assert.equal(r.assurance.level, 'accepted_unverified'); assert.notEqual(r.assurance.level, 'verified'); assert.equal(r.verified.evidence[0].level, 'inconclusive');
  assert.equal(r.acceptance.recorded, true); assert.equal(r.acceptance.valid, true); assert.equal(r.acceptance.by, 'user'); assert.equal(r.acceptance.evidenceAtDecision.level, 'inconclusive');
  assert.match(r.limitations.join('\n'), /NÃO verificou/); assert.match(r.assurance.reasons.join(' '), /SEM evidência verificada/); assert.equal(r.declared.cycleAssuranceLabel, 'self-declared');
  assert.equal(cy.acceptUnverified(m.id, body(c)).status, 409, 'depois de concluído não há segunda aceitação');
});

test('4. evidência "failed": a aceitação é rejeitada e o estado não muda', async () => {
  const { m, c, cy } = await run('wsN', [task('criar x', { mode: 'nofile' }), done(), blockedAns()]);
  assert.equal(c.rounds[0].report.evidence.level, 'failed'); assert.equal(c.status, 'blocked');
  const before = snap(c);
  for (const lvl of ['failed', 'inconclusive']) { const res = cy.acceptUnverified(m.id, body(c, { evidenceLevel: lvl })); assert.equal(res.status, 409, lvl); assert.match(res.error, /FALHOU/); }
  assert.equal(snap(c), before); assert.equal(c.acceptance, undefined); assert.equal(report(m).state.acceptedUnverified, false);
});

test('5. verificação obrigatória reprovada ou não executada: a aceitação é rejeitada', async () => {
  const failing = await run('wsR', [task('criar x'), done(), blockedAns()], { ver: verifier('fail') });
  assert.equal(failing.c.status, 'blocked'); const b1 = snap(failing.c);
  const r1 = failing.cy.acceptUnverified(failing.m.id, body(failing.c)); assert.equal(r1.status, 409, r1.error); assert.equal(snap(failing.c), b1); assert.equal(failing.c.acceptance, undefined);
  const skipped = await run('wsR', [task('criar x'), done(), blockedAns()], { ver: null });
  assert.equal(skipped.c.status, 'blocked'); const b2 = snap(skipped.c);
  const r2 = skipped.cy.acceptUnverified(skipped.m.id, body(skipped.c)); assert.equal(r2.status, 409, r2.error); assert.match(r2.error, /não executada|FALHOU/); assert.equal(snap(skipped.c), b2); assert.equal(skipped.c.acceptance, undefined);
});

test('6. missão ou ciclo incorretos, pedido incompleto e estados que não podem ser aceitos', async () => {
  const a = await inconclusive(), b = await inconclusive(); const before = snap(a.c);
  assert.equal(a.cy.acceptUnverified('nao-existe', body(a.c)).status, 404);
  assert.equal(a.cy.acceptUnverified(a.m.id, body(b.c)).status, 409, 'cycleId de OUTRA missão'); assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { cycleId: 'cyc_antigo' })).status, 409); assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { cycleId: undefined })).status, 409);
  assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { round: 2 })).status, 409, 'rodada que não é a última'); assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { round: undefined })).status, 409);
  assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { evidenceLevel: 'verified' })).status, 409, 'nível de evidência que não é o atual');
  assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { confirm: undefined })).status, 400); assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { confirm: 'true' })).status, 400);
  assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { reason: 'curto' })).status, 400); assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c, { reason: 'x'.repeat(501) })).status, 400);
  assert.equal(snap(a.c), before, 'nenhuma tentativa inválida alterou o ciclo'); assert.equal(a.c.acceptance, undefined);
  for (const code of ['restarted', 'approval_required', 'persistence_failed', 'verification_blocked']) { // outros bloqueios não são aceitáveis
    const prev = a.c.blockedCode; a.c.blockedCode = code; assert.equal(a.cy.acceptUnverified(a.m.id, body(a.c)).status, 409, code); a.c.blockedCode = prev;
  }
  const ok = await run('wsN', [task('criar x'), done()]); assert.equal(ok.cy.acceptUnverified(ok.m.id, body(ok.c)).status, 409, 'ciclo já concluído'); assert.equal(ok.c.acceptance, undefined);
  const noCycle = mkMission('wsN'); assert.equal(a.cy.acceptUnverified(noCycle.id, body(a.c)).status, 404);
});

test('7. falha de persistência durante a aceitação: nada fica parcialmente concluído e a aceitação pode ser refeita depois', async () => {
  const { m, c, cy } = await inconclusive(); const before = snap(c);
  fs.mkdirSync(BLOCK_TMP, { recursive: true });
  let res; try { const e = console.error; console.error = () => {}; try { res = cy.acceptUnverified(m.id, body(c)); } finally { console.error = e; } } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal(res.status, 503, res.error); assert.match(res.error, /NÃO foi registrada|NÃO foi gravad|não pôde ser gravado/i);
  assert.equal(snap(c), before, 'status, finishedAt, bloqueio, resumo, rótulo, aceitação e contexto voltaram exatamente ao que eram');
  assert.equal(c.status, 'blocked'); assert.equal(c.acceptance, undefined); assert.equal(report(m).state.acceptedUnverified, false);
  store.saveOrThrow(); // o disco volta a gravar: o estado bloqueado é regravado e a aceitação, refeita, passa
  const again = cy.acceptUnverified(m.id, body(c)); assert.equal(again.status, 200, again.error); assert.equal(c.status, 'completed');
});

test('8. persistência e recuperação: a decisão sobrevive ao disco e ao reler o banco', async () => {
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')), dm = disk.missions.find((x) => x.id === m.id);
  assert.deepEqual(dm.cycle.acceptance, JSON.parse(JSON.stringify(c.acceptance))); assert.equal(dm.cycle.status, 'completed'); assert.equal(dm.cycle.assurance, 'self-declared');
  const r = deliveryOf(dm, disk.workspaces.find((w) => w.id === dm.workspaceId)).report;
  assert.equal(r.assurance.level, 'accepted_unverified'); assert.equal(r.acceptance.valid, true); assert.equal(r.acceptance.cycleId, c.id);
  assert.equal(createCycle(deps(scripted([]))).acceptUnverified(m.id, body(c)).status, 409, 'uma instância nova (reinício) também vê o ciclo concluído');
});

test('9. relatório de entrega: a aceitação nunca vira "verified"; adulteração, registro forjado e dado histórico não geram aceitação', async () => {
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  const variant = (mut) => { const x = structuredClone(m); mut(x.cycle); return deliveryOf(x, wsOf(m)).report; };
  const invalid = (r, re) => { assert.equal(r.acceptance.recorded, true); assert.equal(r.acceptance.valid, false); assert.notEqual(r.assurance.level, 'accepted_unverified'); assert.equal(r.state.acceptedUnverified, false); assert.match(r.acceptance.invalidReasons.join(' '), re); assert.match(r.limitations.join('\n'), /NÃO vale mais/); };
  invalid(variant((x) => { x.rounds[0].report.evidence.reasons.push('adulterado'); }), /mudou depois da aceitação/);
  invalid(variant((x) => { x.rounds[0].report.evidence.level = 'verified'; }), /inconclusiva|mudou/); // dado adulterado para verified: a aceitação cai (o relatório já lia a evidência gravada, como antes)
  invalid(variant((x) => { x.rounds[0].report.evidence.level = 'failed'; }), /inconclusiva|mudou/);
  invalid(variant((x) => { x.acceptance.by = 'planner'; }), /decisão humana/);
  invalid(variant((x) => { x.acceptance.cycleId = 'cyc_outro'; }), /outro ciclo/);
  invalid(variant((x) => { x.rounds.push({ ...x.rounds[0], n: 2 }); }), /mudou depois da aceitação/);
  const legacy = variant((x) => { delete x.acceptance; }); assert.equal(legacy.acceptance.recorded, false); assert.equal(legacy.assurance.level, 'unverified'); assert.equal(legacy.state.acceptedUnverified, false);
  const forged = variant((x) => { x.acceptance = { kind: 'unverified_acceptance', by: 'user', cycleId: x.id, digest: 'x'.repeat(64), evidence: { level: 'inconclusive' } }; delete x.rounds[0].report.evidence; }); assert.equal(forged.assurance.level, 'unverified'); assert.equal(forged.acceptance.valid, false);
  assert.equal(report(m).assurance.level, 'accepted_unverified', 'o registro real continua válido (as variantes eram cópias)');
});

test('10. retomada ou novo ciclo: a decisão antiga não autoriza o estado novo', async () => {
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  assert.equal((await cy.resume(m.id)).status, 409, 'ciclo concluído não retoma');
  await sleep(5);
  const cy2 = createCycle(deps(scripted([task('criar y', { expected: false, file: 'y.txt' }), done(), blockedAns()])));
  assert.equal((await cy2.start(m.id, 6)).status, 202); await cy2.idle();
  const c2 = m.cycle; assert.notEqual(c2.id, c.id); assert.equal(c2.acceptance, undefined, 'o ciclo novo nasce sem aceitação'); assert.equal(c2.status, 'blocked');
  assert.equal(m.pastCycles[0].id, c.id); assert.equal(m.pastCycles[0].acceptance.cycleId, c.id, 'o histórico guarda a decisão do ciclo antigo');
  const r = report(m); assert.equal(r.state.code, 'blocked'); assert.equal(r.state.delivered, false); assert.equal(r.state.acceptedUnverified, false); assert.equal(r.acceptance.recorded, false);
  assert.equal(cy2.acceptUnverified(m.id, body(c2, { cycleId: c.id })).status, 409, 'o id do ciclo antigo não vale para o novo');
  assert.equal(cy2.acceptUnverified(m.id, body(c2, { reason: 'Aceito o ciclo novo também.' })).status, 200, 'o ciclo novo exige a PRÓPRIA decisão explícita');
  assert.notEqual(m.cycle.acceptance.cycleId, c.id);
  // retomada de um ciclo bloqueado (mesmo ciclo) não carrega aceitação: ela só existe depois de concluir
  const b = await inconclusive(); assert.equal(b.c.acceptance, undefined);
  const cy3 = createCycle(deps(scripted([task('criar z', { expected: false, file: 'z.txt' }), done(), blockedAns()])));
  assert.equal((await cy3.resume(b.m.id, { note: 'tente de novo' })).status, 202); await cy3.idle();
  assert.equal(b.c.acceptance, undefined); assert.equal(b.c.status, 'blocked'); assert.equal(report(b.m).state.acceptedUnverified, false);
});

// ---- correções A–F (revisão de segurança do Incremento 2.1) ----
const withDigest = (x) => { x.acceptance.digest = acceptanceDigest(x, x.acceptance); return x; }; // simula quem edita o banco e recalcula o digest (o digest NÃO é proteção criptográfica)

test('A. a aceitação é decisão humana: não aparece como declaração do Planner nem na atividade com origem "planner"', async () => {
  const normal = await run('wsN', [task('criar x'), done()]);
  assert.ok(report(normal.m).declared.plannerSummary, 'conclusão normal continua sendo declaração do Planner'); assert.equal(report(normal.m).declared.plannerSummary.origin, 'planner');
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  const r = report(m);
  assert.equal(r.declared.plannerSummary, null, 'o motivo humano não é "declaração do Planner"'); assert.match(r.limitations.join('\n'), /decisão humana de aceitação/);
  assert.equal(r.acceptance.reason, 'Revisei o resultado manualmente e aceito.'); assert.equal(r.acceptance.by, 'user');
  const acts = db.activity.filter((x) => x.missionId === m.id && /aceita por uma pessoa/.test(x.message)); assert.equal(acts.length, 1);
  assert.equal(acts[0].agent, 'user'); assert.notEqual(acts[0].agent, 'planner');
});

test('B. accepted_unverified exige que o ÚNICO impedimento seja a evidência inconclusiva (mesmo com o digest recalculado)', async () => {
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  const variant = (mut) => { const x = structuredClone(m); mut(x.cycle); withDigest(x.cycle); return deliveryOf(x, wsOf(m)).report; };
  const base = variant(() => {}); assert.equal(base.assurance.level, 'accepted_unverified', 'controle: sem outro impedimento vale');
  for (const [nome, mut] of [
    ['alterações em teste pendentes', (x) => { x.integrity = { ...(x.integrity ?? {}), pending: [{ path: 'a.test.js', hash: 'h' }] }; }],
    ['última execução sem sucesso', (x) => { x.rounds.at(-1).report.status = 'error'; }],
  ]) {
    const r = variant(mut); assert.equal(r.acceptance.valid, true, `${nome}: o registro em si é válido`);
    assert.equal(r.assurance.level, 'unverified', nome); assert.equal(r.state.acceptedUnverified, false, nome); assert.ok(r.assurance.reasons.length >= 2, nome);
  }
});

test('C. persistência: falha ao gravar não deixa NENHUM campo tocado, e falha em efeito posterior não desfaz a decisão já gravada', async () => {
  const a = await inconclusive(); const before = snap(a.c);
  fs.mkdirSync(BLOCK_TMP, { recursive: true });
  let res; try { const e = console.error; console.error = () => {}; try { res = a.cy.acceptUnverified(a.m.id, body(a.c)); } finally { console.error = e; } } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal(res.status, 503); assert.equal(snap(a.c), before);
  for (const k of ['acceptance', 'assurance']) assert.equal(Object.hasOwn(a.c, k), false, `${k} não pode sobrar (nem como undefined)`);
  assert.equal(a.c.blockedCode, 'planner_blocked'); assert.equal(a.c.status, 'blocked');
  assert.equal(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === a.m.id).cycle.acceptance, undefined, 'o disco não recebeu a aceitação');
  store.saveOrThrow();
  // efeito posterior (atividade) falha DEPOIS da gravação confirmada: a aceitação já está no disco, então o estado e a resposta continuam coerentes
  const b = await inconclusive(); const savedActivity = db.activity; db.activity = null;
  let rb; try { rb = b.cy.acceptUnverified(b.m.id, body(b.c)); } finally { db.activity = savedActivity; }
  assert.equal(rb.status, 200, rb.error); assert.equal(b.c.status, 'completed'); assert.ok(b.c.acceptance);
  const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === b.m.id).cycle;
  assert.equal(disk.status, 'completed'); assert.equal(disk.acceptance.digest, b.c.acceptance.digest, 'memória e disco concordam');
});

test('D. o registro da aceitação é validado: rodada, motivo, instante e autor; qualquer alteração invalida', async () => {
  const { m, c, cy } = await inconclusive(); assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200);
  const rep = (mut, redigest = false) => { const x = structuredClone(m); mut(x.cycle); if (redigest) withDigest(x.cycle); return deliveryOf(x, wsOf(m)).report; };
  const invalid = (r, re) => { assert.equal(r.acceptance.valid, false); assert.match(r.acceptance.invalidReasons.join(' '), re); assert.notEqual(r.assurance.level, 'accepted_unverified'); assert.equal(r.state.acceptedUnverified, false); };
  invalid(rep((x) => { x.acceptance.reason = 'Outro motivo qualquer, trocado.'; }), /mudou depois/);
  invalid(rep((x) => { x.acceptance.at = '2000-01-01T00:00:00.000Z'; }), /mudou depois/);
  invalid(rep((x) => { x.acceptance.round = 9; }, true), /última rodada/);
  invalid(rep((x) => { x.acceptance.round = '1'; }, true), /última rodada/);
  invalid(rep((x) => { x.acceptance.reason = 'curto'; }, true), /incompleto/);
  invalid(rep((x) => { delete x.acceptance.at; }, true), /incompleto/);
  assert.notEqual(acceptanceDigest(c, { by: 'user', at: 'T', round: 1, reason: 'um motivo longo A' }), acceptanceDigest(c, { by: 'user', at: 'T', round: 1, reason: 'um motivo longo B' }));
  assert.notEqual(acceptanceDigest(c, null), acceptanceDigest(c, { by: 'user', at: 'T', round: 1, reason: 'um motivo longo A' }));
});

test('E. execução ativa, Planner ocupado, plano ou aprovações inconsistentes e aprovação pendente impedem a aceitação sem alterar nada', async () => {
  const { m, c } = await inconclusive(); const before = snap(c);
  const mk = (over) => createCycle({ ...deps(scripted([])), ...over });
  const busyEx = Object.assign(Object.create(executor), { isBusy: () => true });
  const r1 = mk({ executor: busyEx }).acceptUnverified(m.id, body(c)); assert.equal(r1.status, 409); assert.match(r1.error, /execução|ciclo/i);
  const r2 = mk({ planner: { ...scripted([]), busy: () => true } }).acceptUnverified(m.id, body(c)); assert.equal(r2.status, 409);
  const cy = mk({});
  c.plan = { id: 'p1', steps: 'quebrado' }; assert.equal(cy.acceptUnverified(m.id, body(c)).status, 409, 'plano inconsistente'); delete c.plan;
  c.approvals = [{ id: 'ap1', digest: 'd', status: 'pending' }]; const r3 = cy.acceptUnverified(m.id, body(c)); assert.equal(r3.status, 409); assert.match(r3.error, /aprovação pendente/); delete c.approvals;
  c.approvals = [{ id: 7 }]; assert.equal(cy.acceptUnverified(m.id, body(c)).status, 409, 'registro de aprovações inconsistente'); delete c.approvals;
  assert.equal(snap(c), before, 'nenhuma recusa alterou o ciclo'); assert.equal(c.acceptance, undefined);
  assert.equal(cy.acceptUnverified(m.id, body(c)).status, 200, 'sem os impedimentos, a aceitação passa');
});

test('F. motivo: tipo, quebras de linha, caracteres úteis e limite; rodada e ciclo com tipo errado', async () => {
  const { m, c, cy } = await inconclusive(); const before = snap(c);
  for (const reason of [123, {}, [], null, true, undefined, '          ', '\n\n\n\n\n\n\n\n\n\n\n', 'a b c d e f', 'x'.repeat(501)]) assert.equal(cy.acceptUnverified(m.id, body(c, { reason })).status, 400, JSON.stringify(reason)?.slice(0, 30));
  for (const over of [{ round: '1' }, { round: 1.5 }, { round: null }, { cycleId: 123 }, { cycleId: {} }, { evidenceLevel: 5 }, { evidenceLevel: {} }]) assert.equal(cy.acceptUnverified(m.id, body(c, over)).status, 409, JSON.stringify(over));
  assert.equal(snap(c), before, 'entradas inválidas não alteram o ciclo');
  const res = cy.acceptUnverified(m.id, body(c, { reason: `  Conferi tudo\r\nna mão\rcom cuidado\u0007!!  ` })); assert.equal(res.status, 200, res.error);
  assert.equal(c.acceptance.reason, 'Conferi tudo\nna mão\ncom cuidado!!', 'quebras normalizadas para \\n e controles removidos');
  assert.ok(!/[\r\n]/.test(c.finalSummary), 'o resumo final fica em uma linha'); assert.equal(c.acceptance.digest, acceptanceDigest(c, c.acceptance));
  const edge = await inconclusive(); assert.equal(edge.cy.acceptUnverified(edge.m.id, body(edge.c, { reason: 'y'.repeat(500) })).status, 200, 'exatamente 500 ainda vale');
});

test('rota POST /api/missions/:id/cycle/accept-unverified: valida o corpo, aceita só o pedido explícito e responde com o ciclo', async () => {
  const { m, c } = await inconclusive();
  const app = express(); app.use(express.json());
  setupCycle(app, deps(scripted([])));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api/missions`;
    const post = async (id, b) => { const r = await fetch(`${base}/${id}/cycle/accept-unverified`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
    assert.equal((await post(m.id, {})).status, 400); assert.equal((await post('nao-existe', body(c))).status, 404); assert.equal((await post(m.id, body(c, { cycleId: 'cyc_x' }))).status, 409);
    for (const raw of ['null', '[]', '"texto"', '{']) { const r = await fetch(`${base}/${m.id}/cycle/accept-unverified`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: raw }); assert.ok([400, 409].includes(r.status), `corpo ${raw}: ${r.status}`); }
    assert.equal((await post(m.id, body(c, { reason: 12345678901 }))).status, 400, 'motivo numérico');
    assert.equal(c.status, 'blocked'); assert.equal((await fetch(`${base}/${m.id}/cycle/accept-unverified`)).status, 404, 'só POST');
    const ok = await post(m.id, body(c)); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, 'completed'); assert.equal(ok.body.acceptance.by, 'user'); assert.equal(ok.body.assurance, 'self-declared');
  } finally { await new Promise((r) => srv.close(r)); }
});
