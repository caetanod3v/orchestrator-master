// Restauração automática das sessões do ÚLTIMO encerramento (client/src/session-history.js). PURO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRows, lastShutdownRestore, attemptKey, readAutoRestore, writeAutoRestore, AUTO_RESTORE_WINDOW_MS } from '../../client/src/session-history.js';

const rec = (id, endedAt, over = {}) => ({ id, workspaceId: 'w', title: id, role: 'builder', state: 'interrupted', resumable: true, closedReason: 'shutdown', endedAt, ...over });
const rows = (list) => historyRows({ history: list, workspaceId: 'w' });

test('só as sessões do último encerramento voltam sozinhas; as de encerramentos antigos ficam para o Histórico', () => {
  const r = rows([rec('a', '2026-11-07T01:00:00.000Z'), rec('b', '2026-11-07T01:00:03.000Z'), rec('velha', '2026-11-06T10:00:00.000Z')]);
  assert.equal(r.restore.length, 3);
  assert.deepEqual(lastShutdownRestore(r.restore).map((x) => x.id).sort(), ['a', 'b']);
});

test('fora da janela de 2 min não entra; dentro dela entra; sem data válida não entra', () => {
  const t0 = Date.parse('2026-11-07T01:00:00.000Z'), at = (ms) => new Date(t0 - ms).toISOString();
  const r = rows([rec('novo', at(0)), rec('dentro', at(AUTO_RESTORE_WINDOW_MS)), rec('fora', at(AUTO_RESTORE_WINDOW_MS + 1000)), rec('semdata', null)]);
  assert.deepEqual(lastShutdownRestore(r.restore).map((x) => x.id).sort(), ['dentro', 'novo']);
  assert.deepEqual(lastShutdownRestore([]), []);
});

test('o servidor manda: sessão não retomável (worktree removido, sem transcrição) ou encerrada pelo usuário nunca é candidata', () => {
  const r = rows([rec('ok', '2026-11-07T01:00:00.000Z'), rec('semwt', '2026-11-07T01:00:00.000Z', { resumable: false, blockedReason: 'worktree_missing' }), rec('user', '2026-11-07T01:00:00.000Z', { state: 'exited', closedReason: 'user' })]);
  assert.deepEqual(lastShutdownRestore(r.restore).map((x) => x.id), ['ok']);
});

test('attemptKey muda quando o mesmo registro é interrompido de novo (um novo encerramento pode restaurar outra vez)', () => {
  assert.notEqual(attemptKey({ id: 'a', endedAt: '2026-11-07T01:00:00Z' }), attemptKey({ id: 'a', endedAt: '2026-11-07T02:00:00Z' }));
  assert.equal(attemptKey({ id: 'a', endedAt: 'x' }), attemptKey({ id: 'a', endedAt: 'x' }));
});

test('preferência: padrão ligado; desligar persiste; armazenamento quebrado nunca derruba', () => {
  const mem = new Map(), st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readAutoRestore(st), true);
  writeAutoRestore(false, st); assert.equal(readAutoRestore(st), false);
  writeAutoRestore(true, st); assert.equal(readAutoRestore(st), true);
  const broken = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  assert.equal(readAutoRestore(broken), true); assert.doesNotThrow(() => writeAutoRestore(false, broken));
});
