// Neural Core: modelo de movimento (client/src/core-model.js) e escolha de modo (coreMode em client/src/op-state.js). Funções puras, sem canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, createCore, setMode, stepCore, isSettled, frameInterval, snapCore, errTint, FLASH_TINT } from '../../client/src/core-model.js';
import { coreMode } from '../../client/src/op-state.js';

const run = (s, seconds, fps = 60) => { for (let i = 0; i < seconds * fps; i++) stepCore(s, 1 / fps); return s; };

test('o modo vem do estado real, com prioridade: executando > planner > erro > espera > ocioso', () => {
  assert.equal(coreMode({}), 'idle');
  assert.equal(coreMode({ executorBusy: true }), 'executing');
  assert.equal(coreMode({ runningTasks: 2 }), 'executing');
  assert.equal(coreMode({ plannerBusy: true }), 'planning');
  assert.equal(coreMode({ plannerBusy: true, executorBusy: true }), 'executing');
  assert.equal(coreMode({ pending: 1 }), 'awaiting');
  assert.equal(coreMode({ failed: true, pending: 1 }), 'error', 'a falha da última execução vence a espera');
  assert.equal(coreMode({ executorBusy: true, failed: true, pending: 3 }), 'executing', 'uma nova execução em curso vence tudo');
  assert.equal(coreMode(), 'idle');
});

test('ociosos têm movimento mínimo; planner < executor; a espera desacelera', () => {
  assert.ok(MODES.idle.rot < MODES.planning.rot && MODES.planning.rot < MODES.executing.rot);
  assert.ok(MODES.idle.wave < MODES.planning.wave && MODES.planning.wave < MODES.executing.wave);
  assert.ok(MODES.idle.amp < MODES.planning.amp && MODES.planning.amp < MODES.executing.amp);
  assert.ok(MODES.idle.rot < 0.02, 'repouso: rotação residual muito discreta');
  assert.ok(MODES.awaiting.rot < MODES.planning.rot, 'aguardando aprovação é mais lento que o trabalho');
  assert.ok(MODES.awaiting.warm > 0 && MODES.awaiting.warm <= 0.4, 'tom âmbar discreto');
  assert.equal(MODES.idle.warm, 0); assert.equal(MODES.idle.err, 0);
});

test('transições são graduais: sem salto no quadro seguinte e convergem ao alvo', () => {
  const s = createCore('idle');
  setMode(s, 'executing');
  stepCore(s, 1 / 60);
  assert.ok(s.rot > MODES.idle.rot && s.rot < MODES.executing.rot * 0.1, 'um quadro depois ainda está perto do repouso');
  run(s, 5);
  assert.ok(Math.abs(s.rot - MODES.executing.rot) < 0.01 && isSettled(s));
});

test('conclusão: desacelera suavemente até o repouso (sem parar de repente)', () => {
  const s = run(setMode(createCore('executing'), 'executing'), 3);
  setMode(s, 'idle');
  const a = s.rot; stepCore(s, 1 / 60);
  assert.ok(s.rot < a && s.rot > MODES.idle.rot, 'desacelera, não corta');
  run(s, 6);
  assert.ok(s.rot - MODES.idle.rot < 0.005 && s.amp - MODES.idle.amp < 0.005, 'em poucos segundos chega ao repouso');
  assert.ok(isSettled(s));
});

test('erro: clarão breve ao ENTRAR no estado, que decai; permanecer em erro não repete', () => {
  const s = createCore('idle');
  setMode(s, 'error');
  assert.equal(s.flash, 1);
  assert.ok(errTint(s) >= FLASH_TINT && errTint(s) <= 1);
  run(s, 4);
  assert.ok(s.flash < 0.05, 'o clarão some em poucos segundos');
  assert.ok(errTint(s) > 0 && errTint(s) < 0.25, 'sobra só um resíduo contido');
  setMode(s, 'error'); assert.ok(s.flash < 0.05, 'repetir o mesmo modo não dispara outro clarão');
  setMode(s, 'idle'); run(s, 6);
  assert.ok(errTint(s) < 0.01, 'ao sair do erro o tom volta ao neutro');
  setMode(s, 'nao-existe'); assert.equal(s.mode, 'idle', 'modo inválido é ignorado');
});

test('aguardando aprovação: tom âmbar discreto e movimento reduzido', () => {
  const s = run(setMode(createCore('executing'), 'executing'), 3);
  setMode(s, 'awaiting'); run(s, 6);
  assert.ok(Math.abs(s.warm - MODES.awaiting.warm) < 0.01);
  assert.ok(s.rot < 0.04);
});

test('trabalho por quadro: página oculta e movimento reduzido não rodam em loop; repouso assentado usa poucos quadros', () => {
  assert.equal(frameInterval({ hidden: true, mode: 'executing' }), null, 'oculta: nenhum loop');
  assert.equal(frameInterval({ reduced: true, mode: 'executing' }), null, 'movimento reduzido: estático');
  assert.ok(frameInterval({ settled: true, mode: 'idle' }) >= 66, 'repouso: no máximo ~15 quadros/s');
  assert.ok(frameInterval({ settled: false, mode: 'idle' }) <= 34, 'em transição: fluido');
  assert.ok(frameInterval({ settled: true, mode: 'executing' }) <= 34, 'atividade: nunca reduz a taxa');
  assert.ok(frameInterval({ settled: true, mode: 'planning' }) <= 34);
});

test('movimento reduzido: salta ao estado estático correto, sem transição contínua', () => {
  const s = setMode(createCore('idle'), 'awaiting');
  snapCore(s);
  assert.equal(s.warm, MODES.awaiting.warm); assert.equal(s.flash, 0); assert.ok(isSettled(s));
  setMode(s, 'error'); snapCore(s);
  assert.equal(s.flash, 0, 'sem clarão quando o movimento é reduzido');
  assert.equal(s.err, MODES.error.err);
});

test('o passo não aloca: o mesmo objeto de estado é reutilizado', () => {
  const s = createCore('idle'); const keys = Object.keys(s).join();
  const r = stepCore(s, 0.016);
  assert.equal(r, s); assert.equal(Object.keys(s).join(), keys);
});
