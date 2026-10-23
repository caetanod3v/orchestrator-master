import test from 'node:test';
import assert from 'node:assert/strict';
import { runBlockers, authorizeBlockers } from '../executor/policy.js';
import { parseLine, formatEvent } from '../executor/stream.js';
import { CLAUDE_ARGS } from '../executor/index.js';
import { validateDir } from '../workspaces.js';

const ws = { id: 'ws1', path: process.cwd() };
const okDir = () => ({ ok: true });
const mk = (over = {}, taskOver = {}) => {
  const t1 = { id: 't1', title: 'a', status: 'completed', dependsOn: [] };
  const t2 = { id: 't2', title: 'b', status: 'queued', authorized: true, dependsOn: ['t1'], ...taskOver };
  const mission = { id: 'm', demo: false, workspaceId: 'ws1', tasks: [t1, t2], ...over };
  return { mission, task: t2 };
};
const base = { workspace: ws, validateDir: okDir, busy: false, cliAvailable: true };

test('tarefa elegível não tem bloqueio', () => {
  assert.equal(runBlockers({ ...mk(), ...base }), null);
});
test('bloqueia missão demonstrativa', () => {
  assert.match(runBlockers({ ...mk({ demo: true }), ...base }), /demonstrativa/);
});
test('bloqueia tarefa sem autorização humana', () => {
  assert.match(runBlockers({ ...mk({}, { authorized: false }), ...base }), /autorização/);
});
test('bloqueia tarefa rejeitada, mesmo autorizada', () => {
  assert.match(runBlockers({ ...mk({}, { rejected: true, status: 'failed' }), ...base }), /rejeitada/);
});
test('bloqueia dependências pendentes', () => {
  const { mission, task } = mk();
  mission.tasks[0].status = 'awaiting_approval'; // resultado ainda não aprovado por humano
  assert.match(runBlockers({ mission, task, ...base }), /Dependências pendentes: 01/);
});
test('bloqueia sem workspace, workspace inválido, CLI ausente e execução simultânea', () => {
  assert.match(runBlockers({ ...mk(), ...base, workspace: null }), /workspace/i);
  assert.match(runBlockers({ ...mk(), ...base, validateDir: () => ({ ok: false, error: 'Diretório não existe.' }) }), /inválido/);
  assert.match(runBlockers({ ...mk(), ...base, cliAvailable: false }), /Claude Code/);
  assert.match(runBlockers({ ...mk(), ...base, busy: true }), /em andamento/);
});
test('bloqueia estados que não são "queued"', () => {
  for (const status of ['running', 'awaiting_approval', 'completed', 'failed', 'interrupted']) {
    assert.ok(runBlockers({ ...mk({}, { status }), ...base }), status);
  }
});
test('autorizar: só queued/failed/interrupted, nunca rejeitada ou demo', () => {
  assert.equal(authorizeBlockers(mk({}, { status: 'failed' })), null);
  assert.equal(authorizeBlockers(mk({}, { status: 'interrupted' })), null);
  assert.ok(authorizeBlockers(mk({}, { status: 'running' })));
  assert.ok(authorizeBlockers(mk({}, { status: 'failed', rejected: true })));
  assert.ok(authorizeBlockers(mk({ demo: true })));
});

test('validateDir: relativo, UNC, raiz e inexistente são recusados', () => {
  assert.equal(validateDir('relativo/x').ok, false);
  assert.equal(validateDir('\\\\servidor\\share').ok, false);
  assert.equal(validateDir('C:\\').ok, false);
  assert.equal(validateDir('C:\\nao\\existe\\mesmo').ok, false);
  assert.equal(validateDir(process.cwd()).ok, true);
  assert.equal(validateDir(undefined).ok, false);
});

test('argumentos fixos da CLI nunca desativam permissões', () => {
  const joined = CLAUDE_ARGS.join(' ');
  assert.ok(!/dangerously|bypassPermissions|skip-permissions/i.test(joined));
  assert.ok(CLAUDE_ARGS.includes('--permission-prompts') && CLAUDE_ARGS[CLAUDE_ARGS.indexOf('--permission-prompts') + 1] === 'none');
  assert.ok(!/Bash|PowerShell|WebFetch/.test(CLAUDE_ARGS[CLAUDE_ARGS.indexOf('--tools') + 1]));
});

test('stream: traduz eventos reais e mantém texto bruto', () => {
  assert.deepEqual(parseLine('texto solto').lines, ['[stdout] texto solto']);
  const r = parseLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.5, num_turns: 3, duration_ms: 10 }));
  assert.equal(r.result.costUsd, 0.5);
  assert.equal(r.result.isError, false);
  const tool = formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } }] } });
  assert.equal(tool.lines[0], '[ferramenta] Edit a.js');
  assert.equal(parseLine('').lines.length, 0);
});
