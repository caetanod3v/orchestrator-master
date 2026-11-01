// Relatório de entrega (server/delivery.js + integração em cycle.js + GET /api/missions/:id/delivery).
// Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, Planner e verificador SIMULADOS; a rota é testada num servidor REAL (index.js) com banco temporário semeado.
// Nenhum modelo é chamado e nenhum dado real é tocado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-delivery-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`;
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const here = path.dirname(fileURLToPath(import.meta.url)), FAKE = path.join(here, 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { buildDelivery, deliveryOf, frozenContextOf, closingContext, DELIVERY_SCHEMA } = await import('../delivery.js');

let db, executor, startTaskRun, seq = 0, verStatus = 'pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERIFS = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
before(() => {
  db = store.load(); db.missions = [];
  db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: VERIFS }, { id: 'ws0', name: 'ws0', path: wsDir }];
  store.saveOrThrow();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const resetWs = () => { for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true }); fs.mkdirSync(path.join(wsDir, 'tests')); fs.writeFileSync(path.join(wsDir, 'tests', 'old.test.js'), '// teste original\n'); };
const scripted = (answers, hook) => ({ busy: () => false, cancel: async () => {}, decide: async () => { hook?.(answers.length); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } });
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: verStatus, exitCode: verStatus === 'pass' ? 0 : 1, durationMs: 5, outputTail: 'saida', truncated: false, reason: verStatus === 'pass' ? null : 'Terminou com código 1.' }) });
const mk = (planner, multiStep = true) => createCycle({ db, executor, planner, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep });
const mkMission = (ws, over = {}) => { const m = { id: `d${++seq}`, demo: false, title: `Missão D${seq}`, objective: 'objetivo', workspaceId: ws, createdAt: 'T0', tasks: [], ...over }; db.missions.push(m); return m; };
const step = (id, deps = [], mode = 'produce', file = `${id}.txt`) => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: deps });
const plan = (steps) => JSON.stringify({ decision: 'plan', rationale: 'dividir', steps });
const cont = (title, file = 'x.txt') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:produce FILE:${file} ${title}`, acceptance: [`${file} existe com o conteúdo gerado`], expectedFiles: [file] } });
const contBare = (title, file = 'x.txt') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:produce FILE:${file} ${title}`, acceptance: [`${file} existe com o conteúdo gerado`] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'Tudo certo, segundo o Planner.', evidence: ['o Planner afirma que x.txt existe'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'preciso de ajuda', blockedReason: 'decisão humana' });
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
async function run(answers, { ws = 'ws0', multiStep = true, max = 6, hook } = {}) {
  resetWs(); verStatus = 'pass';
  const m = mkMission(ws), cy = mk(scripted(answers, hook), multiStep);
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy };
}
const dig = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

// ---------- fixtures de dados gravados (o que o servidor deixa no banco) ----------
const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const EV = (level, over = {}) => ({ level, basis: level === 'verified' ? 'real_verification' : 'executor_claim_only', reasons: level === 'verified' ? [] : ['motivo gravado'], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0, note: 'x' }, system: { verification: level === 'verified' ? 'passed' : 'none', verifications: [], expectedFiles: null, integrity: 'clean' }, ...over });
const rep = (over = {}) => ({ status: 'success', summary: 'o Executor diz que fez', filesChanged: [], filesKnown: true, checks: [{ name: 'releitura', result: 'pass', detail: '' }], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [], verificationsSkipped: null, verificationsInterrupted: null, ...over });
const rnd = (n, over = {}) => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, agent: 'code', plan: { title: `Rodada ${n}`, rationale: 'r' }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: rep({ evidence: EV('verified', { system: { verification: 'passed', verifications: [], expectedFiles: null, integrity: 'clean' } }), verifications: [REAL_PASS] }), verification: 'passed', decision: null, ...over });
const mis = (cycle, over = {}) => ({ id: 'mx', demo: false, title: 'Missão X', objective: 'obj', workspaceId: 'w', createdAt: 'T0', tasks: [], cycle, ...over });
const cyc = (status, rounds, over = {}) => ({ id: 'cy1', status, maxIterations: 5, rounds, plannerCalls: 1, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, startedAt: 'A', finishedAt: ['completed', 'cancelled', 'limit_reached'].includes(status) ? 'B' : null, ...over });
const W = { id: 'w', name: 'WS', verifications: [{ script: 'test', required: true, command: 'npm run test' }] };

test('contrato: campos mínimos, esquema, camadas separadas e legenda; nada de entrega sem ciclo concluído', () => {
  const r = buildDelivery(mis(cyc('completed', [rnd(1)], { finalSummary: 'Concluído, diz o Planner', evidence: ['o Planner afirma X'], assurance: 'verified' })), W, { now: () => 'AGORA' });
  assert.equal(r.schemaVersion, DELIVERY_SCHEMA); assert.equal(r.generatedAt, 'AGORA'); assert.equal(r.source, 'recomputed');
  assert.deepEqual([r.mission.id, r.mission.title, r.mission.workspace.name], ['mx', 'Missão X', 'WS']);
  for (const k of ['declared', 'observed', 'verified', 'assurance', 'limitations', 'state', 'cycle', 'legend']) assert.ok(k in r, k);
  assert.equal(r.state.code, 'completed'); assert.equal(r.state.delivered, true);
  assert.equal(r.declared.plannerSummary.origin, 'planner'); assert.match(r.declared.plannerSummary.label, /declaração do Planner/);
  // o que o Planner disse NUNCA aparece nas camadas observada/verificada
  const rest = JSON.stringify({ o: r.observed, v: r.verified });
  assert.ok(!rest.includes('Concluído, diz o Planner') && !rest.includes('o Planner afirma X'));
  assert.equal(r.verified.verifications[0].status, 'pass'); assert.equal(r.verified.verifications[0].round, 1);
  assert.equal(r.assurance.level, 'verified');
  assert.equal(r.declared.cycleAssuranceLabel, 'verified'); // rótulo do ciclo é só declarado: não alimenta a garantia
});

test('só "completed" é entrega: bloqueada, cancelada, limite, em andamento, sem ciclo e demo NUNCA aparecem como concluídas', () => {
  const cases = [
    [cyc('blocked', [rnd(1)], { blockedCode: 'planner_blocked', blockedReason: 'preciso de decisão' }), 'blocked', /planner_blocked/],
    [cyc('cancelled', [rnd(1)]), 'cancelled', /cancelado/],
    [cyc('limit_reached', [rnd(1)]), 'limit_reached', /Limite de 5 rodadas/],
    [cyc('running', [rnd(1)]), 'in_progress', /andamento/],
    [cyc('planning', []), 'in_progress', /andamento/],
    [cyc('estado-estranho', []), 'unknown', /não reconhecido/],
  ];
  for (const [c, code, re] of cases) {
    const r = buildDelivery(mis(c, { id: code }), W);
    assert.equal(r.state.code, code); assert.equal(r.state.delivered, false, code); assert.match(r.state.reasons.join(' '), re);
    assert.equal(r.assurance.level, 'not_applicable', code); assert.equal(r.declared.plannerSummary, null);
  }
  const noCycle = buildDelivery(mis(undefined, { tasks: [{ id: 't', title: 'manual', status: 'completed', report: 'feito', files: [{ path: 'a.js', status: 'M' }], exitCode: 0 }] }), W);
  assert.equal(noCycle.state.code, 'no_cycle'); assert.equal(noCycle.state.delivered, false); assert.equal(noCycle.observed.files.items[0].path, 'a.js'); assert.equal(noCycle.declared.manualTaskReports[0].origin, 'executor');
  const demo = buildDelivery(mis(undefined, { demo: true }), null); assert.equal(demo.state.code, 'demo'); assert.equal(demo.state.delivered, false);
});

test('missão interrompida/reiniciada: bloqueada, com resultado INCERTO e arquivos desconhecidos, sem apresentar sucesso', () => {
  const r = rnd(1, { status: 'interrupted', report: rep({ status: 'interrupted', filesKnown: false, outcomeUncertain: 'o servidor caiu', exitCode: null }), verification: 'none' });
  const out = buildDelivery(mis(cyc('blocked', [r], { blockedCode: 'restarted', blockedReason: 'O servidor foi reiniciado' })), W);
  assert.equal(out.state.delivered, false); assert.equal(out.observed.rounds[0].uncertainOutcome, 'o servidor caiu');
  assert.deepEqual(out.observed.files.unknownRounds, [1]);
  assert.match(out.limitations.join('\n'), /Rodada 1: o servidor caiu/); assert.match(out.limitations.join('\n'), /desconhecidos nas rodadas 1/);
});

test('evidência verificada, inconclusiva, falha e ausente: a garantia só é "verified" com evidência verificada; inconclusiva/ausente nunca viram positivas', () => {
  const lvl = (rounds, ws = W, extra = {}) => buildDelivery(mis(cyc('completed', rounds, { finalSummary: 'ok', evidence: ['e'], ...extra })), ws).assurance;
  assert.equal(lvl([rnd(1)]).level, 'verified');
  const inc = lvl([rnd(1, { report: rep({ evidence: EV('inconclusive'), verifications: [] }), verification: 'none' })], { id: 'w', name: 'w', verifications: [] });
  assert.equal(inc.level, 'unverified'); assert.match(inc.reasons.join(' '), /inconclusiva/);
  const failed = lvl([rnd(1, { report: rep({ evidence: EV('failed') }), verification: 'failed' })]);
  assert.equal(failed.level, 'unverified'); assert.match(failed.reasons.join(' '), /FALHOU/);
  const absent = lvl([rnd(1, { report: rep({ verifications: [] }), verification: 'none' })], { id: 'w', name: 'w', verifications: [] });
  assert.equal(absent.level, 'unverified'); assert.match(absent.reasons.join(' '), /não há evidência do sistema/);
  assert.equal(lvl([]).level, 'unverified'); // "concluído" sem nenhuma rodada: sem sustentação
  const lim = buildDelivery(mis(cyc('completed', [rnd(1, { report: rep({ evidence: EV('inconclusive') }), verification: 'none' })])), { id: 'w', name: 'w', verifications: [] }).limitations.join('\n');
  assert.match(lim, /SEM garantia verificada/); assert.match(lim, /não tem verificações reais configuradas/);
});

test('verificação obrigatória ausente na última rodada, alterações de testes pendentes e etapas abertas rebaixam a garantia e viram limitações', () => {
  const noRun = rnd(1, { report: rep({ evidence: EV('verified'), verifications: [] }), verification: 'none' });
  const a = buildDelivery(mis(cyc('completed', [noRun], { finalSummary: 'ok', evidence: ['e'] })), W);
  assert.equal(a.assurance.level, 'unverified'); assert.deepEqual(a.verified.missing, [{ script: 'test', required: true, reason: 'não executada na última rodada' }]);
  assert.match(a.limitations.join('\n'), /Verificação "test" \(obrigatória\) não foi executada/);
  const b = buildDelivery(mis(cyc('completed', [rnd(1)], { integrity: { pending: [{ path: 'tests/a.test.js', change: 'modified' }] } })), W);
  assert.equal(b.assurance.level, 'unverified'); assert.match(b.limitations.join('\n'), /tests\/a\.test\.js/);
  const planned = cyc('completed', [rnd(1, { planId: 'pl', stepId: 's1' })], { plan: { id: 'pl', steps: [{ id: 's1', title: 'a', dependsOn: [] }, { id: 's2', title: 'b', dependsOn: ['s1'] }] } });
  const c = buildDelivery(mis(planned), W);
  assert.deepEqual(c.observed.steps.map((s) => [s.id, s.status]), [['s1', 'completed'], ['s2', 'queued']]); assert.equal(c.assurance.level, 'unverified'); assert.match(c.limitations.join('\n'), /Etapa "s2".*queued/);
});

test('arquivos: são os registrados nas rodadas, com origem e limitações; nunca apresentados como a lista completa', () => {
  const f = (p, over = {}) => ({ path: p, status: 'M', added: 2, removed: 1, preexisting: false, ...over });
  const r1 = rnd(1, { report: rep({ evidence: EV('verified'), filesChanged: [f('src/a.js'), f('README.md', { preexisting: true })] }) });
  const r2 = rnd(2, { report: rep({ evidence: EV('verified'), filesChanged: [f('src/a.js'), f('src/b.js')], filesKnown: true }) });
  const r3 = rnd(3, { report: rep({ evidence: EV('verified'), filesChanged: [], filesKnown: false }) });
  const big = rnd(4, { report: rep({ evidence: EV('verified'), filesChanged: Array.from({ length: 50 }, (_, i) => f(`g/${i}.js`)) }) });
  const out = buildDelivery(mis(cyc('blocked', [r1, r2, r3, big])), W).observed.files;
  assert.deepEqual(out.items.find((x) => x.path === 'src/a.js').rounds, [1, 2]); assert.equal(out.items.find((x) => x.path === 'README.md').preexisting, true);
  assert.deepEqual(out.unknownRounds, [3]); assert.deepEqual(out.truncatedRounds, [4]); assert.match(out.source, /git status/); assert.match(out.limitation, /PARCIAL/);
  const lim = buildDelivery(mis(cyc('blocked', [r1, r2, r3, big])), W).limitations.join('\n');
  assert.match(lim, /desconhecidos nas rodadas 3/); assert.match(lim, /truncada nas rodadas 4/); assert.match(lim, /já estavam alterados antes/);
  const none = buildDelivery(mis(cyc('blocked', [])), W).limitations.join('\n'); assert.match(none, /Nenhuma execução registrou arquivos/);
});

test('dados históricos: rodadas sem parecer de evidência (antes do M8) e registros incompletos ou malformados não quebram nem inventam', () => {
  const legacy = (verification, verifications) => rnd(1, { report: rep({ verifications }), verification });
  const ok = buildDelivery(mis(cyc('completed', [legacy('passed', [REAL_PASS])], { finalSummary: 's', evidence: ['e'] })), W);
  assert.equal(ok.assurance.level, 'unverified', 'sem parecer do sistema nada é presumido como verificado'); assert.match(ok.assurance.basis, /histórico/); assert.equal(ok.verified.evidence[0].level, 'inconclusive'); assert.equal(ok.verified.evidence[0].recordedByEvidenceModule, false);
  const none = buildDelivery(mis(cyc('completed', [legacy('none', [])])), { id: 'w', name: 'w', verifications: [] }); assert.equal(none.assurance.level, 'unverified'); assert.equal(none.verified.evidence[0].level, 'absent');
  const bad = [undefined, null, {}, { cycle: 'x' }, { id: 'a', tasks: 'não', cycle: { rounds: 'não', status: 'completed' } }, { id: 'b', tasks: [null, 3], cycle: { status: 'completed', rounds: [null, 1, { n: 1, report: 'texto' }, { n: 2, report: { filesChanged: 'x', verifications: 'y', checks: [null] } }] } }];
  for (const m of bad) { const r = buildDelivery(m, null); assert.equal(r.schemaVersion, 1); assert.ok(Array.isArray(r.limitations)); assert.notEqual(r.assurance.level, 'verified', JSON.stringify(m)); }
});

test('somente leitura: a geração não altera a missão nem o ciclo (entrada congelada), e é determinística', () => {
  const m = deepFreeze(mis(cyc('blocked', [rnd(1)], { plan: { id: 'pl', steps: [{ id: 's1', title: 'a', dependsOn: [] }] } })));
  const before = dig(m);
  const a = buildDelivery(m, W, { now: () => 'T' }), b = buildDelivery(m, W, { now: () => 'T' });
  assert.equal(dig(m), before); assert.deepEqual(a, b); assert.equal(m.cycle.status, 'blocked');
});

test('contexto congelado: o relatório usa o workspace e as verificações do ENCERRAMENTO; o estado atual vem separado e rotulado', () => {
  const m = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'] }));
  m.cycle.deliveryContext = closingContext(m, W, () => 'GRAVADO');
  assert.deepEqual(Object.keys(m.cycle.deliveryContext).sort(), ['cycleId', 'finishedAt', 'recordedAt', 'status', 'v', 'verifications', 'workspace']);
  assert.ok(JSON.stringify(m.cycle.deliveryContext).length < 300, 'contexto mínimo');
  const same = deliveryOf(m, W, { now: () => 'T' }).report;
  assert.equal(same.context.kind, 'closing_context'); assert.equal(same.context.recordedAt, 'GRAVADO'); assert.equal(same.verified.configuredSource, 'frozen_at_close'); assert.equal(same.mission.workspace.source, 'frozen_at_close');
  assert.deepEqual(same.currentWorkspace, { exists: true, verificationsChanged: false, source: 'current' }); assert.equal(same.source, 'recomputed');
  // a configuração muda DEPOIS: o histórico não muda; o atual aparece à parte
  const changed = { id: 'w', name: 'Renomeado', verifications: [{ script: 'lint', required: true, command: 'x' }] };
  const later = deliveryOf(m, changed, { now: () => 'T' }).report;
  assert.deepEqual(later.verified.configured, [{ script: 'test', required: true }]); assert.equal(later.mission.workspace.name, 'WS'); assert.equal(later.verified.configuredSource, 'frozen_at_close');
  assert.deepEqual(later.verified.missing, same.verified.missing); assert.equal(later.assurance.level, same.assurance.level);
  assert.equal(later.currentWorkspace.verificationsChanged, true); assert.match(later.limitations.join('\n'), /mudou depois do encerramento/);
  // workspace removido depois: a identidade do encerramento permanece
  const gone = deliveryOf(m, null, { now: () => 'T' }).report;
  assert.equal(gone.mission.workspace.name, 'WS'); assert.deepEqual(gone.currentWorkspace, { exists: false, verificationsChanged: false, source: 'current' }); assert.match(gone.limitations.join('\n'), /removido do cadastro depois do encerramento/);
  // determinístico com os mesmos dados
  assert.deepEqual(deliveryOf(m, W, { now: () => 'T' }).report, same);
  // ciclo terminado SEM contexto (dado anterior): usa o atual e DIZ isso
  const old = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'] })), r = deliveryOf(old, W).report;
  assert.equal(r.context.kind, 'none'); assert.equal(r.verified.configuredSource, 'current'); assert.equal(r.mission.workspace.source, 'current'); assert.match(r.limitations.join('\n'), /Sem contexto gravado no encerramento/);
});

test('o contexto só vale para ESTE ciclo terminado: outro id, outro estado, outro instante de fim, ciclo retomado/não terminado ou formato inválido => ignorado', () => {
  const base = () => { const m = mis(cyc('limit_reached', [rnd(1)])); m.cycle.deliveryContext = closingContext(m, W, () => 'G'); return m; };
  assert.equal(frozenContextOf(base()).kind, 'closing_context');
  const mut = (fn) => { const m = base(); fn(m); return frozenContextOf(m); };
  assert.equal(mut((m) => { m.cycle.id = 'outro'; }), null);
  assert.equal(mut((m) => { m.cycle.status = 'cancelled'; }), null);
  assert.equal(mut((m) => { m.cycle.finishedAt = 'C'; }), null);
  assert.equal(mut((m) => { m.cycle.status = 'running'; m.cycle.finishedAt = null; }), null, 'retomado');
  assert.equal(mut((m) => { m.cycle.status = 'blocked'; }), null);
  assert.equal(mut((m) => { m.cycle.deliveryContext.verifications = 'x'; }), null);
  assert.equal(mut((m) => { m.cycle.deliveryContext = 42; }), null);
  const blocked = deliveryOf(mis(cyc('blocked', [rnd(1)], { blockedCode: 'x', deliveryContext: { v: 1, cycleId: 'cy1', status: 'blocked', finishedAt: null, workspace: null, verifications: [] } })), W).report;
  assert.equal(blocked.context.kind, 'none'); assert.equal(blocked.verified.configuredSource, 'current'); assert.ok(!/Sem contexto gravado/.test(blocked.limitations.join(' ')), 'ciclo não terminado: o atual É o vigente');
});

test('dados históricos com cycle.delivery (relatório inteiro, formato anterior): lido sem erro e sem alteração; o que ele congelou vira contexto; registro de outro ciclo é ignorado', () => {
  const m = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'] }));
  const legacy = { schemaVersion: 1, generatedAt: 'ANTIGO', source: 'recorded', mission: { workspace: { id: 'w', name: 'WS antigo' } }, cycle: { id: 'cy1', status: 'completed', finishedAt: 'B' }, verified: { configured: [{ script: 'test', required: true }] } };
  m.cycle.delivery = legacy; deepFreeze(m);
  const r = deliveryOf(m, null).report;
  assert.equal(r.context.kind, 'legacy_snapshot'); assert.equal(r.context.recordedAt, 'ANTIGO'); assert.equal(r.mission.workspace.name, 'WS antigo'); assert.equal(r.source, 'recomputed'); assert.equal(r.assurance.level, 'verified');
  const other = mis(cyc('completed', [rnd(1)]), { id: 'my' }); other.cycle.delivery = { ...legacy, cycle: { id: 'cy-antigo', status: 'completed', finishedAt: 'B' } };
  assert.equal(deliveryOf(other, W).report.context.kind, 'none');
  const broken = mis(cyc('completed', [rnd(1)])); broken.cycle.delivery = 'lixo'; assert.equal(deliveryOf(broken, W).report.context.kind, 'none');
  const noList = mis(cyc('completed', [rnd(1)])); noList.cycle.delivery = { cycle: { id: 'cy1', status: 'completed', finishedAt: 'B' }, verified: {} }; assert.equal(deliveryOf(noList, W).report.context.kind, 'none');
});

test('contexto sem workspace e workspace atual também ausente: o relatório NÃO afirma que o workspace foi removido; só com workspace no contexto e ausente agora', () => {
  const m = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'] }));
  m.cycle.deliveryContext = closingContext(m, null, () => 'G'); assert.equal(m.cycle.deliveryContext.workspace, null);
  const r = deliveryOf(m, null).report;
  assert.equal(r.context.kind, 'closing_context'); assert.equal(r.mission.workspace, null); assert.deepEqual(r.currentWorkspace, { exists: false, verificationsChanged: false, source: 'current' });
  assert.ok(!/removido/.test(r.limitations.join(' ')), r.limitations.join(' | '));
  m.cycle.deliveryContext = closingContext(m, W, () => 'G'); // havia workspace no encerramento e hoje não há: aí sim
  assert.match(deliveryOf(m, null).report.limitations.join(' '), /removido do cadastro/);
  const legacy = mis(cyc('completed', [rnd(1)])); legacy.cycle.delivery = { cycle: { id: 'cy1', status: 'completed', finishedAt: 'B' }, mission: { workspace: null }, verified: { configured: [] }, generatedAt: 'A' };
  const l = deliveryOf(legacy, null).report; assert.equal(l.context.kind, 'legacy_snapshot'); assert.ok(!/removido/.test(l.limitations.join(' ')));
});

test('falha ao montar o relatório nunca lança: deliveryOf devolve o erro', () => {
  const boom = { id: 'x', get title() { throw new Error('dado ilegível'); }, cycle: cyc('blocked', []) };
  const r = deliveryOf(boom, W); assert.equal(r.ok, false); assert.match(r.error, /Não foi possível montar o relatório/);
});

// ---------- integração com o ciclo real (CLI falsa) ----------
test('ciclo concluído com arquivos esperados conferidos: registro gravado ao terminar, garantia verified e arquivos DESCONHECIDOS (workspace sem Git)', async () => {
  const { m, c } = await run([plan([step('a'), step('b', ['a'])]), done()]);
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.delivery, undefined, 'o relatório inteiro NÃO é gravado'); assert.equal(c.deliveryContext.status, 'completed'); assert.equal(c.deliveryContext.cycleId, c.id); assert.equal(c.deliveryContext.finishedAt, c.finishedAt);
  const r = deliveryOf(m, db.workspaces.find((w) => w.id === 'ws0')).report;
  assert.equal(r.source, 'recomputed'); assert.equal(r.context.kind, 'closing_context'); assert.equal(r.state.delivered, true);
  assert.equal(r.assurance.level, 'verified'); assert.match(r.assurance.basis, /expected_files/);
  assert.deepEqual(r.observed.steps.map((s) => s.status), ['completed', 'completed']);
  assert.deepEqual(r.verified.evidence.map((e) => e.expectedFiles.map((x) => x.ok)), [[true], [true]]);
  assert.deepEqual(r.observed.files.unknownRounds, [1, 2]); assert.match(r.limitations.join('\n'), /sem Git/);
  assert.equal(r.declared.plannerSummary.text, 'Tudo certo, segundo o Planner.'); assert.deepEqual(r.declared.plannerSummary.evidence, ['o Planner afirma que x.txt existe']);
  assert.match(r.limitations.join('\n'), /não tem verificações reais configuradas/);
  const onDisk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);
  assert.equal(onDisk.cycle.delivery, undefined); assert.equal(onDisk.cycle.deliveryContext.status, 'completed'); assert.equal(onDisk.cycle.status, 'completed');
  const raw = JSON.stringify(onDisk.cycle); assert.ok(!raw.includes('legend') && !raw.includes('"declared"') && !raw.includes('Declarações de agentes'), 'sem cópia do relatório no banco'); assert.ok(JSON.stringify(onDisk.cycle.deliveryContext).length < 300);
});

test('sem verificação real nem arquivos esperados (fluxo avulso): "complete" é rejeitado, o ciclo NÃO conclui e o relatório mostra a evidência inconclusiva e a missão não entregue', async () => {
  const { m, c } = await run([contBare('criar x'), done(), blockedAns()], { multiStep: false });
  assert.notEqual(c.status, 'completed'); assert.equal(c.blockedCode, 'planner_blocked'); assert.match(c.rejections[0].problem, /evidência do sistema para a última rodada é "inconclusive"/);
  const r = deliveryOf(m, db.workspaces.find((w) => w.id === 'ws0')).report;
  assert.equal(r.state.code, 'blocked'); assert.equal(r.state.delivered, false); assert.equal(r.assurance.level, 'not_applicable'); assert.equal(r.verified.evidence[0].level, 'inconclusive');
});

test('coerência: todo ciclo concluído com evidência verified tem assurance "verified" no ciclo E no relatório de entrega', async () => {
  const { m, c } = await run([cont('criar x'), done()], { multiStep: false });
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified');
  const r = deliveryOf(m, db.workspaces.find((w) => w.id === 'ws0')).report;
  assert.equal(r.assurance.level, 'verified'); assert.equal(r.declared.cycleAssuranceLabel, 'verified'); assert.equal(r.verified.evidence[0].level, 'verified');
});

test('ciclo com verificação real obrigatória aprovada: verifications registradas e garantia verified; verificação reprovada deixa a missão NÃO entregue', async () => {
  const ok = await run([plan([step('a')]), done()], { ws: 'ws' });
  assert.equal(ok.c.status, 'completed', ok.c.blockedReason);
  const r = deliveryOf(ok.m, db.workspaces.find((w) => w.id === 'ws')).report;
  assert.equal(r.assurance.level, 'verified'); assert.equal(r.verified.verifications[0].status, 'pass'); assert.equal(r.verified.verifications[0].script, 'test'); assert.deepEqual(r.verified.missing, []);
  resetWs(); verStatus = 'fail';
  const m = mkMission('ws'), cy = mk(scripted([plan([step('a')]), blockedAns()]));
  assert.equal((await cy.start(m.id, 5)).status, 202); await cy.idle();
  const f = deliveryOf(m, db.workspaces.find((w) => w.id === 'ws')).report;
  assert.equal(f.state.code, 'blocked'); assert.equal(f.state.delivered, false); assert.equal(f.context.kind, 'none'); assert.equal(m.cycle.deliveryContext, undefined);
  assert.equal(f.verified.verifications[0].status, 'fail'); assert.equal(f.verified.evidence[0].level, 'failed'); assert.equal(f.assurance.level, 'not_applicable');
  assert.match(f.state.reasons.join(' '), /planner_blocked/); assert.equal(f.declared.plannerSummary, null);
});

test('ciclo cancelado: registro gravado como "cancelled", nunca como entrega', async () => {
  resetWs(); verStatus = 'pass';
  const m = mkMission('ws0'); let cy;
  cy = mk(scripted([plan([step('a')])], () => { m.cycle.cancelRequested = true; }));
  assert.equal((await cy.start(m.id, 5)).status, 202); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); const r = deliveryOf(m, db.workspaces[1]).report;
  assert.equal(r.state.code, 'cancelled'); assert.equal(r.state.delivered, false); assert.equal(r.assurance.level, 'not_applicable'); assert.equal(r.context.kind, 'closing_context'); assert.equal(m.cycle.deliveryContext.status, 'cancelled');
});

test('falha ao gravar a conclusão: o ciclo NÃO fica concluído, o registro de entrega é desfeito e a consulta mostra o bloqueio', async () => {
  const { m, c } = await quiet(() => run([plan([step('a')]), done()], { hook: (left) => { if (left === 1) fs.mkdirSync(BLOCK_TMP, { recursive: true }); } })).finally(() => fs.rmSync(BLOCK_TMP, { recursive: true, force: true }));
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(c.delivery, undefined); assert.equal(c.deliveryContext, undefined, 'nada de contexto de encerramento sem a conclusão gravada');
  const r = deliveryOf(m, db.workspaces[1]).report; assert.equal(r.state.delivered, false); assert.equal(r.state.code, 'blocked'); assert.equal(r.declared.plannerSummary, null);
});

test('falha ao gravar a conclusão COM valores anteriores: o rollback de end() restaura status, finishedAt, deliveryContext e delivery exatamente como estavam', async () => {
  const priorCtx = { v: 1, cycleId: 'anterior', status: 'limit_reached', finishedAt: 'T-ANTES', workspace: null, verifications: [] }, priorOld = { schemaVersion: 1, source: 'recorded', marca: 'formato-anterior' };
  let before = null;
  const { c } = await quiet(() => run([plan([step('a')]), done()], { hook: (left) => {
    if (left !== 1) return;
    const cy = db.missions.at(-1).cycle; cy.deliveryContext = priorCtx; cy.delivery = priorOld; cy.finishedAt = 'T-ANTES'; // estado anterior ao fim, como num ciclo retomado
    before = { status: cy.status, finishedAt: cy.finishedAt }; fs.mkdirSync(BLOCK_TMP, { recursive: true });
  } })).finally(() => fs.rmSync(BLOCK_TMP, { recursive: true, force: true }));
  assert.ok(before, 'a falha de gravação foi armada antes da decisão "complete"');
  assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(c.status, 'blocked'); // nunca 'completed': o rollback desfez a conclusão e o ciclo bloqueou por persistência
  assert.equal(c.finishedAt, before.finishedAt, 'finishedAt voltou ao valor anterior (não ficou o instante do fim abortado)');
  assert.strictEqual(c.deliveryContext, priorCtx, 'o contexto anterior foi restaurado (não removido nem substituído)'); assert.deepEqual(c.deliveryContext, { v: 1, cycleId: 'anterior', status: 'limit_reached', finishedAt: 'T-ANTES', workspace: null, verifications: [] });
  assert.strictEqual(c.delivery, priorOld, 'o relatório no formato anterior foi restaurado (recordDeliveryContext o havia apagado)'); assert.equal(c.delivery.marca, 'formato-anterior');
});

test('falha ao montar o CONTEXTO ao concluir: o ciclo conclui do mesmo jeito (sem transição indevida), sem contexto, e a consulta diz que usa a configuração atual', async () => {
  resetWs(); verStatus = 'pass';
  let armed = false; const wsx = { id: 'wsx', path: wsDir, verifications: [] };
  Object.defineProperty(wsx, 'name', { configurable: true, enumerable: false, get() { if (armed) throw new Error('nome ilegível'); return 'WSX'; } }); // não enumerável: o JSON do banco não o lê, só o contexto
  db.workspaces.push(wsx);
  const m = mkMission('wsx'), cy = mk(scripted([plan([step('a')]), done()], (left) => { if (left === 1) armed = true; }));
  await quiet(async () => { assert.equal((await cy.start(m.id, 5)).status, 202); await cy.idle(); });
  assert.equal(m.cycle.status, 'completed', m.cycle.blockedReason); assert.equal(m.cycle.deliveryContext, undefined);
  assert.ok(db.activity.some((a) => /Contexto histórico do relatório de entrega não registrado/.test(a.message)));
  assert.equal(deliveryOf(m, wsx).ok, false); // ainda ilegível: o erro é devolvido, nunca lançado
  armed = false; const r = deliveryOf(m, wsx).report; assert.equal(r.context.kind, 'none'); assert.match(r.limitations.join('\n'), /Sem contexto gravado/);
});

test('retomada de ciclo limitado e novo ciclo: o contexto antigo nunca é reaproveitado; cada fim grava o seu', async () => {
  resetWs(); verStatus = 'pass';
  const answers = [cont('a', 'a.txt'), cont('b', 'b.txt'), cont('c', 'c.txt'), done(), blockedAns()];
  const m = mkMission('ws0'), cy = mk(scripted(answers), false);
  assert.equal((await cy.start(m.id, 1)).status, 202); await cy.idle();
  assert.equal(m.cycle.status, 'limit_reached'); const first = { ...m.cycle.deliveryContext }; assert.equal(first.status, 'limit_reached');
  const lim = deliveryOf(m, db.workspaces[1]).report; assert.equal(lim.context.kind, 'closing_context'); assert.equal(lim.state.code, 'limit_reached'); assert.equal(lim.state.delivered, false);
  await sleep(5);
  const res = await cy.resume(m.id, { maxIterations: 4 }); assert.equal(res.status, 202);
  assert.equal(frozenContextOf(m), null, 'retomado: o contexto do limite não vale mais'); assert.equal(deliveryOf(m, db.workspaces[1]).report.context.kind, 'none');
  await cy.idle();
  assert.equal(m.cycle.status, 'completed', m.cycle.blockedReason); assert.notEqual(m.cycle.deliveryContext.finishedAt, first.finishedAt); assert.equal(m.cycle.deliveryContext.status, 'completed');
  const done1 = deliveryOf(m, db.workspaces[1]).report; assert.equal(done1.state.code, 'completed'); assert.equal(done1.context.kind, 'closing_context');
  const oldId = m.cycle.id, oldCtx = { ...m.cycle.deliveryContext };
  assert.equal((await cy.start(m.id, 3)).status, 202); await cy.idle(); // novo ciclo: o anterior vai para pastCycles com o contexto DELE
  assert.notEqual(m.cycle.id, oldId); assert.equal(m.pastCycles[0].id, oldId); assert.deepEqual(m.pastCycles[0].deliveryContext, oldCtx);
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.deliveryContext, undefined); const nw = deliveryOf(m, db.workspaces[1]).report; assert.equal(nw.context.kind, 'none'); assert.equal(nw.state.delivered, false);
});

test('ciclo antigo com cycle.delivery (relatório inteiro) que termina de novo: o registro anterior é descartado só deste ciclo e o contexto novo vale', async () => {
  resetWs(); verStatus = 'pass';
  const m = mkMission('ws0'), cy = mk(scripted([cont('a', 'a.txt'), cont('b', 'b.txt'), done()]), false);
  assert.equal((await cy.start(m.id, 1)).status, 202); await cy.idle(); assert.equal(m.cycle.status, 'limit_reached');
  const ctx = m.cycle.deliveryContext;
  m.cycle.delivery = { schemaVersion: 1, source: 'recorded', cycle: { id: m.cycle.id, status: 'limit_reached', finishedAt: m.cycle.finishedAt }, mission: { workspace: null }, verified: { configured: [] } };
  assert.equal(deliveryOf(m, null).report.context.kind, 'closing_context', 'o contexto novo tem precedência sobre o formato anterior');
  delete m.cycle.deliveryContext; assert.equal(deliveryOf(m, null).report.context.kind, 'legacy_snapshot'); m.cycle.deliveryContext = ctx;
  await sleep(5); await cy.resume(m.id, { maxIterations: 3 }); await cy.idle();
  assert.equal(m.cycle.delivery, undefined); assert.equal(m.cycle.deliveryContext.status, m.cycle.status);
});

// ---------- rota HTTP: servidor REAL (index.js) com banco temporário semeado ----------
test('GET /api/missions/:id/delivery: 200 com o contrato, 404 para missão inexistente, dados históricos, e a consulta não altera nada', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'srv-')), port = 44100 + Math.floor(Math.random() * 800);
  const completed = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'], assurance: 'verified' }), { id: 'mis_ok', workspaceId: 'wsr' });
  completed.cycle.delivery = { ...buildDelivery(completed, { id: 'wsr', name: 'R antigo', verifications: [] }), source: 'recorded' }; // formato ANTERIOR (relatório inteiro gravado)
  const framed = mis(cyc('completed', [rnd(1)], { finalSummary: 'ok', evidence: ['e'] }), { id: 'mis_ctx', workspaceId: 'wsr' });
  framed.cycle.deliveryContext = closingContext(framed, { id: 'wsr', name: 'R no encerramento', verifications: [{ script: 'test', required: true }] }, () => 'GRAVADO'); // o workspace atual (abaixo) tem OUTRA configuração
  const orphan = mis(cyc('cancelled', [rnd(1)]), { id: 'mis_gone', workspaceId: 'wsr_removido' });
  orphan.cycle.deliveryContext = closingContext(orphan, { id: 'wsr_removido', name: 'Removido', verifications: [] });
  const resumed = mis(cyc('running', [rnd(1)]), { id: 'mis_resumed', workspaceId: 'wsr' });
  resumed.cycle.deliveryContext = { v: 1, cycleId: 'cy1', status: 'limit_reached', finishedAt: 'B', recordedAt: 'X', workspace: null, verifications: [] }; // contexto de um fim ANTERIOR, depois da retomada
  const seed = {
    version: 1, settings: { activeWorkspaceId: 'wsr', requireApproval: true, showDemoData: true }, workspaces: [{ id: 'wsr', name: 'R', path: wsDir }], activity: [],
    missions: [completed, framed, orphan, resumed,
      mis(cyc('completed', [rnd(1, { report: rep({ verifications: [REAL_PASS] }) })], { finalSummary: 'antigo' }), { id: 'mis_hist', workspaceId: 'wsr' }), // sem parecer de evidência nem registro de entrega (dados históricos)
      mis(cyc('blocked', [rnd(1)], { blockedCode: 'planner_blocked', blockedReason: 'precisa de decisão' }), { id: 'mis_blk', workspaceId: 'wsr' }),
      mis(undefined, { id: 'mis_man', workspaceId: 'wsr', tasks: [{ id: 't1', title: 'manual', status: 'queued', dependsOn: [], report: '', files: [], log: [] }] }),
      { id: 'demo_mission', demo: true, title: 'Demo', objective: '', workspaceId: null, tasks: [] },
      { id: 'mis_bad', demo: false, title: 'B', workspaceId: null, tasks: [], cycle: { status: 'completed', rounds: [] } }],
  };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(here, '..', 'index.js')], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/state`)).ok; } catch { await sleep(150); } }
    assert.ok(up, 'servidor subiu');
    const get = async (id) => { const r = await fetch(`${base}/api/missions/${id}/delivery`); return { status: r.status, body: await r.json() }; };
    const states = async () => Object.fromEntries((await (await fetch(`${base}/api/missions`)).json()).map((x) => [x.id, x.status]));
    const before = await states(), disk = dig(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).missions);
    const ok = await get('mis_ok'); assert.equal(ok.status, 200); assert.equal(ok.body.source, 'recomputed'); assert.equal(ok.body.context.kind, 'legacy_snapshot'); assert.equal(ok.body.state.delivered, true); assert.equal(ok.body.mission.workspace.name, 'R antigo');
    const ctx = await get('mis_ctx'); assert.equal(ctx.body.context.kind, 'closing_context'); assert.equal(ctx.body.mission.workspace.name, 'R no encerramento'); assert.equal(ctx.body.verified.configuredSource, 'frozen_at_close');
    assert.deepEqual(ctx.body.verified.configured, [{ script: 'test', required: true }]); assert.deepEqual(ctx.body.currentWorkspace, { exists: true, verificationsChanged: true, source: 'current' });
    const gone = await get('mis_gone'); assert.equal(gone.body.state.code, 'cancelled'); assert.equal(gone.body.mission.workspace.name, 'Removido'); assert.equal(gone.body.currentWorkspace.exists, false);
    const res = await get('mis_resumed'); assert.equal(res.body.state.code, 'blocked'); /* o boot fecha ciclos ativos como bloqueados (restarted) */ assert.equal(res.body.context.kind, 'none'); assert.equal(res.body.state.delivered, false);
    const hist = await get('mis_hist'); assert.equal(hist.status, 200); assert.equal(hist.body.source, 'recomputed'); assert.equal(hist.body.assurance.level, 'unverified'); assert.match(hist.body.assurance.basis, /histórico/);
    const blk = await get('mis_blk'); assert.equal(blk.body.state.code, 'blocked'); assert.equal(blk.body.state.delivered, false); assert.match(blk.body.state.reasons.join(' '), /planner_blocked/);
    const man = await get('mis_man'); assert.equal(man.status, 200); assert.equal(man.body.state.code, 'no_cycle'); assert.equal(man.body.assurance.level, 'not_applicable');
    const bad = await get('mis_bad'); assert.equal(bad.status, 200); assert.equal(bad.body.assurance.level, 'unverified'); assert.match(bad.body.limitations.join(' '), /sem nenhuma rodada/);
    const demo = await get('demo_mission'); assert.equal(demo.status, 200); assert.equal(demo.body.state.code, 'demo');
    const miss = await get('nao_existe'); assert.equal(miss.status, 404); assert.deepEqual(miss.body, { error: 'Missão não encontrada.' });
    assert.equal((await fetch(`${base}/api/missions/mis_ok/delivery`, { method: 'POST' })).status, 404); // só leitura: não existe POST
    assert.deepEqual(await states(), before, 'a consulta não muda nenhum estado');
    assert.equal(dig(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).missions), disk, 'a consulta não grava nada');
  } finally { child.kill(); await sleep(500); }
});
