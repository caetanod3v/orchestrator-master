// Sidebar simplificada (só workspaces): estado do ícone (client/src/env-view.js: wsTone) e guarda contra tópicos na sidebar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { environments, wsTone } from '../../client/src/env-view.js';

const ws = [{ id: 'w1', name: 'a', path: 'C:/a' }];
const sess = (over) => ({ id: 'term_1', workspaceId: 'w1', status: 'running', exitCode: null, ...over });
const env = (o) => environments({ workspaces: ws, ...o })[0];

test('wsTone: sem terminais ou só ociosos = idle (verde)', () => {
  assert.equal(wsTone(env({})), 'idle');
  assert.equal(wsTone(env({ sessions: [sess()] })), 'idle');
});

test('wsTone: algum terminal trabalhando = work (laranja)', () => {
  assert.equal(wsTone(env({ sessions: [sess()], workingIds: new Set(['term_1']) })), 'work');
  assert.equal(wsTone(env({ sessions: [sess({ id: 'x', workspaceId: 'outro' })], workingIds: new Set(['x']) })), 'idle', 'trabalho de outro workspace não conta');
});

test('wsTone: falha ou tarefa do maestro aguardando = attn (exclamação), e vence "trabalhando"', () => {
  assert.equal(wsTone(env({ sessions: [sess({ status: 'exited', exitCode: 2 })] })), 'attn');
  assert.equal(wsTone(env({ sessions: [sess({ id: 'a' }), sess({ id: 'b' })], maestroTasks: [{ id: 't', status: 'pending', to: 'a' }] })), 'attn');
  assert.equal(wsTone(env({ sessions: [sess({ id: 'a' }), sess({ id: 'f', status: 'exited', exitCode: 1 })], workingIds: new Set(['a']) })), 'attn');
  assert.equal(wsTone(env({ sessions: [sess({ status: 'exited', exitCode: 0 })] })), 'idle', 'terminou bem: não é atenção');
});

test('wsTone: entrada inválida nunca quebra', () => { assert.equal(wsTone(null), 'idle'); assert.equal(wsTone(undefined), 'idle'); assert.equal(wsTone({}), 'idle'); });

test('guarda: a Sidebar não usa tópicos nem expandir/recolher por workspace', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'components', 'Sidebar.jsx'), 'utf8');
  for (const proibido of ['topicRows', 'topic-state', 'TopicItem', 'TopicInput', 'activateTopic', 'createTopic', 'aria-expanded={expanded', 'tp-list']) assert.ok(!src.includes(proibido), `Sidebar não deve conter ${proibido}`);
  assert.match(src, /wsTone/);
});
