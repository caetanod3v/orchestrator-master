// "Trabalhando" dos terminais (client/src/activity.js): clique, foco e redimensionamento de um pane OCIOSO não podem marcá-lo como trabalhando. Lógica pura, relógio injetado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker, QUIET_MS, MIN_STREAK } from '../../client/src/activity.js';

const POLL = 1500; // o store consulta /api/terminals a cada 1,5 s
const run = (id, bytes, status = 'running') => ({ id, status, bytes });
function world() {
  let t = 1_000_000; const clock = { now: () => t, tick: (ms = POLL) => { t += ms; } };
  const tr = createActivityTracker({ now: clock.now });
  const bytes = { a: 5000 }; // um pane ocioso; `out(n)` simula saída do PTY
  return { tr, clock, bytes, out: (n, id = 'a') => { bytes[id] += n; }, poll: (...extra) => { const w = tr.update([run('a', bytes.a), ...extra]); clock.tick(); return w; } };
}

// regra ANTIGA do store, só para provar a reprodução: "a saída cresceu desde a consulta anterior"
const oldRule = (prev, cur) => cur > prev;

test('reprodução: com a regra antiga, um clique que faz o Claude Code redesenhar a tela marcava o pane ocioso como trabalhando', () => {
  const prev = 5000, afterClick = prev + 1800; // ESC[I / relatório de mouse escrito no PTY => redesenho de ~1,8 KB
  assert.equal(oldRule(prev, afterClick), true, 'a regra antiga dava falso positivo');
  const w = world(); w.poll(); w.poll();
  w.tr.noteInteraction('a'); w.out(1800);
  assert.equal(w.poll().has('a'), false, 'a regra nova não marca');
});

test('pane ocioso: saída constante nunca é trabalho', () => {
  const w = world();
  for (let i = 0; i < 6; i++) assert.equal(w.poll().has('a'), false);
});

test('clique, foco, blur, tecla e mouse (interação) seguidos de redesenho, mesmo em várias consultas, não marcam trabalhando', () => {
  const w = world(); w.poll(); w.poll();
  w.tr.noteInteraction('a'); w.out(900);
  assert.equal(w.poll().has('a'), false, 'rajada logo após o clique');
  w.out(700); // o redesenho ainda continua na consulta seguinte (dentro do silêncio de 3 s)
  assert.equal(w.poll().has('a'), false, 'segunda consulta com saída, ainda dentro do silêncio');
  assert.equal(w.poll().has('a'), false, 'depois nada mais acontece');
  // vários cliques seguidos (ex.: relatório de movimento do mouse) prolongam o silêncio
  for (let i = 0; i < 4; i++) { w.tr.noteInteraction('a'); w.out(300); assert.equal(w.poll().has('a'), false, `clique ${i + 1}`); }
});

test('uma rajada isolada FORA do silêncio (um redesenho sem causa visível) também não basta: é preciso saída sustentada', () => {
  const w = world(); w.poll(); w.poll();
  w.out(2500); assert.equal(w.poll().has('a'), false, 'uma consulta com crescimento');
  assert.equal(w.poll().has('a'), false, 'e a seguinte já sem crescimento');
});

test('trabalho real (saída contínua em consultas seguidas) é detectado e termina quando a saída para', () => {
  const w = world(); w.poll(); w.poll();
  w.out(400); assert.equal(w.poll().has('a'), false, `a 1ª consulta com crescimento ainda não basta (MIN_STREAK=${MIN_STREAK})`);
  w.out(400); assert.equal(w.poll().has('a'), true, 'a 2ª seguida confirma');
  w.out(400); assert.equal(w.poll().has('a'), true, 'continua enquanto houver saída');
  assert.equal(w.poll().has('a'), false, 'sem crescimento volta a ocioso');
});

test('interação durante o trabalho real: a classificação se recupera quando o silêncio acaba e a saída continua', () => {
  const w = world(); w.poll(); w.poll();
  w.out(400); w.poll(); w.out(400); assert.equal(w.poll().has('a'), true);
  w.tr.noteInteraction('a'); w.out(400);
  assert.equal(w.poll().has('a'), false, 'durante o silêncio não conta');
  w.clock.tick(QUIET_MS); // o silêncio acabou; o agente segue produzindo saída
  w.out(400); w.poll(); w.out(400);
  assert.equal(w.poll().has('a'), true, 'trabalho real volta a ser detectado');
});

test('tarefa entregue pelo maestro (sem interação da interface) é trabalho normal', () => {
  const w = world(); w.poll(); w.poll();
  w.out(600); w.poll(); w.out(600);
  assert.equal(w.poll().has('a'), true);
});

test('interação em um pane não silencia os outros', () => {
  const w = world(); w.bytes.b = 100; w.out(0);
  const polls = () => { const r = w.tr.update([run('a', w.bytes.a), run('b', w.bytes.b)]); w.clock.tick(); return r; };
  polls(); polls();
  w.tr.noteInteraction('a'); w.out(500, 'a'); w.out(500, 'b'); polls(); w.out(500, 'a'); w.out(500, 'b');
  const r = polls(); assert.equal(r.has('a'), false); assert.equal(r.has('b'), true, 'b produziu saída sem interação');
});

test('robustez: primeira consulta, pane encerrado, id inválido, bytes inválido e esquecimento de panes que sumiram', () => {
  const w = world();
  assert.deepEqual([...w.tr.update([run('a', 100)])], [], 'primeira vez: não há o que comparar');
  assert.deepEqual([...w.tr.update([run('a', 999999, 'exited')])], [], 'encerrado nunca trabalha');
  assert.deepEqual([...w.tr.update([null, { id: 5, status: 'running', bytes: 1 }, { id: 'x', status: 'running', bytes: 'abc' }, { status: 'running' }])], []);
  w.tr.noteInteraction(undefined); w.tr.noteInteraction(42); // ignorados
  w.tr.update([run('z', 1)]); w.tr.update([run('z', 500)]); w.tr.update([]); // z some
  assert.deepEqual([...w.tr.update([run('z', 900)])], [], 'um pane que reaparece começa do zero (sem histórico herdado)');
  assert.deepEqual([...w.tr.update()], []);
});
