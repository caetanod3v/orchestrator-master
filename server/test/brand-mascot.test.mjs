// O Elmo em Chamas (marca do FORGE) reage ao "calor" do sistema: ocioso fica acordado (visor em brasa fraca que respira, penacho baixo); com tarefa rodando o visor vai ao rubro, a chama cresce e saem faíscas de chama da cabeça e dos olhos; ao acabar, esfria devagar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BOX, PAD, SIZE, COLORS, PALETTE, PLUMES, VISOR, HELM_TOP, VISOR_Y, GEM, GEM_COLOR, eyeFlames, markSvg, pixelPaths, pose } from '../../client/src/brand-mark.mjs';
import { mascotFrame, framePaths, easeHeat, phaseRate, visorLevel, SPARKS, MAX_EMBERS, REST_HEAT, HOT_HEAT, ATTACK_S, RELEASE_S } from '../../client/src/brand-motion.mjs';

const cellsOf = (p) => COLORS.flatMap((k) => [...p[k].matchAll(/M(-?\d+) (-?\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2]), k]));

test('ocioso (calor 0): penacho baixo, visor em brasa fraca que respira (nível 0 e 1), sem brasas, e pisca raramente', () => {
  const frames = Array.from({ length: 80 }, (_, i) => mascotFrame({ phase: i * 0.25, heat: 0, t: i * 0.1 + 0.2 }));
  assert.ok(frames.every((f) => f.plume.startsWith('calm') && f.embers.length === 0 && f.sparks === 0 && f.fire === 0), 'chama baixa e sem faíscas');
  const idle = pose({ visor: 0, fire: 0 });
  for (const k of ['3,5', '10,5']) assert.ok('ER'.includes(idle.get(k)), `repouso: pequena chama sobre o canto de fora do olho (${k})`);
  assert.deepEqual([idle.get('3,6'), idle.get('4,7')], ['E', 'R'], 'e os olhos já com brasa acesa, não só um vermelho apagado');
  assert.deepEqual([...new Set(frames.map((f) => f.visor).filter((v) => v >= 0))].sort(), [0, 1], 'o visor sobe e desce um nível devagar (respira)');
  const blinks = Array.from({ length: 1000 }, (_, i) => mascotFrame({ phase: 0, heat: 0, t: i * 0.01 })).filter((f) => f.visor === -1).length;
  assert.ok(blinks > 0 && blinks < 100, `pisca ${blinks}/1000 quadros`);
});

test('trabalhando (calor 1): penacho alto tremulando, visor ao rubro (cintila entre 3 e 2) e todas as brasas', () => {
  const frames = Array.from({ length: 36 }, (_, i) => mascotFrame({ phase: i * 0.5, heat: 1, t: 1 }));
  assert.ok(frames.every((f) => f.plume.startsWith('hot') && f.sparks === MAX_EMBERS && f.fire === 3), 'chama alta, todas as faíscas e fogo no nível máximo');
  assert.deepEqual([...new Set(frames.map((f) => f.flick))].sort(), [0, 1], 'as chamas dos olhos tremulam');
  assert.deepEqual([...new Set(frames.map((f) => f.visor))].sort(), [2, 3], 'visor quente, cintilando');
  assert.ok(new Set(frames.map((f) => f.plume)).size >= 3, 'a chama tremula entre várias inclinações');
});

test('esfriar é gradual: o visor escurece nível a nível, a chama abaixa e as faíscas somem uma a uma, sem saltos', () => {
  const heats = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0];
  const f = heats.map((h) => mascotFrame({ phase: 1, heat: h, t: 1 }));
  const rank = { hot: 2, mid: 1, calm: 0 };
  for (let i = 1; i < f.length; i++) {
    assert.ok(visorLevel(heats[i]) <= visorLevel(heats[i - 1]), 'o visor nunca esquenta ao esfriar');
    assert.ok(rank[f[i].plume.slice(0, -1)] <= rank[f[i - 1].plume.slice(0, -1)], 'o penacho só abaixa');
    assert.ok(f[i].sparks <= f[i - 1].sparks, 'as faíscas só diminuem');
    assert.ok(f[i].fire <= f[i - 1].fire && eyeFlames(f[i].fire, 1).length <= eyeFlames(f[i - 1].fire, 1).length, 'as chamas dos olhos só diminuem');
    assert.ok(f[i - 1].sparks - f[i].sparks <= 2, 'perde no máximo duas faíscas por vez');
  }
  assert.equal(f[0].sparks, MAX_EMBERS); assert.equal(f.at(-1).sparks, 0); assert.equal(f.at(-1).embers.length, 0);
  assert.deepEqual([0, 0.19, 0.2, 0.49, 0.5, 0.79, 0.8, 1].map(visorLevel), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.ok(phaseRate(0) < phaseRate(0.5) && phaseRate(0.5) < phaseRate(1), 'o movimento desacelera junto');
  assert.ok(REST_HEAT < HOT_HEAT);
});

test('faíscas de chama: saem da cabeça (em leque) e dos olhos, voam para os lados e para cima com rastro, esquentam de cor (amarela > laranja > vermelha) e ficam dentro da caixa', () => {
  assert.equal(SPARKS.length, MAX_EMBERS); assert.equal(MAX_EMBERS, 6);
  assert.deepEqual(SPARKS.filter((s) => s.oy === 2).length, 4, 'quatro saem da cabeça'); assert.deepEqual(SPARKS.filter((s) => s.oy === 6).map((s) => s.ox).sort((x, y) => x - y), [3, 10], 'uma de cada olho');
  assert.ok(SPARKS.every((s) => s.vy < 0), 'todas sobem');
  assert.ok(SPARKS.some((s) => s.vx < 0) && SPARKS.some((s) => s.vx > 0), 'e abrem para os dois lados');
  const seen = new Set();
  for (let phase = 0; phase < 60; phase += 0.1) for (const e of mascotFrame({ phase, heat: 1, t: 1 }).embers) {
    assert.ok(e.x >= 0 && e.x < SIZE && e.y >= -PAD && e.y < SIZE, `faísca fora da caixa: ${e.x},${e.y}`);
    assert.ok(['Y', 'O', 'R'].includes(e.c)); seen.add(`${e.x},${e.y}`);
  }
  assert.ok([...seen].some((k) => Number(k.split(',')[0]) <= 2) && [...seen].some((k) => Number(k.split(',')[0]) >= 11), 'chegam bem longe dos dois lados da cabeça');
  const ys = (c) => { const out = []; for (let p = 0; p < 60; p += 0.1) mascotFrame({ phase: p, heat: 1, t: 1 }).embers.filter((e) => e.c === c).forEach((e) => out.push(e.y)); return out; };
  const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  assert.ok(avg(ys('Y')) > avg(ys('O')) && avg(ys('O')) > avg(ys('R')), 'a cor esfria à medida que sobe');
  const withTrail = Array.from({ length: 200 }, (_, i) => mascotFrame({ phase: i * 0.13, heat: 1, t: 1 })).filter((f) => f.embers.length > f.sparks);
  assert.ok(withTrail.length > 100, 'as faíscas têm rastro (mais células do que faíscas) na maior parte do tempo');
});

test('fogo enxuto: a chama da cabeça é compacta (não enche de fogo) e cresce por nível; a gema e o visor acompanham', () => {
  const count = (name) => PLUMES[name].join('').split('').filter((ch) => ch !== '.').length;
  const width = (name) => Math.max(...PLUMES[name].map((r) => r.lastIndexOf('E') - r.indexOf('E') + 1).filter((n) => n > 0));
  assert.ok(count('calmA') < count('midA') && count('midA') < count('hotA'), 'cresce por nível');
  for (const n of ['hotA', 'hotB', 'hotC']) { assert.ok(count(n) <= 13, `${n}: no máximo 13 células de fogo (tem ${count(n)})`); assert.ok(width(n) <= 7, `${n}: largura contida`); assert.ok(PLUMES[n].join('').includes('Y'), `${n}: miolo amarelo`); }
});

test('olhos: dois, separados e inclinados para dentro (bravos), no alto do rosto; acendem por nível (fora e dentro), apagam ao piscar, e a luz do fogo tinge o alto da cúpula nos níveis quentes', () => {
  assert.deepEqual(VISOR.map(([o, i]) => o + i), ['ER', 'OR', 'OE', 'YO'], 'já em repouso os olhos têm brasa acesa (E/R), e esquentam daí');
  assert.equal(VISOR_Y, 6, 'os olhos ficam no alto do rosto (antes estavam na linha 8, baixos demais)');
  const at = (visor, x, y) => pose({ visor }).get(`${x},${y}`);
  const top = [[3, VISOR_Y], [4, VISOR_Y], [9, VISOR_Y], [10, VISOR_Y]], low = [[4, VISOR_Y + 1], [5, VISOR_Y + 1], [8, VISOR_Y + 1], [9, VISOR_Y + 1]], gap = [[6, VISOR_Y], [7, VISOR_Y], [6, VISOR_Y + 1], [7, VISOR_Y + 1]];
  for (let lvl = 0; lvl < VISOR.length; lvl++) {
    const [outer, inner] = VISOR[lvl];
    assert.deepEqual(top.map(([x, y]) => at(lvl, x, y)), [outer, outer, outer, outer], `nível ${lvl}: parte de cima de cada olho`);
    assert.deepEqual(low.map(([x, y]) => at(lvl, x, y)), [inner, inner, inner, inner], `nível ${lvl}: parte de baixo de cada olho`);
    assert.deepEqual(gap.map(([x, y]) => at(lvl, x, y)), ['K', 'K', 'K', 'K'], `nível ${lvl}: vão escuro entre os olhos (ponte do nariz)`);
  }
  // inclinação: a parte de baixo de cada olho é deslocada para o centro (olhar bravo) e os dois olhos são espelhados
  assert.ok(Math.min(...low.slice(0, 2).map(([x]) => x)) > Math.min(...top.slice(0, 2).map(([x]) => x)), 'olho esquerdo inclinado para dentro');
  assert.ok(Math.max(...low.slice(2).map(([x]) => x)) < Math.max(...top.slice(2).map(([x]) => x)), 'olho direito inclinado para dentro');
  assert.deepEqual(top.concat(low).map(([x, y]) => at(0, 13 - x, y)), top.concat(low).map(([x, y]) => at(0, x, y)), 'olhos espelhados');
  assert.deepEqual(top.concat(low).map(([x, y]) => at(-1, x, y)), Array(8).fill('K'), 'piscando: olhos apagados');
  assert.deepEqual([0, 1, 2, 3].map((v) => at(v, 6, HELM_TOP)), ['H', 'H', 'R', 'E'], 'o alto da cúpula é tingido pelo fogo');
  assert.deepEqual([0, 1, 2, 3].map((v) => at(v, 6, HELM_TOP + 1)), ['H', 'H', 'H', 'H'], 'só o alto da cúpula é tingido (sem faixa larga)');
});

test('tudo cabe na caixa de 16 (todas as fases, calores e tempos) e cada célula tem uma cor só', () => {
  for (const heat of [0, 0.15, 0.3, 0.6, 0.9, 1]) for (let phase = 0; phase < 30; phase += 0.37) for (const t of [0.01, 0.3, 1.8]) {
    const cells = cellsOf(framePaths(mascotFrame({ phase, heat, t })));
    assert.ok(cells.length >= 95, 'o elmo sempre aparece inteiro');
    for (const [x, y] of cells) assert.ok(x >= 0 && x < BOX && y >= 0 && y < BOX, `fora da caixa: ${x},${y}`);
    assert.equal(new Set(cells.map(([x, y]) => `${x},${y}`)).size, cells.length, 'cada célula tem uma cor só');
  }
  assert.equal(PAD, 1); assert.equal(SIZE + PAD * 2, BOX);
});

test('anatomia: penacho em cima do elmo, cúpula, viseira em T e fenda de respiro; os penachos têm 4 linhas e 14 colunas', () => {
  for (const [name, rows] of Object.entries(PLUMES)) assert.ok(rows.length === 4 && rows.every((r) => r.length === SIZE), `fogo da cabeça ${name}`);
  assert.equal(HELM_TOP, 3); assert.equal(VISOR_Y, 6);
  const cells = pose({ plume: 'hotA', visor: 3 });
  assert.equal(cells.get('6,3'), 'E', 'alto da cúpula sob o fogo'); assert.equal(cells.get('6,0'), 'E', 'topo da chama'); assert.equal(cells.get('6,2'), 'Y', 'miolo da chama');
  assert.equal(cells.get('6,10'), 'D', 'fenda de respiro vertical'); assert.equal(cells.get('7,11'), 'D');
  assert.equal(cells.get('2,6'), 'L', 'brilho da borda esquerda'); assert.equal(cells.get('11,6'), 'D', 'sombra da borda direita');
  for (const [name, rows] of Object.entries(PLUMES)) assert.ok(rows.join('').split('').every((c) => '.EOY'.includes(c)), `penacho ${name} só usa as cores do fogo`);
});

test('capacete com formato: cúpula redonda (4, 8 e 10 células), simétrico, laterais retas até a bochecha e mandíbula que afina em V; sem chifres e sem crista', () => {
  const cells = pose({ visor: 0 });
  const xs = (y) => [...Array(SIZE).keys()].filter((x) => cells.has(`${x},${y}`));
  const rows = Array.from({ length: 11 }, (_, i) => xs(HELM_TOP + i));
  assert.deepEqual(rows.map((r) => r.length), [4, 8, 10, 10, 10, 10, 10, 10, 8, 6, 8], 'cúpula redonda no alto, queixo em V e protetor de pescoço');
  for (const r of rows) assert.equal(r[0] + r.at(-1), 13, 'cada linha é simétrica em torno do centro');
  assert.ok(new Set(rows.map((r) => r.length)).size >= 4, 'várias larguras: não é um retângulo');
  for (let y = HELM_TOP + 2; y <= HELM_TOP + 7; y++) assert.ok(cells.has(`2,${y}`) && cells.has(`11,${y}`), `lateral reta na linha ${y}`);
  for (let y = 0; y < HELM_TOP; y++) for (let x = 0; x < SIZE; x++) assert.ok(!cells.has(`${x},${y}`) || 'EOYR'.includes(cells.get(`${x},${y}`)), `acima da cúpula só há fogo (sem chifres): ${x},${y}`);
});

test('detalhes do elmo: rebites na testa, aba da sobrancelha, realce diagonal e costura nas bochechas, gema que acende com o calor', () => {
  const c = pose({ visor: 0 });
  assert.equal(c.get('4,5'), 'L'); assert.equal(c.get('9,5'), 'L'); // rebites
  for (let x = 3; x <= 10; x++) assert.equal(c.get(`${x},${VISOR_Y + 2}`), 'H', `borda de apoio sob os olhos em ${x},${VISOR_Y + 2}`);
  assert.deepEqual(['3,9', '3,10', '4,11', '5,12'].map((k) => c.get(k)), ['H', 'H', 'H', 'H'], 'realce diagonal à esquerda');
  assert.deepEqual(['10,9', '10,10', '9,11', '8,12'].map((k) => c.get(k)), ['D', 'D', 'D', 'D'], 'costura escura à direita');
  assert.deepEqual(['5,10', '8,10'].map((k) => c.get(k)), ['K', 'K'], 'fendas de ventilação nas bochechas');
  assert.deepEqual(GEM_COLOR, ['R', 'E', 'O', 'Y']);
  for (let fire = 0; fire < 4; fire++) for (const [x, y] of GEM) assert.equal(pose({ visor: fire }).get(`${x},${y}`), GEM_COLOR[fire], `gema no nível ${fire}`);
  assert.equal(pose({ visor: -1, fire: 3 }).get('6,5'), 'Y', 'piscando os olhos não apaga a gema');
});

test('chamas: só da cabeça (penacho) e dos olhos; nada nas laterais; os olhos já têm uma pequena chama no repouso e ela cresce com o calor, sempre curta e tremendo', () => {
  assert.deepEqual([0, 1, 2, 3].map((f) => eyeFlames(f, 0).length), [2, 4, 6, 8], 'já há uma pequena chama em cada olho no repouso, e mais fogo a cada nível');
  for (const fire of [0, 1, 2, 3]) assert.notDeepEqual(eyeFlames(fire, 0), eyeFlames(fire, 1), `nível ${fire}: treme`);
  assert.deepEqual(eyeFlames(0, 0).map(([x, y]) => [x, y]), [[3, VISOR_Y - 1], [10, VISOR_Y - 1]], 'no repouso: só a base, sobre o canto de fora de cada olho');
  for (const [fire, flick] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1]]) for (const [x, y, c] of eyeFlames(fire, flick)) {
    assert.ok([2, 3, 4, 9, 10, 11].includes(x) && y >= VISOR_Y - 2 && y <= VISOR_Y - 1 && 'EOR'.includes(c), `chama de olho válida: ${x},${y},${c}`);
  }
  for (const visor of [0, 1, 2, 3]) for (const flick of [0, 1]) {
    const cells = pose({ plume: 'hotA', visor, flick });
    for (const [key, c] of cells) { const [x, y] = key.split(',').map(Number); if (y >= HELM_TOP) assert.ok(!('EOYR'.includes(c) && (x <= 1 || x >= 12)), `sem chama nas laterais: ${key}`); }
  }
});

test('sem ladrilho: a logo da barra lateral é só o elmo (nenhum fundo quadrado), e o ícone do app mantém o ladrilho', () => {
  const src = fs.readFileSync(new URL('../../client/src/components/MascotLogo.jsx', import.meta.url), 'utf8');
  assert.ok(!/<rect/.test(src), 'o componente da barra lateral não desenha fundo');
  assert.ok(markSvg({ size: 64 }).includes('<rect'), 'favicon e ícone do desktop mantêm o ladrilho');
});

test('easeHeat: sobe rápido, desce devagar, chega ao alvo e não passa dele', () => {
  let h = 0, tUp = 0; while (h < 0.95 && tUp < 20) { h = easeHeat(h, 1, 0.05); tUp += 0.05; }
  let c = 1, tDown = 0; while (c > 0.05 && tDown < 40) { c = easeHeat(c, 0, 0.05); tDown += 0.05; }
  assert.ok(tUp < ATTACK_S * 4, `aquece em ${tUp.toFixed(2)}s`); assert.ok(tDown > RELEASE_S && tDown > tUp * 3, `esfria em ${tDown.toFixed(2)}s, bem mais devagar`);
  assert.equal(easeHeat(0.999, 1, 1), 1); assert.equal(easeHeat(0.004, 0, 0.016), 0); assert.equal(easeHeat(0.5, 0.5, 1), 0.5);
  assert.ok(easeHeat(0.5, 1, 0) === 0.5 && easeHeat(0.5, 1, -3) === 0.5, 'dt 0 ou negativo não move');
});

test('ícone estático (favicon/desktop): SVG válido, com a paleta preto e vermelho e o visor ao rubro', () => {
  const svg = markSvg({ size: 64 });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 16 16"/);
  for (const k of ['G', 'L', 'R', 'E', 'O', 'Y']) assert.ok(svg.includes(PALETTE[k]), `cor ${k} presente`);
  assert.ok(Object.values(pixelPaths()).join('').length > 0);
});
