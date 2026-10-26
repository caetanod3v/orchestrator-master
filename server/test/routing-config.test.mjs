// Incremento A do roteamento do Planner: leitura e validação da configuração. Puro (sem processos, sem banco, sem modelo).
import test from 'node:test';
import assert from 'node:assert/strict';

const { routingFromEnv, tierSettings, createRouter, TIERS, TIER_NAMES } = await import('../routing.js');
const { plannerArgs, PLANNER_ARGS, createClaudePlanner } = await import('../planner.js');

test('ORCH_PLANNER_ROUTING: ausente, vazio e off = desligado (padrão); on = ligado', () => {
  for (const v of [undefined, '', '  ', 'off', 'OFF', ' Off ']) assert.equal(routingFromEnv(v === undefined ? {} : { ORCH_PLANNER_ROUTING: v }), 'off', JSON.stringify(v));
  for (const v of ['on', 'ON', ' On ']) assert.equal(routingFromEnv({ ORCH_PLANNER_ROUTING: v }), 'on', JSON.stringify(v));
});

test('valores inválidos de ORCH_PLANNER_ROUTING lançam erro (o servidor não sobe em vez de ignorar)', () => {
  for (const v of ['1', 'true', 'yes', 'maybe', 'auto', 'onn', 'on;off']) assert.throws(() => routingFromEnv({ ORCH_PLANNER_ROUTING: v }), /ORCH_PLANNER_ROUTING/, v);
});

test('camadas: lite = claude-haiku-5-5 com esforço low; standard = a configuração existente do ambiente', () => {
  assert.deepEqual(tierSettings('lite'), { model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(tierSettings('standard', { model: 'claude-sonnet-5-5', effort: 'medium' }), { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(tierSettings('standard', {}), { model: undefined, effort: undefined });
  assert.deepEqual(tierSettings('standard'), { model: undefined, effort: undefined });
  assert.deepEqual([...TIER_NAMES], ['lite', 'standard']);
  for (const bad of ['deep', '', 'LITE', 'constructor', '__proto__', 'toString', undefined, null, 7]) assert.equal(tierSettings(bad, {}), null, String(bad));
});

test('as definições das camadas são imutáveis e geram argumentos válidos da CLI', () => {
  assert.throws(() => { 'use strict'; TIERS.lite.model = 'outro'; }, TypeError);
  assert.throws(() => { 'use strict'; TIERS.deep = { model: 'x' }; }, TypeError);
  assert.doesNotThrow(() => plannerArgs(tierSettings('lite')));
  assert.deepEqual(plannerArgs(tierSettings('standard', {})), PLANNER_ARGS, 'standard sem configuração = argumentos de sempre');
});

test('o roteador do incremento A só devolve a camada padrão, com motivo e sinais (nenhuma seleção dinâmica)', () => {
  const r = createRouter();
  for (const ctx of [undefined, {}, { mission: { objective: 'x'.repeat(5000) }, cycle: { consecutiveNoProgress: 5, rejections: [1, 2, 3] } }]) {
    const p = r.pick(ctx);
    assert.equal(p.tier, 'standard'); assert.match(p.reason, /incremento A/); assert.deepEqual(p.signals, {});
  }
});

test('createClaudePlanner valida modelo/esforço mesmo com o roteamento ligado ou desligado', () => {
  for (const routing of ['off', 'on']) {
    assert.throws(() => createClaudePlanner({ routing, effort: 'ultra' }), /ORCH_PLANNER_EFFORT/);
    assert.throws(() => createClaudePlanner({ routing, model: '--dangerously-skip-permissions' }), /ORCH_PLANNER_MODEL/);
    assert.doesNotThrow(() => createClaudePlanner({ routing, model: 'claude-sonnet-5-5', effort: 'medium' }));
  }
});
