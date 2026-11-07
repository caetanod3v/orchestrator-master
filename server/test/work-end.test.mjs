import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkEndTracker, finishedStamps, unseenFinished } from '../../client/src/workspace-nav.js';
import { environments, wsTone } from '../../client/src/env-view.js';

test('createWorkEndTracker: só registra o fim depois de settleMs sem trabalho; oscilação curta não conta', () => {
  let t = 0; const tr = createWorkEndTracker({ now: () => t, settleMs: 4000 });
  assert.deepEqual(tr.update(new Set(['a'])), {});
  t = 1500; assert.deepEqual(tr.update(new Set()), {}, 'parou há 1,5 s: ainda pode voltar');
  t = 3000; assert.deepEqual(tr.update(new Set(['a'])), {}, 'voltou a trabalhar: nada registrado');
  t = 5000; assert.deepEqual(tr.update(new Set()), {});
  t = 7100; const ends = tr.update(new Set());
  assert.equal(ends.a, new Date(7100).toISOString());
  t = 20000; assert.equal(tr.update(new Set()).a, new Date(7100).toISOString(), 'não repete o registro');
});

test('finishedStamps junta o fim de trabalho observado aos demais términos', () => {
  const m = finishedStamps({ sessions: [], maestroTasks: [], workEnds: { a: '2026-01-01T10:00:00Z' } });
  assert.equal(m.get('a'), '2026-01-01T10:00:00Z');
});

test('unseenFinished: o fim de trabalho aparece até ser visto e volta a aparecer num fim posterior', () => {
  const stamps = new Map([['a', '2026-01-01T10:00:00Z']]);
  assert.deepEqual([...unseenFinished({ stamps, baseline: '2026-01-01T09:00:00Z' })], ['a']);
  assert.deepEqual([...unseenFinished({ stamps, seen: { a: '2026-01-01T10:00:00Z' }, baseline: '2026-01-01T09:00:00Z' })], []);
  assert.deepEqual([...unseenFinished({ stamps: new Map([['a', '2026-01-01T11:00:00Z']]), seen: { a: '2026-01-01T10:00:00Z' }, baseline: '' })], ['a']);
});
