import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFor, focusPlacement, layoutModeId, gridShape } from '../../client/src/env-view.js';
import { maestroSummary, timelineRows, collapsedLine } from '../../client/src/maestro-view.js';

test('shapeFor: auto segue gridShape; cols e rows dividem numa só direção; 1 terminal é tela cheia em qualquer modo', () => {
  assert.deepEqual(shapeFor('auto', 4), gridShape(4));
  assert.deepEqual(shapeFor('cols', 3), { cols: 3, rows: 1, spanLast: false });
  assert.deepEqual(shapeFor('rows', 3), { cols: 1, rows: 3, spanLast: false });
  for (const m of ['auto', 'cols', 'rows', 'focus']) assert.deepEqual(shapeFor(m, 1), { cols: 1, rows: 1, spanLast: false });
  assert.deepEqual(shapeFor('cols', 40), { cols: 12, rows: 1, spanLast: false });
});

test('layoutModeId: valor desconhecido volta para auto', () => {
  assert.equal(layoutModeId('focus'), 'focus'); assert.equal(layoutModeId('xx'), 'auto'); assert.equal(layoutModeId(undefined), 'auto');
});

test('focusPlacement: o foco ocupa a coluna 1 inteira e os outros empilham na coluna 2', () => {
  assert.equal(focusPlacement(1, 0), null);
  const p = focusPlacement(3, 1);
  assert.equal(p.rows, 2);
  assert.deepEqual(p.cells, [{ col: 2, row: 1 }, { col: 1, row: '1 / span 2' }, { col: 2, row: 2 }]);
  assert.deepEqual(focusPlacement(3, 9).cells[0], { col: 1, row: '1 / span 2' }); // índice inválido cai no primeiro
});

test('maestroSummary e collapsedLine: pendente e falha chamam atenção; rotina não', () => {
  const tasks = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'done' }, { id: 'c', status: 'failed' }, { id: 'd', status: 'delivered' }];
  const s = maestroSummary(tasks);
  assert.deepEqual([s.pending, s.failed, s.done, s.delivered, s.attention], [1, 1, 1, 1, true]);
  assert.equal(maestroSummary([{ status: 'done' }]).attention, false);
  assert.equal(collapsedLine(tasks), '1 aguardando você · 1 falha');
  assert.equal(collapsedLine([{ status: 'done' }, { status: 'delivered' }]), '1 concluída de 2');
  assert.equal(collapsedLine([], false), 'nenhuma tarefa');
});

test('timelineRows: sem pendentes, mais recente primeiro, com limite; prefere o resumo ao texto', () => {
  const tasks = [
    { id: 'p', status: 'pending', createdAt: '2026-01-01T10:00:00Z' },
    { id: 'o', status: 'done', toTitle: 'A', text: 'x', summary: 'feito', doneAt: '2026-01-01T09:00:00Z' },
    { id: 'n', status: 'delivered', toTitle: 'B', text: 'y', createdAt: '2026-01-01T11:00:00Z' },
  ];
  const rows = timelineRows(tasks);
  assert.deepEqual(rows.map((r) => r.id), ['n', 'o']);
  assert.equal(rows[1].text, 'feito');
  assert.equal(timelineRows(tasks, 1).length, 1);
});
