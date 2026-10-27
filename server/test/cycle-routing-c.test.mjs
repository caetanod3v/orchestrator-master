// Incremento C: escalonamento do Planner por SINAIS OBSERVÁVEIS (sem progresso e limite de rodadas), no ciclo completo e na função pura.
// Banco TEMPORÁRIO, CLI FALSA (Executor e, no teste de rota, o próprio Planner real contra um processo que devolve o argv), verificador SIMULADO. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routing-c-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-cli.mjs'), FAKE_ARGV = path.join(HERE, 'fake-argv-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createRouter, escalationSignal, ESCALATION } = await import('../routing.js');
const { createClaudePlanner } = await import('../planner.js');
const { summarizeUsage } = await import('../usage.js');

let db, executor, startTaskRun, progExec, startProg, seq = 0, pn = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
  // Executor que, além da CLI falsa, cria um arquivo NOVO a cada execução: toda rodada tem progresso (arquivo alterado que não existia antes).
  progExec = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { const h = t.start(o); fs.writeFileSync(path.join(o.cwd, `p${++pn}.txt`), 'x'); return h; } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun: startProg } = setupExecution(express(), { db, executor: progExec }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const SIMPLE = 'No arquivo config.json, alterar o valor de timeoutMs de 1000 para 5000, sem modificar nenhuma outra chave. Critério de aceitação: a verificação obrigatória npm test passa.';
const cont = (title, mode = 'check') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const APPLIED = { lite: { tier: 'lite', model: 'claude-haiku-5-5', effort: 'low' }, standard: { tier: 'standard', model: null, effort: null } };
const scripted = (answers) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {}, describeTier: (t) => APPLIED[t] ?? null,
    decide: async (a) => { calls.push({ tier: a.tier, keys: Object.keys(a).sort() }); const x = answers.shift(); const route = APPLIED[a.tier];
      return x === undefined ? { error: 'roteiro acabou', ...(route ? { route } : {}) } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) }, ...(route ? { route } : {}) }; } };
};
const verifier = (status = 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'Terminou com código 1.' }) });
const mkMission = (objective) => { const m = { id: `c${++seq}`, demo: false, title: `Missão C${seq}`, objective, workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const notes = (m, re) => db.activity.filter((a) => a.type === 'cycle' && a.missionId === m.id && re.test(a.message));
async function run(answers, { router = createRouter(), planner = scripted(answers), ver = verifier(), max = 5, progress = false } = {}) {
  for (const x of fs.readdirSync(wsDir)) if (x === 'out.txt' || /^pd+.txt$/.test(x)) fs.rmSync(path.join(wsDir, x), { force: true }); // cada ciclo parte do mesmo estado do workspace (a CLI falsa cria out.txt: a 1ª rodada tem progresso, as seguintes não)
  const m = mkMission(SIMPLE), cy = createCycle({ db, executor: progress ? progExec : executor, planner, startTaskRun: progress ? startProg : startTaskRun, verifier: ver, listFiles: () => ['config.json'], router });
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner };
}
const resume = async (r) => { assert.equal((await r.cy.resume(r.m.id)).status, 202); await r.cy.idle(); };
const tiers = (planner) => planner.calls.map((x) => x.tier);
const routes = (c) => c.plannerUsage.map((e) => e.route);

test('sem progresso: 2 rodadas bem-sucedidas sem progresso bloqueiam o ciclo e, ao retomar, a consulta seguinte escalona UMA vez e fica em standard', async () => {
  const answers = [cont('A'), cont('B'), cont('C')];
  const r = await run(answers);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'no_progress'); assert.equal(r.c.rounds.length, 3);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite'], 'antes do bloqueio nada escalona (1 rodada sem progresso não é "consecutivas")');
  assert.equal(r.c.routing.escalated, false);
  answers.push(cont('D'), done());
  await resume(r);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified');
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite', 'standard', 'standard'], 'escalona na 1ª consulta após a retomada; sem 2º escalonamento (nem pelo limite de rodadas)');
  assert.deepEqual({ ...r.c.routing, initial: undefined }, { tier: 'standard', escalated: true, escalatedAtCall: 4, trigger: 'sem_progresso', initial: undefined });
  const rs = routes(r.c); assert.equal(rs.length, 5);
  assert.deepEqual([rs[3].tier, rs[3].model, rs[3].effort], ['standard', null, null]); assert.match(rs[3].reason, /^escalonado de lite para standard: .*sem progresso/); assert.equal(rs[3].signals.trigger, 'sem_progresso');
  assert.match(rs[4].reason, /^mantido standard: já escalonado/);
  const ns = notes(r.m, /escalonado de lite para standard/); assert.equal(ns.length, 1); assert.match(ns[0].message, /sem progresso/); assert.doesNotMatch(ns[0].message, /rejeitada/);
  assert.equal(r.c.rejections.length, 0, 'nenhuma rejeição: o escalonamento veio do sinal, não de uma resposta inválida');
  assert.deepEqual(JSON.parse(JSON.stringify(r.c.routing)), r.c.routing, 'o estado sobrevive à serialização');
});

test('limite de rodadas: perto do limite sem concluir, a consulta seguinte escalona; antes disso (fluxo normal) continua em lite', async () => {
  const r = await run([cont('A'), cont('B'), done()], { max: 3 });
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified');
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard']);
  assert.equal(r.c.routing.trigger, 'limite_rodadas'); assert.equal(r.c.routing.escalatedAtCall, 3); assert.match(routes(r.c)[2].reason, /2 rodadas sem concluir, a última sem progresso, e o limite é 3/);
  const calm = await run([cont('A'), done()], { max: 3 });
  assert.deepEqual(tiers(calm.planner), ['lite', 'lite'], 'uma tarefa que termina em 1 rodada nunca escalona por limite');
  assert.equal(calm.c.routing.escalated, false);
});

test('ciclo LONGO com progresso consistente: atingir o limite de rodadas NÃO escalona (sem dificuldade observada)', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), done()], { max: 4, progress: true });
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.rounds.length, 3); assert.equal(r.c.consecutiveNoProgress, 0);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite', 'lite'], 'na 4ª consulta já faltava só 1 rodada para o limite e mesmo assim continua em lite');
  assert.equal(r.c.routing.escalated, false); assert.equal(notes(r.m, /escalonado/).length, 0);
});

test('limite de rodadas + dificuldade: uma rodada sem progresso perto do limite escalona; o escalonamento persiste na retomada e não se repete', async () => {
  const answers = [cont('A'), cont('B'), blocked()];
  const r = await run(answers, { max: 3 });
  assert.equal(r.c.blockedCode, 'planner_blocked'); assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard']);
  assert.deepEqual({ ...r.c.routing, initial: undefined }, { tier: 'standard', escalated: true, escalatedAtCall: 3, trigger: 'limite_rodadas', initial: undefined });
  answers.push(done()); await resume(r);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified');
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard', 'standard']); assert.equal(r.c.routing.escalatedAtCall, 3);
  assert.equal(notes(r.m, /escalonado de lite para standard/).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.c.routing)), r.c.routing);
});

test('falha ISOLADA do Executor não escalona: o Planner é reconsultado na mesma camada', async () => {
  const r = await run([cont('F', 'fail'), cont('G'), done()]);
  assert.equal(r.c.rounds[0].status, 'failed'); assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite']); assert.equal(r.c.routing.escalated, false); assert.equal(notes(r.m, /escalonado/).length, 0);
});

test('falhas REPETIDAS do Executor (executor_failures) NÃO são sinal: bloqueiam como sempre e a retomada continua em lite', async () => {
  const answers = [cont('F1', 'fail'), cont('F2', 'fail')];
  const r = await run(answers);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'executor_failures');
  answers.push(cont('G'), done()); await resume(r);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite', 'lite']); assert.equal(r.c.routing.escalated, false); assert.equal(notes(r.m, /escalonado/).length, 0);
});

test('bloqueio CORRETO pedido pelo Planner (planner_blocked) não escalona, nem na retomada', async () => {
  const answers = [blocked()];
  const r = await run(answers);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_blocked'); assert.equal(r.c.rejections.length, 0);
  answers.push(cont('A'), done()); await resume(r);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'lite']); assert.equal(r.c.routing.escalated, false);
});

test('repetição de tarefa: continua rejeitada (proteção intacta) e a rejeição escalona pela regra do incremento B, sem sinal novo', async () => {
  const r = await run([cont('A'), cont('A'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.equal(r.c.rejections.length, 1); assert.match(r.c.rejections[0].problem, /idêntica a uma de rodadas recentes/); assert.equal(r.c.rounds.length, 1);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard']);
  assert.ok(!('trigger' in r.c.routing), 'escalonamento por rejeição: sem o campo trigger do incremento C');
  assert.match(notes(r.m, /escalonado de lite para standard/)[0].message, /resposta anterior rejeitada/);
});

test('o escalonamento por sinal nunca autoriza conclusão: com a verificação real reprovada, "complete" é rejeitado em standard também', async () => {
  const r = await run([cont('A'), cont('B'), done(), blocked()], { max: 3, ver: verifier('fail') });
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard', 'standard'], 'escalonou pelo limite (call 3); o "complete" rejeitado é repetido em standard');
  assert.notEqual(r.c.status, 'completed'); assert.equal(r.c.blockedCode, 'planner_blocked'); assert.ok(!r.c.assurance);
  assert.match(r.c.rejections[0].problem, /"complete" rejeitado: verificações reais que não passaram/);
  assert.equal(r.c.routing.trigger, 'limite_rodadas', 'um único escalonamento: a rejeição em standard não escalona de novo');
});

test('limites inalterados: o mesmo número de rodadas, consultas e bloqueio com e sem roteador', async () => {
  const script = () => [cont('A'), cont('B'), cont('C'), cont('D'), cont('E'), cont('F')];
  const shape = (r) => ({ s: r.c.status, code: r.c.blockedCode, calls: r.c.plannerCalls, rej: r.c.rejections.length, rounds: r.c.rounds.length });
  const off = await run(script(), { router: null, max: 3 }), on = await run(script(), { max: 3 });
  assert.deepEqual(shape(on), shape(off)); assert.ok(on.c.plannerCalls <= (3 + 1) * 3); assert.equal(on.c.rounds.length, 3);
});

test('roteamento DESLIGADO: nenhum escalonamento, nenhum estado, nenhuma camada, nenhuma rota; mesmo desfecho do ciclo que escalonaria', async () => {
  const off = await run([cont('A'), cont('B'), done()], { router: null, max: 3 }), on = await run([cont('A'), cont('B'), done()], { max: 3 });
  assert.equal(off.c.status, 'completed'); assert.ok(!('routing' in off.c)); assert.equal(notes(off.m, /escalonado|camada inicial/).length, 0);
  for (const x of off.planner.calls) assert.deepEqual(x.keys, ['cwd', 'onUsage', 'prompt']);
  for (const e of off.c.plannerUsage) assert.ok(!('route' in e));
  assert.equal(on.c.status, off.c.status); assert.equal(on.c.rounds.length, off.c.rounds.length); assert.equal(on.c.plannerCalls, off.c.plannerCalls);
});

test('totais de uso e custo não mudam por causa do escalonamento por sinal', async () => {
  const r = await run([cont('A'), cont('B'), done()], { max: 3 });
  assert.equal(r.c.routing.trigger, 'limite_rodadas');
  const clone = structuredClone(r.m); clone.cycle.plannerUsage = clone.cycle.plannerUsage.map(({ route, ...rest }) => rest); delete clone.cycle.routing;
  assert.deepEqual(summarizeUsage([r.m]), summarizeUsage([clone]));
  assert.equal(r.c.plannerUsage.length, 3, 'um registro por chamada: o escalonamento não cria chamada nem registro extra');
  assert.equal(store.validateDb({ ...structuredClone(db), missions: [JSON.parse(JSON.stringify(r.m))] }), null);
});

test('rota registrada = argumentos CLI realmente usados, também no escalonamento por SINAL (Planner real contra uma CLI que devolve o argv)', async () => {
  const real = createClaudePlanner({ model: 'claude-sonnet-5-5', effort: 'medium', routing: 'on', runnerOptions: { command: process.execPath, prefixArgs: [FAKE_ARGV] } });
  const answers = [cont('A'), cont('B'), done()], argvs = [];
  const spy = { ...real, decide: async (a) => { const r = await real.decide(a); argvs.push(JSON.parse(r.text)); return { ...r, text: answers.shift() }; } }; // texto do roteiro; rota e argv são os reais
  const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const r = await run([], { planner: spy, max: 3 });
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(argvs.length, 3); assert.equal(r.c.rejections.length, 0);
  const rs = routes(r.c); assert.deepEqual(rs.map((x) => x.tier), ['lite', 'lite', 'standard']);
  argvs.forEach((argv, i) => assert.deepEqual([rs[i].model, rs[i].effort], [flag(argv, '--model'), flag(argv, '--effort')], `chamada ${i + 1}`));
  assert.deepEqual([flag(argvs[0], '--model'), flag(argvs[2], '--model'), flag(argvs[2], '--effort')], ['claude-haiku-5-5', 'claude-sonnet-5-5', 'medium']);
});

// ---------- funções puras ----------
const rd = (...st) => st.map((s) => ({ report: { status: s } }));

test('escalationSignal: só os dois sinais aprovados; outros bloqueios, falhas do Executor e dados ausentes não contam', () => {
  const np = { blocks: [{ code: 'no_progress' }], rounds: rd('success', 'success'), maxIterations: 10 };
  assert.equal(escalationSignal(np).code, 'sem_progresso');
  assert.equal(escalationSignal({ ...np, rounds: rd('success', 'failed', 'success') }), null, 'uma das 2 últimas rodadas foi falha do Executor');
  assert.equal(escalationSignal({ ...np, rounds: rd('failed', 'success') }), null);
  assert.equal(escalationSignal({ ...np, rounds: rd('success') }), null);
  for (const code of ['executor_failures', 'planner_blocked', 'verification_blocked', 'needs_approval', 'interrupted', 'restarted', 'planner_invalid', 'planner_error', 'planner_calls_limit', 'cannot_start', 'internal_error']) {
    assert.equal(escalationSignal({ ...np, blocks: [{ code }] }), null, code);
  }
  assert.equal(escalationSignal({ ...np, blocks: [{ code: 'no_progress' }, { code: 'planner_blocked' }] }), null, 'vale o ÚLTIMO bloqueio');
  for (const c of [undefined, null, {}, { rounds: 'x', blocks: 'y' }, { rounds: [], maxIterations: 1 }, { rounds: rd('success'), maxIterations: 1 }]) assert.equal(escalationSignal(c), null, JSON.stringify(c));
});

test('escalationSignal: limite de rodadas nas bordas (incluídas)', () => {
  const at = (n, max) => escalationSignal({ rounds: rd(...Array(n).fill('success')), maxIterations: max, consecutiveNoProgress: 1 });
  assert.equal(escalationSignal({ rounds: rd('success', 'success'), maxIterations: 3, consecutiveNoProgress: 0 }), null, 'com progresso na última rodada: sem sinal');
  assert.equal(escalationSignal({ rounds: rd('success', 'failed'), maxIterations: 3, consecutiveNoProgress: 1 }), null, 'última rodada = falha do Executor: sem sinal');
  assert.equal(escalationSignal({ rounds: rd('success', 'success'), maxIterations: 3 }), null, 'sem o contador: sem sinal');
  assert.deepEqual([ESCALATION.minRounds, ESCALATION.roundsLeft], [2, 1]);
  assert.equal(at(1, 2), null, 'precisa de >= 2 rodadas'); assert.equal(at(0, 1), null);
  assert.equal(at(2, 2)?.code, 'limite_rodadas'); assert.equal(at(2, 3)?.code, 'limite_rodadas'); assert.equal(at(2, 4), null);
  assert.equal(at(3, 5), null); assert.equal(at(4, 5)?.code, 'limite_rodadas'); assert.equal(at(9, 10)?.code, 'limite_rodadas'); assert.equal(at(8, 10), null);
});

test('router.pick: sinal só escalona lite não escalonado; standard, escalonado e rejeição pendente seguem as regras anteriores; nunca desce', () => {
  const r = createRouter(), np = { blocks: [{ code: 'no_progress' }], rounds: rd('success', 'success'), maxIterations: 10 };
  const lite = { tier: 'lite', escalated: false, initial: { tier: 'lite', reason: 'x', signals: {} } };
  const e = r.pick({ cycle: { ...np, routing: lite }, call: 4 });
  assert.equal(e.tier, 'standard'); assert.deepEqual({ ...e.state, initial: undefined }, { tier: 'standard', escalated: true, escalatedAtCall: 4, trigger: 'sem_progresso', initial: undefined }); assert.equal(e.signals.from, 'lite');
  const std = { ...lite, tier: 'standard', initial: { tier: 'standard' } };
  assert.equal(r.pick({ cycle: { ...np, routing: std }, call: 4 }).state, std, 'já em standard: nada muda (mesmo objeto)');
  const esc = { ...lite, tier: 'standard', escalated: true, escalatedAtCall: 2 };
  const k = r.pick({ cycle: { ...np, routing: esc }, call: 9 }); assert.equal(k.tier, 'standard'); assert.equal(k.state.escalatedAtCall, 2); assert.ok(!('trigger' in k.state));
  const rej = r.pick({ cycle: { ...np, routing: lite }, retryAfterRejection: true, rejection: 'x', call: 5 });
  assert.equal(rej.signals.trigger, 'rejeição'); assert.ok(!('trigger' in rej.state), 'com rejeição pendente vale a regra do incremento B');
  const none = r.pick({ cycle: { rounds: [], blocks: [], maxIterations: 5, routing: lite }, call: 2 });
  assert.equal(none.tier, 'lite'); assert.equal(none.state, lite);
});
