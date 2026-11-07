// terminals.list() expõe o estado REAL do agente (hooks) por terminal; recarregar a página = nova leitura dos mesmos arquivos (teste 10).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agst-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const T = await import('../terminals.js');
const { createChildRegistry } = await import('../child-registry.js');
const { createAgentStatus } = await import('../agent-status.js');
const { record } = await import('../agent-status-hook.mjs');
store.load(); store.saveOrThrow();
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir);
const statusDir = path.join(tmp, 'status');
function fakePty() {
  const spawned = []; let pid = 1_900_100_000;
  return { spawned, lib: { spawn(file, args, opts) { const p = { pid: ++pid, file, args, opts, dataCb: null, exitCb: null, onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, kill() {}, exit(c = 0) { p.exitCb?.({ exitCode: c }); } }; spawned.push(p); return p; } } };
}
const world = () => {
  const f = fakePty(); let n = 0, clock = Date.parse('2026-01-01T10:00:00.000Z');
  const mgr = T.createTerminalManager({ db: { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }] }, ptyLib: f.lib, agentStatus: createAgentStatus({ dir: statusDir }),
    resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), track: createChildRegistry().track, killTree: () => {}, waitFor: () => true,
    newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => new Date(clock).toISOString() });
  return { f, mgr, tick: (ms) => { clock += ms; } };
};
const sidOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('list(): agent null sem hooks; depois reflete cada evento do agente, por terminal', async () => {
  const w = world();
  const a = (await w.mgr.create({ role: 'builder' })).session, b = (await w.mgr.create({ role: 'reviewer' })).session;
  assert.equal(a.agent, null, 'terminal aberto, nenhum evento ainda: sem estado de agente');
  record(statusDir, { hook_event_name: 'UserPromptSubmit', session_id: sidOf(1) }, () => '2026-01-01T10:00:05.000Z');
  let [la, lb] = w.mgr.list();
  assert.equal(la.agent.state, 'running'); assert.equal(lb.agent, null, 'o outro terminal não é afetado');
  record(statusDir, { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: sidOf(1) }, () => '2026-01-01T10:00:06.000Z');
  assert.equal(w.mgr.list()[0].agent.state, 'waiting');
  record(statusDir, { hook_event_name: 'PostToolUse', session_id: sidOf(1) }, () => '2026-01-01T10:00:07.000Z');
  assert.equal(w.mgr.list()[0].agent.state, 'running', 'aprovou a permissão: volta a executar');
  record(statusDir, { hook_event_name: 'Stop', session_id: sidOf(1) }, () => '2026-01-01T10:00:09.000Z');
  record(statusDir, { hook_event_name: 'StopFailure', session_id: sidOf(2) }, () => '2026-01-01T10:00:09.000Z');
  [la, lb] = w.mgr.list();
  assert.equal(la.agent.state, 'completed'); assert.equal(lb.agent.state, 'error');
});

test('evento duplicado é idempotente; evento anterior ao início do terminal (sobra) é ignorado; processo encerrado não tem estado de agente', async () => {
  const w = world();
  const a = (await w.mgr.create({ role: 'builder' })).session; // startedAt = 10:00:00
  record(statusDir, { hook_event_name: 'Stop', session_id: sidOf(1) }, () => '2025-12-31T23:00:00.000Z'); // sobra de uma execução antiga
  assert.equal(w.mgr.list()[0].agent, null);
  for (let i = 0; i < 3; i++) record(statusDir, { hook_event_name: 'UserPromptSubmit', session_id: sidOf(1) }, () => '2026-01-01T10:00:03.000Z');
  assert.equal(w.mgr.list()[0].agent.state, 'running');
  w.f.spawned[0].exit(0);
  const after = w.mgr.list()[0];
  assert.equal(after.status, 'exited'); assert.equal(after.agent, null);
});

test('recarregar a página: uma nova leitura devolve os mesmos estados (a fonte é o servidor, não a memória do navegador)', async () => {
  const w = world();
  await w.mgr.create({ role: 'builder' }); await w.mgr.create({ role: 'builder' });
  record(statusDir, { hook_event_name: 'UserPromptSubmit', session_id: sidOf(1) }, () => '2026-01-01T10:00:02.000Z');
  record(statusDir, { hook_event_name: 'Stop', session_id: sidOf(2) }, () => '2026-01-01T10:00:02.000Z');
  const first = w.mgr.list().map((s) => s.agent?.state), second = w.mgr.list().map((s) => s.agent?.state);
  assert.deepEqual(first, ['running', 'completed']); assert.deepEqual(second, first);
});
