// "!" da sidebar: aparece quando a equipe TERMINOU tudo e o usuário ainda não viu (ou quando algo falhou); some ao entrar no workspace. Regra pura (client/src/env-view.js: wsAlert) + guardas do cliente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wsAlert, wsTone, environments } from '../../client/src/env-view.js';
import { unseenFinished, createWorkEndTracker } from '../../client/src/workspace-nav.js';

const src = (f) => fs.readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');

test('wsAlert: término não visto só alerta com a equipe PARADA (concluído/ocioso); trabalhando, aguardando ou já visto não alertam; falha alerta sempre', () => {
  assert.equal(wsAlert('done', true), true); assert.equal(wsAlert('idle', true), true, 'sem hooks o estado é ocioso: também vale');
  assert.equal(wsAlert('done', false), false, 'já visto (ou nunca terminou nada): sem "!"');
  assert.equal(wsAlert('work', true), false, 'ainda há agente trabalhando'); assert.equal(wsAlert('wait', true), false, 'esperando você: é âmbar, não "terminou"');
  assert.equal(wsAlert('err', false), true, 'falha continua alertando'); assert.equal(wsAlert('err', true), true);
  assert.equal(wsAlert('done', undefined), false); assert.equal(wsAlert('done', 'sim'), false, 'só true estrito');
});

test('ciclo completo: trabalhando -> termina (equipe parada por 4 s) -> "!" -> ao entrar no workspace o "!" some -> novo término volta a avisar', () => {
  let t = 0; const tr = createWorkEndTracker({ now: () => t, settleMs: 4000 }), W = [{ id: 'b', name: 'b', path: '/b' }];
  const sess = (agent) => [{ id: 't1', workspaceId: 'b', status: 'running', agent: { state: agent, at: 'x' } }];
  const tone = (agent, unseen) => { const e = environments({ workspaces: W, sessions: sess(agent), finished: unseen })[0]; return [wsTone(e), wsAlert(wsTone(e), e.finished)]; };
  tr.update(new Set(['b'])); assert.deepEqual(tone('running', new Set()), ['work', false]);
  t = 1500; let ends = tr.update(new Set()); assert.deepEqual(ends, {}, 'parou há 1,5 s: ainda pode voltar a trabalhar');
  t = 5000; ends = tr.update(new Set()); const stamp = ends.b; assert.ok(stamp, 'equipe parada por mais de 4 s: terminou');
  const stamps = new Map([['b', stamp]]);
  assert.deepEqual(tone('completed', unseenFinished({ stamps, seen: {}, baseline: '1970-01-01T00:00:00Z' })), ['done', true], 'terminou e ninguém viu: "!"');
  assert.deepEqual(tone('completed', unseenFinished({ stamps, seen: { b: stamp }, baseline: '1970-01-01T00:00:00Z' })), ['done', false], 'entrou no workspace: "!" some');
  t = 20000; tr.update(new Set(['b'])); t = 30000; tr.update(new Set()); t = 35000; const again = tr.update(new Set()).b;
  assert.ok(again > stamp, 'novo ciclo de trabalho gera novo término');
  assert.deepEqual(tone('completed', unseenFinished({ stamps: new Map([['b', again]]), seen: { b: stamp }, baseline: '' })), ['done', true], 'novo término depois de ter visto o anterior: "!" volta');
});

test('cliente: a sidebar usa wsAlert, o fim do trabalho vem do estado real dos agentes e terminal encerrado não conta como "a equipe terminou"', () => {
  const sb = src('components/Sidebar.jsx'), st = src('store.jsx');
  assert.match(sb, /wsAlert\(tone, env\.finished\)/); assert.doesNotMatch(sb, /hasAlert/);
  assert.match(st, /paneState\(x, act\) === 'working'/, 'o mesmo critério dos indicadores (hooks), não só a saída');
  assert.match(st, /filter\(\(x\) => x\.status === 'running'\)/);
  assert.match(st, /useEffect\(\(\) => \{ markSeen\(activeWsId\); \}, \[activeWsId, markSeen\]\)/, 'ativar o workspace marca o término como visto');
  assert.match(st, /markSeen\(wsOfRef\.current\.get\(id\)\)/, 'interagir com o squad também');
});
