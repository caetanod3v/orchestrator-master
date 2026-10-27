// Incremento A: metadados de rota nos registros de uso do Planner. Banco TEMPORÁRIO, CLI FALSA (Executor), Planner SIMULADO: nenhum modelo é chamado.
// Prova que (1) sem roteador nada muda, (2) com roteador só entra o campo `route`, (3) as decisões e os totais de uso/custo são os mesmos e
// (4) registros antigos continuam válidos.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routing-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, bus } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createRouter } = await import('../routing.js');
const { summarizeUsage } = await import('../usage.js');

let db, executor, startTaskRun, seq = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['out.txt conferido'] });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { 'modelo-sintetico': { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
/** Planner simulado: guarda os argumentos de CADA chamada a decide(); com `tiers`, também implementa describeTier. */
const scripted = (answers, { tiers = true } = {}) => {
  const calls = [];
  return { calls, busy: () => false, cancel: async () => {}, ...(tiers ? { describeTier: (tier) => ({ tier, model: 'modelo-pedido', effort: 'esforco-pedido' }) } : {}),
    decide: async (a) => { calls.push(a); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) } }; } };
};
const mkMission = () => { const m = { id: `r${++seq}`, demo: false, title: 'Missão R', objective: 'Objetivo R', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
async function runCycle(answers, { router = null, planner = scripted(answers) } = {}) {
  const m = mkMission(), cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => ['LEIAME.md'], router });
  const events = []; const on = (e) => events.push(e); bus.on('usage', on);
  assert.equal((await cy.start(m.id, 3)).status, 202); await cy.idle(); bus.off('usage', on);
  return { m, c: m.cycle, planner, events: events.filter((e) => e.agent === 'planner' && e.missionId === m.id) };
}
const norm = (p) => p.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
const strip = (entries) => entries.map(({ route, ...rest }) => rest);
const KEYS = ['basis', 'call', 'ended', 'final', 'live', 'provisional', 'rateLimit', 'updatedAt'];

test('roteamento DESLIGADO (sem roteador): decide() não recebe `tier` e os registros de uso não têm `route` (formato de sempre)', async () => {
  const { c, planner, events } = await runCycle([cont('Criar'), done()]);
  assert.equal(c.status, 'completed'); assert.equal(c.plannerUsage.length, 2);
  for (const a of planner.calls) { assert.deepEqual(Object.keys(a).sort(), ['cwd', 'onUsage', 'prompt']); assert.ok(!('tier' in a)); }
  for (const e of c.plannerUsage) { assert.deepEqual(Object.keys(e).sort(), KEYS); assert.ok(!('route' in e)); }
  assert.ok(events.length >= 2 && events.every((e) => !('route' in e)), 'eventos SSE sem route');
});

test('roteamento LIGADO: só é acrescentado `route` (camada, modelo e esforço aplicados, motivo, sinais) a cada chamada', async () => {
  const { c, planner, events } = await runCycle([cont('Criar'), done()], { router: createRouter() });
  assert.equal(c.status, 'completed'); assert.equal(c.plannerUsage.length, 2);
  for (const a of planner.calls) assert.equal(a.tier, 'standard');
  for (const e of c.plannerUsage) {
    assert.deepEqual(Object.keys(e).sort(), [...KEYS, 'route'].sort());
    assert.deepEqual(Object.keys(e.route).sort(), ['effort', 'model', 'reason', 'signals', 'tier']);
    assert.equal(e.route.tier, 'standard'); assert.equal(e.route.model, 'modelo-pedido'); assert.equal(e.route.effort, 'esforco-pedido');
    if (e.call === 1) { assert.match(e.route.reason, /^standard: /); assert.ok(e.route.signals.failed.includes('sem_verificacao_obrigatoria'), 'sem verificação obrigatória, a seleção inicial é standard'); } else assert.match(e.route.reason, /^mantido standard/);
  }
  assert.ok(events.some((e) => e.route?.tier === 'standard' && e.ended === true), 'o evento final também leva a rota');
  assert.ok(events.every((e) => e.route?.tier === 'standard'));
});

test('ligado x desligado: mesmo ciclo, mesmas decisões, mesmos prompts, mesmas rejeições e mesmos totais de uso e custo', async () => {
  const script = () => [done(), cont('Criar'), done()]; // o 1º "complete" é rejeitado pelo backend (nenhuma rodada) nos dois modos
  const off = await runCycle(script()), on = await runCycle(script(), { router: createRouter() });
  assert.equal(on.c.status, off.c.status); assert.equal(on.c.status, 'completed');
  assert.equal(on.c.rounds.length, off.c.rounds.length); assert.equal(on.c.plannerCalls, off.c.plannerCalls);
  assert.deepEqual(on.c.rounds.map((r) => r.decision?.decision), off.c.rounds.map((r) => r.decision?.decision));
  assert.deepEqual(on.planner.calls.map((a) => norm(a.prompt)), off.planner.calls.map((a) => norm(a.prompt)), 'os prompts são idênticos');
  assert.equal(off.c.rejections.length, 1); assert.match(off.c.rejections[0].problem, /sem nenhuma rodada executada/);
  assert.deepEqual(on.c.rejections.map((r) => r.problem), off.c.rejections.map((r) => r.problem), 'a regra de conclusão rejeita igual nos dois modos');
  assert.equal(on.c.plannerUsage.length, 3);
  assert.deepEqual(strip(on.c.plannerUsage).map(({ updatedAt, ...r }) => r), strip(off.c.plannerUsage).map(({ updatedAt, ...r }) => r), 'fora `route` (e o horário), os registros são iguais');
  const a = summarizeUsage([on.m]), b = summarizeUsage([off.m]);
  assert.deepEqual(a.byAgent.planner, b.byAgent.planner); assert.equal(a.byAgent.planner.entries, 3);
  assert.deepEqual(a.total, b.total); assert.deepEqual(a.byCycle.map((x) => x.total), b.byCycle.map((x) => x.total));
});

test('os metadados de rota não alteram o resumo de uso: com ou sem `route` nos mesmos registros, os totais são iguais', async () => {
  const { m } = await runCycle([cont('Criar'), done()], { router: createRouter() });
  assert.ok(m.cycle.plannerUsage.every((e) => e.route));
  const clone = structuredClone(m); clone.cycle.plannerUsage = strip(clone.cycle.plannerUsage);
  assert.deepEqual(summarizeUsage([m]), summarizeUsage([clone]));
  assert.ok(summarizeUsage([m]).total.costUsd > 0);
});

test('registros ANTIGOS (sem `route`) e novos convivem: resumo, validação do banco e leitura continuam válidos', () => {
  const old = (call) => ({ call, basis: 'final', provisional: false, ended: true, final: metrics(0.02).final, live: null, rateLimit: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  const mixed = [old(1), { ...old(2), route: { tier: 'standard', model: null, effort: null, reason: 'x', signals: {} } }, { ...old(3), route: null }];
  const m = { id: 'old1', demo: false, title: 't', objective: '', workspaceId: 'ws', createdAt: 'T0', tasks: [], cycle: { id: 'cyc_old', status: 'completed', rounds: [], plannerUsage: mixed } };
  const u = summarizeUsage([m]);
  assert.equal(u.byAgent.planner.entries, 3); assert.ok(Math.abs(u.byAgent.planner.costUsd - 0.06) < 1e-9);
  assert.equal(store.validateDb({ ...structuredClone(db), missions: [m] }), null, 'o banco com registros dos dois formatos continua válido');
  assert.equal(JSON.parse(JSON.stringify(m)).cycle.plannerUsage[1].route.tier, 'standard', 'sobrevive à serialização (persistência)');
});

test('Planner sem describeTier (ou roteador que falha): o ciclo funciona; a rota aplicada fica null (applied:false) e, se o roteador lança, não há rota nem `tier`', async () => {
  const semDescribe = await runCycle([cont('Criar'), done()], { router: createRouter(), planner: scripted([cont('Criar'), done()], { tiers: false }) });
  assert.equal(semDescribe.c.status, 'completed');
  assert.deepEqual(semDescribe.c.plannerUsage.map((e) => [e.route.tier, e.route.model, e.route.effort]), [[null, null, null], [null, null, null]]);
  assert.ok(semDescribe.c.plannerUsage.every((e) => e.route.applied === false && e.route.requestedTier === 'standard'), 'sem confirmação do Planner, registra-se só o pedido (applied:false)');
  const quebrado = await runCycle([cont('Criar'), done()], { router: { pick: () => { throw new Error('falha do roteador'); } } });
  assert.equal(quebrado.c.status, 'completed');
  for (const a of quebrado.planner.calls) assert.ok(!('tier' in a));
  for (const e of quebrado.c.plannerUsage) assert.ok(!('route' in e));
});

test('o roteamento não cria chamadas nem muda limites: o orçamento de consultas e o bloqueio de falta de progresso são os mesmos', async () => {
  const lim = async (router) => { const r = await runCycle([cont('A'), cont('B'), cont('C'), cont('D')], { router }); return { s: r.c.status, n: r.c.rounds.length, p: r.c.plannerCalls, code: r.c.blockedCode }; };
  const off = await lim(null), on = await lim(createRouter());
  assert.deepEqual(on, off);
  assert.ok(on.p <= (3 + 1) * 3, 'plannerCalls dentro de (rodadas + 1) × 3');
});
