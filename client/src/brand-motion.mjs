// Animação do Elmo em Chamas (marca do FORGE) em função do "calor" do sistema: 0 = todos os workspaces ociosos (acordado: visor em brasa fraca que respira, penacho baixo balançando devagar),
// 1 = há tarefa rodando (visor ao rubro, penacho alto, brasas subindo). Funções puras e sem relógio: o componente acumula `phase` (o ritmo cresce com o calor) e `t` (tempo real, só para respirar e
// piscar) e suaviza o calor; aqui só se decide o quadro.
import { pose, cellPaths, PAD, SIZE } from './brand-mark.mjs';

export const REST_HEAT = 0.2, HOT_HEAT = 0.5; // abaixo de REST: repouso; de REST a HOT: esquentando/esfriando; acima de HOT: a pleno
/**
 * Faíscas de chama: cada uma nasce num ponto fixo (origem [x, y]) e voa com velocidade [vx, vy] em células por vida. Quatro saem da cabeça em leque (para cima e para os lados) e uma de cada olho
 * voa para fora e para cima. Amarela ao nascer, laranja no meio e vermelha no fim, cada uma com um rastro curto atrás (uma célula mais fria), para ficarem bem visíveis.
 */
export const SPARKS = [
  { ox: 5, oy: 2, vx: -3.2, vy: -3.2 }, { ox: 8, oy: 2, vx: 3.2, vy: -3.2 },
  { ox: 6, oy: 2, vx: -1.2, vy: -4.2 }, { ox: 7, oy: 2, vx: 1.2, vy: -4.2 },
  { ox: 3, oy: 6, vx: -3.4, vy: -3.6 }, { ox: 10, oy: 6, vx: 3.4, vy: -3.6 },
];
export const MAX_EMBERS = SPARKS.length;
const SEQ = { calm: ['calmA', 'calmB', 'calmA', 'calmC'], mid: ['midA', 'midB', 'midA', 'midC'], hot: ['hotA', 'hotB', 'hotA', 'hotC'] };
const frac = (n) => n - Math.floor(n);
export const clamp01 = (n) => (n > 1 ? 1 : n > 0 ? n : 0);

/** Ritmo (quadros de chama por segundo) em função do calor: de um balanço lento (parado) a um tremular vivo (trabalhando). */
export const phaseRate = (heat) => 0.7 + 4.3 * clamp01(heat);

/** Nível-base do visor pelo calor: 0 brasa fraca, 1 viva, 2 quente, 3 ao rubro. */
export const visorLevel = (h) => (h < REST_HEAT ? 0 : h < HOT_HEAT ? 1 : h < 0.8 ? 2 : 3);

/**
 * Quadro do Elmo: penacho, visor (-1 apagado) e brasas ({x, y, c}; y pode ser -1, a linha acima da grade, que ainda cabe na caixa de 16).
 * Repouso: penacho baixo balançando devagar, visor em brasa fraca que "respira" (sobe e desce um nível devagar) e pisca de vez em quando; sem brasas.
 * Calor alto: fogo da cabeça alto e tremulando, visor ao rubro (e cintilando) e faíscas de chama voando da cabeça e dos olhos. As faíscas somem uma a uma e desaceleram ao esfriar.
 */
export function mascotFrame({ phase = 0, heat = 0, t = 0 } = {}) {
  const h = clamp01(heat);
  const family = h >= HOT_HEAT ? 'hot' : h >= REST_HEAT ? 'mid' : 'calm';
  const plume = SEQ[family][((Math.floor(phase) % 4) + 4) % 4];
  let visor = visorLevel(h);
  if (visor === 0 && Math.floor(t / 1.5) % 2 === 1) visor = 1;     // respira: a brasa fraca sobe e desce devagar
  else if (visor === 3 && Math.floor(phase) % 3 === 0) visor = 2;  // ao rubro, cintila
  if (frac(t / 4.3) < 0.035) visor = -1;                           // pisca (visor apagado por um instante)
  const count = h >= REST_HEAT ? Math.max(1, Math.round(h * MAX_EMBERS)) : 0;
  const embers = [];
  const at = (sp, u) => ({ x: Math.round(sp.ox + sp.vx * u), y: Math.round(sp.oy + sp.vy * u) });
  const tone = (u) => (u < 0.4 ? 'Y' : u < 0.75 ? 'O' : 'R');
  for (let i = 0; i < count; i++) {
    const sp = SPARKS[i], u = frac(phase * 0.22 * (0.85 + 0.06 * i) + i * 0.37); // 0 = nasce na origem, 1 = apaga
    const head = at(sp, u), tail = at(sp, Math.max(0, u - 0.1));
    const inBox = (p) => p.x >= 0 && p.x < SIZE && p.y >= -PAD && p.y < SIZE;                  // o que sai da caixa de 16 não é desenhado
    if (u > 0.1 && (tail.x !== head.x || tail.y !== head.y) && inBox(tail)) embers.push({ ...tail, c: tone(u + 0.3) });   // rastro: uma célula mais fria
    if (inBox(head)) embers.push({ ...head, c: tone(u) });
  }
  return { plume, visor, fire: visorLevel(h), flick: Math.floor(phase) % 2, embers, sparks: count, heat: h };
}

/** Caminhos SVG por cor de um quadro (elmo + brasas por cima). */
export function framePaths(frame) {
  const cells = pose({ plume: frame.plume, visor: frame.visor, fire: frame.fire, flick: frame.flick });
  for (const e of frame.embers) cells.set(`${e.x},${e.y}`, e.c);
  return cellPaths(cells);
}

/** Suaviza o calor em direção ao alvo: sobe rápido (a forja acorda) e desce devagar (esfria aos poucos). `dt` em segundos. */
export const ATTACK_S = 0.4;
export const RELEASE_S = 2.8;
export function easeHeat(heat, target, dt) {
  const tau = target > heat ? ATTACK_S : RELEASE_S;
  const next = heat + (target - heat) * (1 - Math.exp(-Math.max(0, dt) / tau));
  return Math.abs(target - next) < 0.01 ? target : next;
}
