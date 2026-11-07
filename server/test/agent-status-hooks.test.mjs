// Estado real do agente: hooks do Claude Code -> arquivo -> terminals.list() -> indicadores (terminal e workspace).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgentStatus, hooksJson, stateOf, HOOK_EVENTS } from '../agent-status.js';
import { normalize, record } from '../agent-status-hook.mjs';
import { materialize, pluginFiles } from '../loadouts.js';
import { paneState, environments, wsTone, pendingPanes } from '../../client/src/env-view.js';
import { tally, toneOf, openTabs } from '../../client/src/workspace-nav.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SID = '123e4567-e89b-42d3-a456-426614174000', SID2 = '223e4567-e89b-42d3-a456-426614174001';
const HOOK = fileURLToPath(new URL('../agent-status-hook.mjs', import.meta.url));

// ---------- eventos -> estado ----------
test('mapa evento -> estado; evento desconhecido não vira estado', () => {
  assert.equal(stateOf('UserPromptSubmit'), 'running'); assert.equal(stateOf('PostToolUse'), 'running');
  assert.equal(stateOf('Notification'), 'waiting'); assert.equal(stateOf('Stop'), 'completed');
  assert.equal(stateOf('StopFailure'), 'error'); assert.equal(stateOf('SessionStart'), 'idle');
  assert.equal(stateOf('Bogus'), null); assert.equal(stateOf(undefined), null);
});

test('hook: notificação de "ocioso" ou login não sobrescreve o concluído; permissão vira aguardando', () => {
  assert.equal(normalize({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
  assert.equal(normalize({ hook_event_name: 'Notification', notification_type: 'auth_success' }), null);
  assert.equal(normalize({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), 'Notification');
  assert.equal(normalize({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), 'Notification');
  assert.equal(normalize({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), null);
  assert.equal(normalize({ hook_event_name: 'Nope' }), null);
});

test('hook record: só grava com session_id em formato de UUID, sem escapar da pasta', () => {
  const dir = path.join(tmp, 'rec');
  assert.equal(record(dir, { hook_event_name: 'Stop', session_id: '../../etc/passwd' }), false);
  assert.equal(record(dir, { hook_event_name: 'Stop', session_id: SID }, () => '2026-01-01T10:00:00.000Z'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')), { event: 'Stop', at: '2026-01-01T10:00:00.000Z' });
  assert.deepEqual(fs.readdirSync(dir), [`${SID}.json`], 'nada de arquivo temporário sobrando');
});

test('script do hook de verdade: lê o JSON do stdin, grava, sai com 0 e não escreve na saída', () => {
  const dir = path.join(tmp, 'proc');
  const r = spawnSync(process.execPath, [HOOK, dir], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID }), encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.equal(createAgentStatus({ dir }).read(SID).state, 'running');
  const bad = spawnSync(process.execPath, [HOOK, dir], { input: 'não é json', encoding: 'utf8' });
  assert.equal(bad.status, 0, 'entrada inválida nunca atrapalha o agente');
});

// ---------- leitor ----------
test('leitor: estado atual, ignora sobra anterior ao início do terminal, arquivo corrompido e id inválido', () => {
  const dir = path.join(tmp, 'rd'); fs.mkdirSync(dir, { recursive: true });
  const st = createAgentStatus({ dir });
  assert.equal(st.read(SID), null, 'sem arquivo');
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ event: 'Stop', at: '2026-01-01T10:00:00.000Z' }));
  assert.equal(st.read(SID).state, 'completed');
  assert.equal(st.read(SID, { since: '2026-01-01T11:00:00.000Z' }), null, 'evento de uma execução anterior');
  assert.equal(st.read(SID, { since: '2026-01-01T09:00:00.000Z' }).state, 'completed');
  fs.writeFileSync(path.join(dir, `${SID2}.json`), '{quebrado');
  assert.equal(st.read(SID2), null);
  assert.equal(st.read('../x'), null);
});

// ---------- plugin com hooks ----------
test('hooksJson registra todos os eventos; caminho inseguro desliga os hooks; o plugin leva hooks/hooks.json', () => {
  const h = hooksJson({ node: '/usr/bin/node', script: '/app/agent-status-hook.mjs', dir: '/data/agent-status' });
  assert.deepEqual(Object.keys(h.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(h.hooks.Stop[0].hooks[0].command, '"/usr/bin/node" "/app/agent-status-hook.mjs" "/data/agent-status"');
  assert.equal(hooksJson({ node: 'C:\\Program Files\\nodejs\\node.exe', script: '/a.mjs', dir: '/d' }).hooks.Stop[0].hooks[0].command.startsWith('"C:/Program Files/nodejs/node.exe"'), true);
  assert.equal(hooksJson({ node: '/usr/bin/node', script: '/app/a"b.mjs', dir: '/d' }), null);
  assert.equal(hooksJson({ node: '/n', script: '/a$(x).mjs', dir: '/d' }), null);
  assert.ok(pluginFiles('builder', [], h)['hooks/hooks.json']);
  assert.equal(pluginFiles('builder', []) ['hooks/hooks.json'], undefined);
  const dir = materialize(path.join(tmp, 'plug'), 'builder', [], h);
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks.json')));
  assert.equal(materialize(path.join(tmp, 'plug'), 'builder', []), null, 'sem skills e sem hooks continua sem plugin');
});

// ---------- indicadores ----------
const run = (id, ws, agent, over = {}) => ({ id, workspaceId: ws, status: 'running', exitCode: null, agent, ...over });
const W = [{ id: 'a', name: 'a', path: '/a' }, { id: 'b', name: 'b', path: '/b' }];
const ag = (state) => ({ state, at: '2026-01-01T10:00:00Z' });
const none = new Set();

test('1 e 2: agente inicia -> terminal e workspace ficam verdes (executando)', () => {
  const s = [run('t1', 'a', ag('running'))];
  assert.equal(paneState(s[0], none), 'working');
  assert.equal(wsTone(environments({ workspaces: W, sessions: s })[0]), 'work');
});
test('3 e 4: agente conclui -> terminal concluído; todos concluem -> workspace concluído', () => {
  const s = [run('t1', 'a', ag('completed')), run('t2', 'a', ag('completed'))];
  assert.equal(paneState(s[0], none), 'done');
  assert.equal(wsTone(environments({ workspaces: W, sessions: s })[0]), 'done');
  const mixed = [run('t1', 'a', ag('completed')), run('t2', 'a', ag('running'))];
  assert.equal(wsTone(environments({ workspaces: W, sessions: mixed })[0]), 'work', 'ainda há execução: continua executando');
});
test('5: agente aguardando permissão ou tarefa do maestro pendente -> âmbar', () => {
  assert.equal(paneState(run('t1', 'a', ag('waiting')), none), 'waiting');
  const s = [run('t1', 'a', ag('completed'))], tasks = [{ status: 'pending', to: 't1' }];
  assert.equal(paneState(s[0], none, pendingPanes(tasks)), 'waiting');
  assert.equal(wsTone(environments({ workspaces: W, sessions: s, maestroTasks: tasks })[0]), 'wait');
});
test('6: agente falha (hook ou processo) -> vermelho, e vence os demais estados', () => {
  assert.equal(paneState(run('t1', 'a', ag('error')), none), 'failed');
  assert.equal(paneState({ id: 't', workspaceId: 'a', status: 'exited', exitCode: 1 }, none), 'failed');
  const s = [run('t1', 'a', ag('error')), run('t2', 'a', ag('waiting')), run('t3', 'a', ag('running'))];
  assert.equal(wsTone(environments({ workspaces: W, sessions: s })[0]), 'err');
});
test('7: terminal aberto sem atividade -> cinza (aberto não é executando)', () => {
  const s = [run('t1', 'a', ag('idle')), run('t2', 'a', null)];
  assert.equal(paneState(s[0], none), 'idle'); assert.equal(paneState(s[1], none), 'idle');
  assert.equal(wsTone(environments({ workspaces: W, sessions: s })[0]), 'idle');
  assert.equal(paneState({ id: 't', workspaceId: 'a', status: 'exited', exitCode: 0 }, none), 'exited');
});
test('8: dois agentes executando no mesmo workspace -> agregado correto', () => {
  const s = [run('t1', 'a', ag('running')), run('t2', 'a', ag('running'))];
  const e = environments({ workspaces: W, sessions: s })[0];
  assert.deepEqual([e.running, e.working, wsTone(e)], [2, 2, 'work']);
  assert.equal(tally(s, none, []).working, 2);
});
test('9: workspaces diferentes têm indicadores independentes', () => {
  const s = [run('t1', 'a', ag('running')), run('t2', 'b', ag('error'))];
  const [a, b] = environments({ workspaces: W, sessions: s });
  assert.equal(wsTone(a), 'work'); assert.equal(wsTone(b), 'err');
  const tabs = openTabs({ workspaces: W, openWorkspaceIds: ['a', 'b'], activeId: 'a', sessions: s });
  assert.deepEqual(tabs.map((t) => t.tone), ['work', 'err']);
});
test('sem hooks (agent ausente) cai na leitura pela saída; com hooks, a saída não manda', () => {
  const s = run('t1', 'a', null);
  assert.equal(paneState(s, new Set(['t1'])), 'working');
  assert.equal(paneState(run('t1', 'a', ag('completed')), new Set(['t1'])), 'done', 'o hook diz que terminou: eco/redesenho não reabre o trabalho');
  assert.equal(toneOf(tally([s], new Set(['t1']), [])), 'work');
});
