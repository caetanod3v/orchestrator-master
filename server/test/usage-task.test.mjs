// Token Monitor, fase 2: persistência das métricas na tarefa, evento SSE `usage` e registro por chamada do Planner.
// CLI FALSA, banco e workspace TEMPORÁRIOS (ORCH_DATA_DIR definido antes dos imports); nenhuma CLI real nem dado do usuário.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-task-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace');
fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, bus } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');

let db, server, base, executor, startTaskRun;
const T0 = '2026-01-01T00:00:00.000Z';
const api = async (m, p) => { const r = await fetch(base + p, { method: m }); return r.status; };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const mkTask = (id, title) => ({ id, title, status: 'queued', authorized: true, dependsOn: [], report: '', files: [], log: [] });
const mission = () => db.missions.find((m) => m.id === 'mis');
const task = (id) => mission().tasks.find((t) => t.id === id);
const run = async (id) => { assert.equal(await api('POST', `/api/missions/mis/tasks/${id}/run`), 202); assert.equal(await until(() => task(id).status !== 'running'), true); };

/** Cliente SSE mínimo: acumula os eventos (nome + JSON) até ser parado. */
async function sse() {
  const ac = new AbortController(), events = [];
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(blk)?.[1], data = /^data: (.+)$/m.exec(blk)?.[1];
          if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* abortado */ }
  })();
  await until(() => events.some((e) => e.ev === 'hello'));
  return { events, usage: (taskId) => events.filter((e) => e.ev === 'usage' && e.data.taskId === taskId).map((e) => e.data), stop: () => ac.abort() };
}

before(async () => {
  db = store.load();
  db.workspaces.push({ id: 'ws', name: 'ws', path: wsDir });
  db.missions = [{ id: 'mis', demo: false, title: 'Missão', objective: 'obj', workspaceId: 'ws', createdAt: T0, tasks: [
    mkTask('u1', 'MODE:usage com métricas'), mkTask('u2', 'MODE:ok sem métricas de tokens'), mkTask('u3', 'MODE:usagepartial sem result'), mkTask('u4', 'MODE:fail sem nada'),
    { ...mkTask('old', 'tarefa antiga'), status: 'completed', usage: { costUsd: 0.5, durationMs: 9, turns: 1 } },
  ] }];
  store.save();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const app = express(); app.use(express.json());
  ({ startTaskRun } = setupExecution(app, { db, executor }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close(); server.closeAllConnections?.();
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('execução com métricas: SSE `usage` provisório -> final -> encerrado, persistido na tarefa e sem dupla contagem', async () => {
  const s = await sse();
  await run('u1');
  assert.equal(await until(() => s.usage('u1').some((e) => e.ended)), true);
  s.stop();
  const ev = s.usage('u1');
  // msg_A repetida (2ª ocorrência) e o subagente NÃO geram atualização: 2 mensagens + limite + result + encerramento.
  assert.deepEqual(ev.map((e) => [e.provisional, e.ended, e.basis]), [[true, false, 'live'], [true, false, 'live'], [true, false, 'live'], [false, false, 'final'], [false, true, 'final']]);
  assert.deepEqual(ev.map((e) => e.live?.messages ?? null), [1, 2, 2, 2, 2]);
  assert.deepEqual(ev[1].live.tokens, { input: 5, output: 2, cacheCreation: 100, cacheRead: 200 }, 'soma só das mensagens distintas (2+3), sem a repetida nem o subagente');
  assert.deepEqual(ev[2].rateLimit, { status: 'allowed', utilization: null, resetsAt: 1792922400 });
  assert.equal(ev[0].final, null, 'antes do result não há total final (nada de zeros)');
  assert.ok(ev.every((e) => e.agent === 'executor' && e.missionId === 'mis' && e.taskId === 'u1'));
  assert.ok(!JSON.stringify(ev).includes('Relatório de uso'), 'o evento não leva texto do modelo');

  const t = task('u1');
  assert.equal(t.status, 'awaiting_approval');
  assert.deepEqual(t.usage, { costUsd: 0.05, durationMs: 7, turns: 2 }, 'task.usage existente intacto');
  assert.equal(t.tokenUsage.basis, 'final'); assert.equal(t.tokenUsage.provisional, false); assert.equal(t.tokenUsage.ended, true);
  assert.deepEqual(t.tokenUsage.final.tokens, { input: 5, output: 9, cacheCreation: 100, cacheRead: 200 }, 'o total é o do result, não a soma das mensagens');
  assert.equal(t.tokenUsage.final.models['modelo-sintetico'].costUsd, 0.05);
  assert.deepEqual({ agent: 'executor', missionId: 'mis', taskId: 'u1', ...t.tokenUsage }, ev.at(-1), 'o registro persistido é exatamente o último evento');
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8'));
  assert.equal(disk.missions[0].tasks[0].tokenUsage.basis, 'final');
});

test('execução sem métricas de tokens: só o custo do result; nada vira zero; tarefa antiga sem tokenUsage continua válida', async () => {
  await run('u2');
  const t = task('u2');
  assert.deepEqual(t.usage, { costUsd: 0.0123, durationMs: 42, turns: 2 });
  assert.equal(t.tokenUsage.basis, 'final'); assert.equal(t.tokenUsage.final.costUsd, 0.0123);
  assert.equal(t.tokenUsage.final.tokens, null); assert.equal(t.tokenUsage.final.models, null); assert.equal(t.tokenUsage.live, null);
  assert.equal(task('old').tokenUsage, undefined, 'tarefa antiga: campo ausente, não zerado');
  assert.deepEqual(task('old').usage, { costUsd: 0.5, durationMs: 9, turns: 1 });
});

test('interrupção sem result: o parcial fica como provisório (basis live), sem final; task.usage continua null', async () => {
  const s = await sse();
  assert.equal(await api('POST', '/api/missions/mis/tasks/u3/run'), 202);
  assert.equal(await until(() => task('u3').tokenUsage?.basis === 'live'), true, 'métrica parcial persistida durante a execução');
  assert.equal(task('u3').tokenUsage.ended, false);
  assert.equal(await api('POST', '/api/execution/stop'), 200);
  assert.equal(await until(() => task('u3').status === 'interrupted'), true);
  assert.equal(await until(() => s.usage('u3').some((e) => e.ended)), true);
  s.stop();
  const t = task('u3');
  assert.equal(t.usage, null);
  assert.equal(t.tokenUsage.final, null); assert.equal(t.tokenUsage.provisional, true); assert.equal(t.tokenUsage.ended, true);
  assert.deepEqual(t.tokenUsage.live.tokens, { input: 7, output: 1, cacheCreation: 0, cacheRead: 70 });
  assert.deepEqual(s.usage('u3').map((e) => e.provisional), [true, true], 'nenhuma atualização é apresentada como final');
});

test('falha sem nenhuma métrica: tokenUsage null e nenhum evento `usage`', async () => {
  const s = await sse();
  await run('u4');
  await new Promise((r) => setTimeout(r, 150));
  s.stop();
  assert.equal(task('u4').status, 'failed'); assert.equal(task('u4').tokenUsage, null);
  assert.deepEqual(s.usage('u4'), []);
});

test('reinício durante a execução: as métricas parciais da tarefa perdida são preservadas e marcadas como encerradas/provisórias', () => {
  const lost = { id: 'x', title: 'x', status: 'running', usage: null, log: [], tokenUsage: { basis: 'live', provisional: true, ended: false, final: null, live: { provisional: true, messages: 1, unidentified: 0, tokens: { input: 1, output: 1, cacheCreation: null, cacheRead: null } }, rateLimit: null, updatedAt: T0 } };
  setupExecution(express(), { db: { missions: [{ id: 'r', demo: false, tasks: [lost] }], workspaces: [] }, executor });
  assert.equal(lost.status, 'interrupted');
  assert.equal(lost.tokenUsage.ended, true); assert.equal(lost.tokenUsage.provisional, true); assert.equal(lost.tokenUsage.live.tokens.input, 1);
});

test('Planner: um registro por chamada em cycle.plannerUsage + SSE `usage` (agent planner); planner sem métricas não gera nada', async () => {
  const snap = (fin) => ({ final: fin ? { tokens: { input: 4, output: 6, cacheCreation: 10, cacheRead: 20 }, tokensAllModels: null, costUsd: 0.02, models: null } : null,
    live: { provisional: true, messages: 1, unidentified: 0, tokens: { input: 4, output: 1, cacheCreation: 10, cacheRead: 20 } }, rateLimit: null });
  const decisions = [
    JSON.stringify({ decision: 'continue', rationale: 'r1', task: { title: 't1', instructions: 'MODE:write t1', acceptance: ['a'] } }),
    JSON.stringify({ decision: 'blocked', rationale: 'r2', blockedReason: 'preciso de um humano' }),
  ];
  const planner = { busy: () => false, cancel: async () => {}, decide: async ({ onUsage }) => { onUsage?.(snap(false)); return { text: decisions.shift(), usage: { costUsd: 0.02, turns: 1, metrics: snap(true) } }; } };
  const seen = [];
  const on = (e) => seen.push(e); bus.on('usage', on);
  const m = { id: 'pm', demo: false, title: 'P', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [] };
  db.missions.unshift(m);
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  assert.equal((await cy.start('pm', 3)).status, 202); await cy.idle();
  bus.off('usage', on);
  const c = m.cycle;
  assert.equal(c.status, 'blocked');
  assert.equal(c.plannerUsage.length, 2, 'um registro por chamada ao Planner');
  assert.deepEqual(c.plannerUsage.map((p) => [p.call, p.basis, p.provisional, p.ended]), [[1, 'final', false, true], [2, 'final', false, true]]);
  assert.equal(c.plannerUsage[0].final.tokens.output, 6); assert.equal(c.plannerUsage[0].final.costUsd, 0.02);
  const pl = seen.filter((e) => e.agent === 'planner');
  assert.deepEqual(pl.map((e) => [e.call, e.ended]), [[1, false], [1, true], [2, false], [2, true]], 'provisório durante a chamada e registro final ao fim');
  assert.ok(pl.every((e) => e.missionId === 'pm' && e.cycleId === c.id));

  // Planner sem métricas (todos os simulados existentes): nada é criado, nada vira zero.
  const m2 = { id: 'pm2', demo: false, title: 'P2', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [] };
  db.missions.unshift(m2);
  const quiet = { busy: () => false, cancel: async () => {}, decide: async () => ({ text: JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' }) }) };
  await createCycle({ db, executor, planner: quiet, startTaskRun, listFiles: () => [] }).start('pm2', 3);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal('plannerUsage' in m2.cycle, false);
});
