// Item B: portão de aprovação no grafo (client/src/graph.js). Funções puras, sem React nem servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalGates, buildGraph, layers } from '../../client/src/graph.js';
import { cycleApprovalPending } from '../../client/src/op-state.js';

const task = (id, status, dependsOn = []) => ({ id, title: `Tarefa ${id}`, status, dependsOn });
const approval = (id, status = 'pending') => ({ id, status, digest: `d-${id}`, action: { title: 'Alterar package.json' }, summary: { what: 'Editar arquivo sensível' } });
const blocked = (approvals, code = 'approval_required') => ({ status: 'blocked', blockedCode: code, approvals });
const mission = (tasks, cycle) => ({ id: 'mis_1', tasks, cycle });

test('sem pendência real não existe portão (nem com tarefas em outros estados)', () => {
  assert.deepEqual(approvalGates(null), []);
  assert.deepEqual(approvalGates(mission([], undefined)), []);
  for (const status of ['pending', 'ready', 'running', 'completed', 'failed', 'rejected', 'blocked']) {
    assert.deepEqual(approvalGates(mission([task('t1', status)], { status: 'running', approvals: [] })), [], status);
  }
});

test('tarefa em awaiting_approval gera um portão ligado a ela', () => {
  const g = approvalGates(mission([task('t1', 'completed'), task('t2', 'awaiting_approval', ['t1'])]));
  assert.equal(g.length, 1);
  assert.deepEqual({ kind: g[0].kind, id: g[0].id, taskId: g[0].taskId, after: g[0].after }, { kind: 'task', id: 'gate:t2', taskId: 't2', after: 't2' });
});

test('ação do ciclo pendente gera um portão com a aprovação real; só enquanto o ciclo está bloqueado em approval_required', () => {
  const a = approval('apr_1');
  const m = mission([task('t1', 'completed')], blocked([a]));
  assert.equal(cycleApprovalPending(m), true);
  const g = approvalGates(m);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'cycle');
  assert.equal(g[0].id, 'gate:apr_1');
  assert.equal(g[0].approval, a, 'a aprovação é a do servidor, sem cópia nem reinterpretação');
  assert.equal(g[0].after, 't1', 'fica depois da última tarefa');
});

test('ciclo sem tarefas: o portão se liga à Intenção (after = null)', () => {
  const g = approvalGates(mission([], blocked([approval('apr_1')])));
  assert.equal(g.length, 1);
  assert.equal(g[0].after, null);
  const { nodes } = buildGraph([], g);
  assert.deepEqual(nodes[0].deps, []);
});

test('aprovações já decididas, ou ciclo bloqueado por outro motivo, não geram portão', () => {
  assert.deepEqual(approvalGates(mission([], blocked([approval('a1', 'approved'), approval('a2', 'rejected')]))), []);
  assert.deepEqual(approvalGates(mission([], blocked([approval('a1')], 'limit_reached'))), []);
  assert.deepEqual(approvalGates(mission([], { status: 'running', blockedCode: 'approval_required', approvals: [approval('a1')] })), []);
});

test('uma aprovação pendente por vez: só as pendentes viram portão', () => {
  const g = approvalGates(mission([], blocked([approval('a1', 'approved'), approval('a2')])));
  assert.deepEqual(g.map((x) => x.id), ['gate:a2']);
});

test('o portão de tarefa fica ENTRE a tarefa e quem depende dela', () => {
  const tasks = [task('t1', 'awaiting_approval'), task('t2', 'pending', ['t1'])];
  const { nodes, rows } = buildGraph(tasks, approvalGates(mission(tasks)));
  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  assert.deepEqual(by.t1.deps, []);
  assert.deepEqual(by['gate:t1'].deps, ['t1']);
  assert.deepEqual(by.t2.deps, ['gate:t1'], 'o dependente espera a aprovação, não a tarefa direto');
  assert.deepEqual(rows.map((r) => r.map((n) => n.id)), [['t1'], ['gate:t1'], ['t2']]);
});

test('sem portões o grafo é o mesmo de antes (camadas por dependência)', () => {
  const tasks = [task('a', 'completed'), task('b', 'completed', ['a']), task('c', 'ready', ['a']), task('d', 'pending', ['b', 'c'])];
  const { nodes, rows } = buildGraph(tasks);
  assert.ok(nodes.every((n) => n.kind === 'task'));
  assert.deepEqual(rows.map((r) => r.map((n) => n.id)), [['a'], ['b', 'c'], ['d']]);
  assert.deepEqual(layers(nodes).map((r) => r.length), [1, 2, 1]);
});

test('buildGraph não altera as tarefas nem as dependências recebidas', () => {
  const tasks = [task('t1', 'awaiting_approval'), task('t2', 'pending', ['t1'])];
  const before = JSON.stringify(tasks);
  const gates = approvalGates(mission(tasks));
  const gBefore = JSON.stringify(gates);
  buildGraph(tasks, gates);
  assert.equal(JSON.stringify(tasks), before);
  assert.equal(JSON.stringify(gates), gBefore);
});

test('dependência inexistente ou ciclo inesperado não quebram o grafo', () => {
  const { rows } = buildGraph([task('a', 'pending', ['x']), task('b', 'pending', ['c']), task('c', 'pending', ['b'])]);
  assert.equal(rows.flat().length, 3);
});
