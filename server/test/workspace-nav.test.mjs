// Navegação por abas de workspace e tópicos (client/src/workspace-nav.js): lógica pura, sem rede nem processos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTabs, closePlan, neighborAfterClose, tabKeyTarget, topicsOf, activeTopicId, visibleSessions, topicRows, totals, cleanTitle, breadcrumb, tally, toneOf, MAX_TOPIC_TITLE } from '../../client/src/workspace-nav.js';

const ws = (id, name) => ({ id, name, path: `C:\\x\\${name}` });
const sess = (id, workspaceId, over = {}) => ({ id, workspaceId, status: 'running', exitCode: null, topicId: null, ...over });
const W = [ws('a', 'loja'), ws('b', 'api'), ws('c', 'docs')];
const T = [{ id: 't1', workspaceId: 'a', title: 'Checkout' }, { id: 't2', workspaceId: 'a', title: 'Login' }, { id: 't3', workspaceId: 'b', title: 'Infra' }];

test('openTabs: só os abertos, na ordem do servidor; o ativo sempre aparece; ids desconhecidos somem', () => {
  const tabs = openTabs({ workspaces: W, openWorkspaceIds: ['b', 'zzz', 'a'], activeId: 'a' });
  assert.deepEqual(tabs.map((t) => [t.id, t.active]), [['b', false], ['a', true]]);
  assert.deepEqual(openTabs({ workspaces: W, openWorkspaceIds: ['b'], activeId: 'c' }).map((t) => t.id), ['b', 'c']);
  assert.deepEqual(openTabs({ workspaces: W, openWorkspaceIds: undefined, activeId: null }), []);
  assert.deepEqual(openTabs({ workspaces: W, openWorkspaceIds: ['a', 'a'], activeId: 'a' }).map((t) => t.id), ['a']);
});

test('openTabs: indicadores vêm das sessões reais de cada workspace', () => {
  const sessions = [sess('p1', 'a'), sess('p2', 'a'), sess('p3', 'a', { status: 'exited', exitCode: 1 }), sess('p4', 'b', { status: 'exited', exitCode: 0 })];
  const tasks = [{ id: 'k1', status: 'pending', to: 'p2' }, { id: 'k2', status: 'done', to: 'p1' }];
  const [a, b] = openTabs({ workspaces: W, openWorkspaceIds: ['a', 'b'], activeId: 'a', sessions, workingIds: new Set(['p1']), maestroTasks: tasks });
  assert.deepEqual([a.running, a.working, a.failed, a.pending, a.attention, a.tone], [2, 1, 1, 1, true, 'err']);
  assert.deepEqual([b.running, b.failed, b.exited, b.attention, b.tone], [0, 0, 1, false, 'none']);
});

test('toneOf: prioridade falha > aguardando > trabalhando > rodando', () => {
  assert.equal(toneOf({ failed: 1, pending: 1, working: 1, running: 1 }), 'err');
  assert.equal(toneOf({ failed: 0, pending: 1, working: 1, running: 1 }), 'warn');
  assert.equal(toneOf({ failed: 0, pending: 0, working: 1, running: 1 }), 'work');
  assert.equal(toneOf({ failed: 0, pending: 0, working: 0, running: 1 }), 'live');
  assert.equal(toneOf({ failed: 0, pending: 0, working: 0, running: 0 }), 'none');
});

test('closePlan: confirma só quando há agentes rodando, e diz que continuam em execução', () => {
  assert.equal(closePlan({ name: 'x', running: 0 }).confirm, false);
  assert.equal(closePlan(null).confirm, false);
  const one = closePlan({ name: 'loja', running: 1 }), many = closePlan({ name: 'loja', running: 3 });
  assert.equal(one.confirm, true);
  assert.match(one.message, /1 agente continua em execução/);
  assert.match(many.message, /3 agentes continuam em execução/);
  assert.match(many.message, /não são encerrados/);
});

test('neighborAfterClose: vizinho da direita, senão da esquerda, senão nenhum', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(neighborAfterClose(tabs, 'a'), 'b');
  assert.equal(neighborAfterClose(tabs, 'b'), 'c');
  assert.equal(neighborAfterClose(tabs, 'c'), 'b');
  assert.equal(neighborAfterClose([{ id: 'a' }], 'a'), null);
  assert.equal(neighborAfterClose(tabs, 'nope'), null);
});

test('tabKeyTarget: setas circulares, Home/End; outras teclas não navegam', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(tabKeyTarget(ids, 'a', 'ArrowRight'), 'b');
  assert.equal(tabKeyTarget(ids, 'c', 'ArrowRight'), 'a');
  assert.equal(tabKeyTarget(ids, 'a', 'ArrowLeft'), 'c');
  assert.equal(tabKeyTarget(ids, 'b', 'Home'), 'a');
  assert.equal(tabKeyTarget(ids, 'b', 'End'), 'c');
  assert.equal(tabKeyTarget(ids, 'b', 'Enter'), null);
  assert.equal(tabKeyTarget([], 'a', 'ArrowRight'), null);
});

test('topicsOf / activeTopicId: só os do workspace; id desconhecido cai em Geral (null)', () => {
  assert.deepEqual(topicsOf(T, 'a').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(topicsOf(T.concat({ id: 't9', workspaceId: 'a', title: 'x', archived: true }), 'a').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(topicsOf(undefined, 'a'), []);
  assert.equal(activeTopicId({ a: 't2' }, 'a', T), 't2');
  assert.equal(activeTopicId({ a: 't3' }, 'a', T), null); // tópico de outro workspace
  assert.equal(activeTopicId({ a: 'sumiu' }, 'a', T), null);
  assert.equal(activeTopicId(undefined, 'a', T), null);
});

test('visibleSessions: filtra por workspace + tópico; Geral = sem tópico ou tópico arquivado', () => {
  const sessions = [sess('p1', 'a'), sess('p2', 'a', { topicId: 't1' }), sess('p3', 'a', { topicId: 't2' }), sess('p4', 'b'), sess('p5', 'a', { topicId: 'arquivado' })];
  assert.deepEqual(visibleSessions(sessions, 'a', null, T).map((s) => s.id), ['p1', 'p5']);
  assert.deepEqual(visibleSessions(sessions, 'a', 't1', T).map((s) => s.id), ['p2']);
  assert.deepEqual(visibleSessions(sessions, 'b', null, T).map((s) => s.id), ['p4']);
  assert.deepEqual(visibleSessions(sessions, 'a', 't3', T).map((s) => s.id), []);
});

test('topicRows: Geral primeiro, ativo marcado, indicadores por tópico', () => {
  const sessions = [sess('p1', 'a'), sess('p2', 'a', { topicId: 't1' }), sess('p3', 'a', { topicId: 't1', status: 'exited', exitCode: 2 }), sess('p4', 'b', { topicId: 't3' })];
  const rows = topicRows({ topics: T, workspaceId: 'a', activeTopicIds: { a: 't1' }, sessions, workingIds: new Set(['p2']) });
  assert.deepEqual(rows.map((r) => [r.key, r.title, r.active]), [['general', 'Geral', false], ['t1', 'Checkout', true], ['t2', 'Login', false]]);
  assert.deepEqual([rows[0].running, rows[0].tone], [1, 'live']);
  assert.deepEqual([rows[1].running, rows[1].working, rows[1].failed, rows[1].tone], [1, 1, 1, 'err']);
  assert.equal(rows[2].tone, 'none');
  assert.equal(topicRows({ topics: T, workspaceId: 'a', activeTopicIds: {} }).find((r) => r.active).general, true);
  assert.deepEqual(topicRows({ topics: T, workspaceId: null }), []);
});

test('totals: rodando, aguardando e falha vêm das sessões e das tarefas pendentes reais', () => {
  const sessions = [sess('p1', 'a'), sess('p2', 'b'), sess('p3', 'b', { status: 'exited', exitCode: 1 }), sess('p4', 'b', { status: 'exited', exitCode: 0 })];
  assert.deepEqual(totals({ sessions, maestroTasks: [{ status: 'pending', to: 'p2' }, { status: 'pending', to: 'fantasma' }, { status: 'done', to: 'p1' }] }), { running: 2, waiting: 1, failed: 1 });
  assert.deepEqual(totals(), { running: 0, waiting: 0, failed: 0 });
});

test('tally: encerrado nunca conta como rodando; saída 0 não é falha', () => {
  const c = tally([sess('p1', 'a', { status: 'exited', exitCode: 0 }), sess('p2', 'a', { status: 'exited', exitCode: null })]);
  assert.deepEqual([c.running, c.failed, c.exited, c.attention], [0, 0, 2, false]);
});

test('cleanTitle e breadcrumb', () => {
  assert.equal(cleanTitle('  Meu   tópico \n novo '), 'Meu tópico novo');
  assert.equal(cleanTitle('   '), '');
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle('x'.repeat(200)).length, MAX_TOPIC_TITLE);
  assert.equal(breadcrumb('loja', 'Checkout'), 'loja › Checkout');
  assert.equal(breadcrumb('loja', ''), 'loja › Geral');
  assert.equal(breadcrumb('', 'Geral'), 'Geral');
});
