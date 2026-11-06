import test from 'node:test';
import assert from 'node:assert/strict';
import { finishedStamps, unseenFinished } from '../../client/src/workspace-nav.js';

const sessions = [
  { id: 't1', workspaceId: 'a', status: 'running', endedAt: null },
  { id: 't2', workspaceId: 'b', status: 'exited', endedAt: '2026-01-01T10:00:00Z' },
];
const tasks = [
  { id: 'k1', to: 't1', status: 'done', doneAt: '2026-01-01T11:00:00Z' },
  { id: 'k2', to: 't1', status: 'pending', doneAt: null },
];

test('finishedStamps: tarefa concluída e terminal encerrado marcam o workspace certo; pendente não', () => {
  const m = finishedStamps({ sessions, maestroTasks: tasks });
  assert.equal(m.get('a'), '2026-01-01T11:00:00Z');
  assert.equal(m.get('b'), '2026-01-01T10:00:00Z');
});

test('unseenFinished: ignora o ativo, o já visto e o anterior ao baseline', () => {
  const stamps = finishedStamps({ sessions, maestroTasks: tasks });
  assert.deepEqual([...unseenFinished({ stamps, baseline: '2026-01-01T00:00:00Z', activeId: 'a' })], ['b']);
  assert.deepEqual([...unseenFinished({ stamps, seen: { b: '2026-01-01T10:00:00Z' }, baseline: '2026-01-01T00:00:00Z', activeId: 'a' })], []);
  assert.deepEqual([...unseenFinished({ stamps, baseline: '2026-02-01T00:00:00Z' })], []);
});
