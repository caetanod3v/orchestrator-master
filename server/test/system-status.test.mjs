// Status global (client/src/system-status.js): as contagens do componente único vêm das MESMAS regras dos indicadores de terminal/aba/sidebar. PURO.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { systemStatus, statusLine } from '../../client/src/system-status.js';
import { totals, tally } from '../../client/src/workspace-nav.js';
import { environments, wsTone } from '../../client/src/env-view.js';

const run = (id, ws, state, over = {}) => ({ id, workspaceId: ws, title: `T-${id}`, status: 'running', exitCode: null, agent: state ? { state, at: '2026-01-01T10:00:00Z' } : null, ...over });
const W = [{ id: 'a', name: 'loja', path: '/a' }, { id: 'b', name: 'api', path: '/b' }];
const S = [run('t1', 'a', 'running'), run('t2', 'a', 'running'), run('t3', 'b', 'waiting'), run('t4', 'b', 'completed'), run('t5', 'a', 'error'), { id: 't6', workspaceId: 'a', title: 'T-6', status: 'exited', exitCode: 0 }, { id: 't7', workspaceId: 'b', title: 'T-7', status: 'exited', exitCode: 2 }];

test('contagens: ativos (processo vivo), executando, aguardando e falhas — encerrado com sucesso não conta; encerrado com erro conta como falha', () => {
  const s = systemStatus({ sessions: S, workspaces: W, max: 10 });
  assert.deepEqual([s.ativos, s.executando, s.aguardando, s.falhas], [5, 2, 1, 2]);
  assert.equal(statusLine(s), '5 ativos · 2 executando · 1 aguardando · 2 falhas');
});

test('consistência: os números são os mesmos do tally/totals e dos indicadores de workspace (nenhuma contagem separada)', () => {
  const s = systemStatus({ sessions: S, workspaces: W, max: 10 }), c = tally(S, new Set(), []), t = totals({ sessions: S, maestroTasks: [] });
  assert.deepEqual([s.ativos, s.executando, s.aguardando, s.falhas], [c.running, c.working, c.waiting, c.failed]);
  assert.deepEqual([s.ativos, s.aguardando, s.falhas], [t.running, t.waiting, t.failed]);
  const envs = environments({ workspaces: W, sessions: S });
  assert.equal(envs.reduce((n, e) => n + e.working, 0), s.executando); assert.equal(envs.reduce((n, e) => n + e.waiting, 0), s.aguardando);
  assert.equal(wsTone(envs[0]), 'err');
});

test('estado geral: falha > aguardando > executando > concluído > ocioso; sem terminais é ocioso', () => {
  assert.equal(systemStatus({ sessions: S, workspaces: W }).tone, 'err');
  assert.equal(systemStatus({ sessions: [run('a1', 'a', 'waiting'), run('a2', 'a', 'running')], workspaces: W }).tone, 'warn');
  assert.equal(systemStatus({ sessions: [run('a1', 'a', 'running')], workspaces: W }).tone, 'work');
  assert.equal(systemStatus({ sessions: [run('a1', 'a', 'completed')], workspaces: W }).tone, 'done');
  assert.equal(systemStatus({ sessions: [run('a1', 'a', 'idle')], workspaces: W }).tone, 'idle');
  const none = systemStatus({ sessions: [], workspaces: W }); assert.equal(none.tone, 'idle'); assert.deepEqual([none.ativos, none.executando, none.aguardando, none.falhas], [0, 0, 0, 0]);
});

test('painel: quem executa, aguarda ou falhou, com o workspace; vagas livres e ocupadas; tarefa do maestro pendente conta como aguardando', () => {
  const s = systemStatus({ sessions: S, workspaces: W, max: 10, tasks: [{ status: 'pending', to: 't4' }] });
  assert.deepEqual(s.groups.working.map((x) => [x.title, x.workspace]), [['T-t1', 'loja'], ['T-t2', 'loja']]);
  assert.deepEqual(s.groups.waiting.map((x) => x.id).sort(), ['t3', 't4']); assert.equal(s.aguardando, 2);
  assert.deepEqual(s.groups.failed.map((x) => x.id).sort(), ['t5', 't7']);
  assert.deepEqual([s.max, s.livres], [10, 5]);
  assert.equal(systemStatus({ sessions: S, workspaces: W }).livres, null, 'sem o limite do servidor não se inventa vaga');
});

test('listas do painel são limitadas e informam quantos ficaram de fora; agentes sem hooks usam a leitura pela saída', () => {
  const many = Array.from({ length: 12 }, (_, i) => run(`m${i}`, 'a', 'running'));
  const s = systemStatus({ sessions: many, workspaces: W });
  assert.equal(s.executando, 12); assert.equal(s.groups.working.length, 8); assert.equal(s.more.working, 4);
  assert.equal(systemStatus({ sessions: [run('x', 'a', null)], workingIds: new Set(['x']), workspaces: W }).executando, 1);
  assert.equal(systemStatus({ sessions: [run('x', 'a', null)], workspaces: W }).executando, 0);
});

test('a interface tem UM componente de status: as caixas antigas saíram da barra superior, da barra de terminais e da sidebar', () => {
  const src = (f) => fs.readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');
  assert.match(src('components/Topbar.jsx'), /<SystemStatus \/>/); assert.doesNotMatch(src('components/Topbar.jsx'), /tb-counts|AgentsPopover|agentes? ativos?/);
  assert.doesNotMatch(src('components/TerminalGrid.jsx'), /AgentsPopover/); assert.doesNotMatch(src('components/Sidebar.jsx'), /AgentsPopover|oc-sum/);
});

test('barra superior sem o bloco "nome do workspace + estado": o nome já está na sidebar, na aba e na barra de terminais', () => {
  const t = fs.readFileSync(new URL('../../client/src/components/Topbar.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(t, /tb-now|tb-ws|tb-run|environments\(/);
  assert.match(t, /<SystemStatus \/>/, 'o status global continua; o estado do workspace segue na sidebar, na aba e na barra de terminais');
});
