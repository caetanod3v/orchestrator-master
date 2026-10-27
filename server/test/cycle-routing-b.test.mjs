// Incremento B no ciclo completo: seleção inicial, escalonamento por rejeição, limites e proteções, e rota EFETIVA registrada.
// Banco TEMPORÁRIO, CLI FALSA (Executor e, no teste de rota, o próprio Planner real contra um processo que devolve o argv), verificador SIMULADO. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routing-b-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-cli.mjs'), FAKE_ARGV = path.join(HERE, 'fake-argv-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, bus } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createRouter } = await import('../routing.js');
const { createClaudePlanner, PLANNER_ARGS } = await import('../planner.js');
const { summarizeUsage } = await import('../usage.js');

let db, executor, startTaskRun, seq = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const SIMPLE = 'No arquivo config.json, alterar o valor de timeoutMs de 1000 para 5000, sem modificar nenhuma outra chave. Critério de aceitação: a verificação obrigatória npm test passa.';
const COMPLEX = 'Refatorar todos os módulos do projeto conforme a especificação. Critério de aceitação: npm test passa.';
const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const APPLIED = { lite: { tier: 'lite', model: 'claude-haiku-5-5', effort: 'low' }, standard: { tier: 'standard', model: null, effort: null } };
/** Planner simulado que, como o real, informa a rota APLICADA a cada chamada. */
const scripted = (answers) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {}, describeTier: (t) => APPLIED[t] ?? null,
    decide: async (a) => { calls.push({ tier: a.tier, keys: Object.keys(a).sort(), prompt: a.prompt }); const x = answers.shift(); const route = APPLIED[a.tier];
      return x === undefined ? { error: 'roteiro acabou', ...(route ? { route } : {}) } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) }, ...(route ? { route } : {}) }; } };
};
const verifier = (status = 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'Terminou com código 1.' }) });
const mkMission = (objective) => { const m = { id: `b${++seq}`, demo: false, title: `Missão B${seq}`, objective, workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const notes = (m, re) => db.activity.filter((a) => a.type === 'cycle' && a.missionId === m.id && re.test(a.message));
async function run(objective, answers, { router = createRouter(), planner = scripted(answers), ver = verifier(), max = 3 } = {}) {
  const m = mkMission(objective), cy = createCycle({ db, executor, planner, startTaskRun, verifier: ver, listFiles: () => ['config.json'], router });
  const events = []; const on = (e) => events.push(e); bus.on('usage', on);
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle(); bus.off('usage', on);
  return { m, c: m.cycle, cy, planner, events: events.filter((e) => e.agent === 'planner' && e.missionId === m.id) };
}
const tiers = (planner) => planner.calls.map((x) => x.tier);
const routes = (c) => c.plannerUsage.map((e) => e.route);

test('tarefa simples (lite): todas as chamadas vão para lite, a conclusão exige a verificação real e a rota registra Haiku/low', async () => {
  const r = await run(SIMPLE, [cont('Criar'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified'); assert.equal(r.c.rounds[0].verification, 'passed');
  assert.deepEqual(tiers(r.planner), ['lite', 'lite']);
  const [a, b] = routes(r.c);
  assert.deepEqual([a.tier, a.model, a.effort], ['lite', 'claude-haiku-5-5', 'low']); assert.match(a.reason, /^lite: /); assert.deepEqual(a.signals.failed, []);
  assert.deepEqual([b.tier, b.model, b.effort], ['lite', 'claude-haiku-5-5', 'low']); assert.match(b.reason, /^mantido lite/);
  assert.deepEqual(r.c.routing, { tier: 'lite', escalated: false, initial: { tier: 'lite', reason: a.reason, signals: a.signals } });
  assert.equal(notes(r.m, /camada inicial lite/).length, 1); assert.equal(notes(r.m, /escalonado/).length, 0);
});

test('tarefa complexa/ambígua (standard desde o início): nenhuma chamada usa lite e os motivos ficam registrados', async () => {
  const r = await run(COMPLEX, [cont('Criar'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['standard', 'standard']);
  const [a] = routes(r.c);
  assert.deepEqual([a.tier, a.model, a.effort], ['standard', null, null]); assert.match(a.reason, /^standard: /); assert.ok(a.signals.failed.includes('ambiguidade'));
  assert.equal(r.c.routing.escalated, false); assert.equal(r.c.routing.initial.tier, 'standard');
});

test('escalonamento: lite rejeitado => a TENTATIVA SEGUINTE (a que já existia) usa standard, que permanece no resto do ciclo', async () => {
  const r = await run(SIMPLE, ['isto não é JSON', cont('Criar'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['lite', 'standard', 'standard'], 'chamada 1 lite (rejeitada); 2 e 3 standard');
  assert.equal(r.c.plannerCalls, 3); assert.equal(r.c.rejections.length, 1); assert.match(r.c.rejections[0].problem, /^formato inválido/);
  const [c1, c2, c3] = routes(r.c);
  assert.deepEqual([c1.tier, c1.model, c1.effort], ['lite', 'claude-haiku-5-5', 'low']);
  assert.deepEqual([c2.tier, c2.model, c2.effort], ['standard', null, null]); assert.match(c2.reason, /^escalonado de lite para standard/); assert.equal(c2.signals.from, 'lite'); assert.match(c2.signals.rejection, /^formato inválido/);
  assert.equal(c3.tier, 'standard'); assert.match(c3.reason, /^mantido standard: já escalonado/);
  assert.equal(r.c.routing.escalated, true); assert.equal(r.c.routing.escalatedAtCall, 2); assert.equal(r.c.routing.tier, 'standard');
  assert.equal(notes(r.m, /escalonado de lite para standard/).length, 1);
  assert.equal(r.c.assurance, 'verified', 'a conclusão continua exigindo a verificação real');
});

test('sem escalonamento quando a rota inicial já é standard: a rejeição repete a mesma camada', async () => {
  const r = await run(COMPLEX, ['isto não é JSON', cont('Criar'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['standard', 'standard', 'standard']);
  assert.match(routes(r.c)[1].reason, /já era a camada inicial/); assert.equal(r.c.routing.escalated, false); assert.ok(!('escalatedAtCall' in r.c.routing));
  assert.equal(notes(r.m, /escalonado/).length, 0);
});

test('no máximo UM escalonamento por ciclo: nova rejeição em standard não escalona de novo e a retomada continua em standard', async () => {
  const answers = ['lixo 1', 'lixo 2'];
  const r = await run(SIMPLE, answers);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_invalid');
  assert.deepEqual(tiers(r.planner), ['lite', 'standard'], 'duas tentativas, como sempre: nenhuma chamada extra');
  assert.equal(r.c.plannerCalls, 2); assert.equal(r.c.rejections.length, 2);
  assert.equal(r.c.routing.escalatedAtCall, 2);
  answers.push(cont('Criar'), done()); // um humano retoma: o ciclo NÃO volta para lite
  assert.equal((await r.cy.resume(r.m.id)).status, 202); await r.cy.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.deepEqual(tiers(r.planner), ['lite', 'standard', 'standard', 'standard']);
  assert.equal(r.c.routing.escalated, true); assert.equal(r.c.routing.escalatedAtCall, 2, 'continua sendo o 1º e único escalonamento');
  assert.equal(notes(r.m, /escalonado de lite para standard/).length, 1);
});

test('limites de tentativas e consultas inalterados: mesmas 2 tentativas por consulta e mesmo bloqueio, com ou sem roteador', async () => {
  const shape = (r) => ({ s: r.c.status, code: r.c.blockedCode, calls: r.c.plannerCalls, rej: r.c.rejections.length, rounds: r.c.rounds.length });
  const off = await run(SIMPLE, ['x1', 'x2', 'x3'], { router: null }), onSimple = await run(SIMPLE, ['x1', 'x2', 'x3']), onComplex = await run(COMPLEX, ['x1', 'x2', 'x3']);
  assert.deepEqual(shape(onSimple), shape(off)); assert.deepEqual(shape(onComplex), shape(off));
  assert.deepEqual(shape(off), { s: 'blocked', code: 'planner_invalid', calls: 2, rej: 2, rounds: 0 });
  assert.equal(onSimple.planner.answers.length, 1, 'a terceira resposta nem foi pedida');
  const lim = await run(SIMPLE, [cont('A'), cont('B'), cont('C'), cont('D')], { max: 3 });
  assert.ok(lim.c.plannerCalls <= (3 + 1) * 3);
});

test('proteções preservadas em lite: "complete" sem evidência é rejeitado igual e só então escalona', async () => {
  const r = await run(SIMPLE, [done(), cont('Criar'), done()]); // 1º "complete": nenhuma rodada executada
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.match(r.c.rejections[0].problem, /sem nenhuma rodada executada/); assert.equal(r.c.rejections.length, 1);
  assert.deepEqual(tiers(r.planner), ['lite', 'standard', 'standard']);
  const off = await run(SIMPLE, [done(), cont('Criar'), done()], { router: null });
  assert.deepEqual(off.c.rejections.map((x) => x.problem), r.c.rejections.map((x) => x.problem));
  assert.equal(off.c.rounds.length, r.c.rounds.length); assert.equal(off.c.status, r.c.status);
});

test('proteções preservadas: tarefa repetida continua sendo rejeitada (e a rejeição escalona, sem aceitar a repetição)', async () => {
  const r = await run(SIMPLE, [cont('Criar'), cont('Criar'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.equal(r.c.rejections.length, 1); assert.match(r.c.rejections[0].problem, /idêntica a uma de rodadas recentes/);
  assert.equal(r.c.rounds.length, 1, 'a tarefa repetida não virou rodada');
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard']);
});

test('proteções preservadas: com a verificação real REPROVADA, o Planner (qualquer camada) não consegue concluir', async () => {
  const r = await run(SIMPLE, [cont('Criar'), done(), blocked()], { ver: verifier('fail') });
  assert.notEqual(r.c.status, 'completed'); assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_blocked');
  assert.match(r.c.rejections[0].problem, /"complete" rejeitado: verificações reais que não passaram/);
  assert.equal(r.c.rounds[0].verification, 'failed'); assert.ok(!r.c.assurance);
  assert.deepEqual(tiers(r.planner), ['lite', 'lite', 'standard'], 'a rejeição do "complete" indevido é o que escalona');
});

test('roteamento DESLIGADO (sem roteador): nenhum estado, nenhuma camada, nenhuma rota e nenhuma nota de roteamento; decisões iguais', async () => {
  const off = await run(SIMPLE, ['isto não é JSON', cont('Criar'), done()], { router: null });
  assert.equal(off.c.status, 'completed', off.c.blockedReason);
  assert.ok(!('routing' in off.c)); for (const x of off.planner.calls) assert.deepEqual(x.keys, ['cwd', 'onUsage', 'prompt']);
  for (const e of off.c.plannerUsage) assert.ok(!('route' in e));
  assert.ok(off.events.every((e) => !('route' in e))); assert.equal(notes(off.m, /camada inicial|escalonado/).length, 0);
  const on = await run(SIMPLE, ['isto não é JSON', cont('Criar'), done()]);
  assert.equal(on.c.status, off.c.status); assert.equal(on.c.rounds.length, off.c.rounds.length); assert.equal(on.c.plannerCalls, off.c.plannerCalls);
  const norm = (p) => p.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T').replace(/Missão B\d+/g, 'Missão B'); // horários e o título (que muda por missão) não contam
  assert.deepEqual(on.planner.calls.map((x) => norm(x.prompt)), off.planner.calls.map((x) => norm(x.prompt)), 'o roteamento não muda nenhum prompt');
});

test('eventos SSE `usage` e registros carregam a MESMA rota efetiva; totais de uso/custo não mudam por causa dela', async () => {
  const r = await run(SIMPLE, ['isto não é JSON', cont('Criar'), done()]);
  const ended = r.events.filter((e) => e.ended === true);
  assert.deepEqual(ended.map((e) => e.route?.tier), ['lite', 'standard', 'standard']);
  assert.deepEqual(ended.map((e) => e.route), routes(r.c), 'o evento final é igual ao registro persistido');
  assert.ok(r.events.every((e) => e.route), 'também os eventos provisórios (durante a chamada)');
  const clone = structuredClone(r.m); clone.cycle.plannerUsage = clone.cycle.plannerUsage.map(({ route, ...rest }) => rest); delete clone.cycle.routing;
  assert.deepEqual(summarizeUsage([r.m]), summarizeUsage([clone]));
  assert.equal(store.validateDb({ ...structuredClone(db), missions: [JSON.parse(JSON.stringify(r.m))] }), null, 'o estado persistido continua válido');
});

test('rota registrada = argumentos CLI realmente usados (Planner real contra uma CLI que devolve o argv)', async () => {
  const real = createClaudePlanner({ model: 'claude-sonnet-5-5', effort: 'medium', routing: 'on', runnerOptions: { command: process.execPath, prefixArgs: [FAKE_ARGV] } });
  const argvs = [];
  const spy = { ...real, decide: async (a) => { const r = await real.decide(a); argvs.push(r.text ? JSON.parse(r.text) : null); return r; } };
  const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const r = await run(SIMPLE, [], { planner: spy }); // a "resposta" do Planner é o próprio argv: inválida => rejeição => escalonamento
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_invalid'); assert.equal(argvs.length, 2);
  const rs = routes(r.c); assert.equal(rs.length, 2);
  assert.deepEqual([flag(argvs[0], '--model'), flag(argvs[0], '--effort')], ['claude-haiku-5-5', 'low']);
  assert.deepEqual([flag(argvs[1], '--model'), flag(argvs[1], '--effort')], ['claude-sonnet-5-5', 'medium'], 'standard = ORCH_PLANNER_MODEL/EFFORT');
  argvs.forEach((argv, i) => { assert.deepEqual([rs[i].model, rs[i].effort], [flag(argv, '--model'), flag(argv, '--effort')], `chamada ${i + 1}: o registrado é o aplicado`); });
  assert.deepEqual(rs.map((x) => x.tier), ['lite', 'standard']);
  assert.deepEqual(argvs[0].filter((x) => !['--model', 'claude-haiku-5-5', '--effort', 'low'].includes(x)), PLANNER_ARGS, 'o resto dos argumentos é o de sempre');
  assert.deepEqual(argvs[1].filter((x) => !['--model', 'claude-sonnet-5-5', '--effort', 'medium'].includes(x)), PLANNER_ARGS);
});

test('rota "pedida" x "aplicada": se o Planner não aplica o roteamento, o registro diz applied:false em vez de afirmar a camada', async () => {
  const off = createClaudePlanner({ routing: 'off', runnerOptions: { command: process.execPath, prefixArgs: [FAKE_ARGV] } }); // roteador ligado, Planner desligado
  const r = await run(SIMPLE, [], { planner: off });
  assert.equal(r.c.status, 'blocked');
  for (const x of routes(r.c)) { assert.equal(x.applied, false); assert.equal(x.tier, null); assert.equal(x.model, null); assert.ok(['lite', 'standard'].includes(x.requestedTier)); }
});

test('falha do roteador ou das notas nunca interrompe o ciclo (acessório): a chamada segue sem camada', async () => {
  const r = await run(SIMPLE, [cont('Criar'), done()], { router: { pick: () => { throw new Error('falha do roteador'); } } });
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  assert.ok(r.planner.calls.length >= 2); for (const x of r.planner.calls) assert.ok(!x.keys.includes('tier')); assert.ok(!('routing' in r.c));
});
