// Modelo de movimento do Neural Core (funções puras sobre um objeto de estado reutilizado: nenhuma alocação por quadro).
// O núcleo só reflete o estado operacional (ver coreMode em op-state.js). Cada modo define a velocidade-alvo; o estado atual se aproxima dela
// de forma exponencial, então toda transição (inclusive o retorno ao repouso depois de uma conclusão) é gradual.

/** rot: rotação (rad/s) | wave: velocidade com que a deformação orgânica evolui (reorganização das partículas) | amp: amplitude da deformação | warm/err: mistura de tom (0..1) */
export const MODES = Object.freeze({
  idle:      { rot: 0.012, wave: 0.08, amp: 0.05, warm: 0, err: 0 },
  planning:  { rot: 0.09,  wave: 0.5,  amp: 0.12, warm: 0, err: 0 },
  executing: { rot: 0.26,  wave: 1.0,  amp: 0.17, warm: 0, err: 0 },
  awaiting:  { rot: 0.02,  wave: 0.1,  amp: 0.06, warm: 0.35, err: 0 },
  error:     { rot: 0.012, wave: 0.08, amp: 0.05, warm: 0, err: 0.12 }, // o aviso forte é só o clarão de entrada (flash); depois fica um resíduo contido
});

export const RATE = 1.6;        // taxa de aproximação (1/s): ~1,5 s para assentar
export const FLASH_DECAY = 1.1; // decaimento do clarão de erro (1/s): ~2 s
export const FLASH_TINT = 0.6;  // quanto do tom de erro o clarão aplica no pico

export const createCore = (mode = 'idle') => {
  const m = MODES[mode];
  return { mode, rot: m.rot, wave: m.wave, amp: m.amp, warm: m.warm, err: m.err, flash: 0, angle: 0.8, time: 0 };
};

const ap = (cur, target, dt) => cur + (target - cur) * (1 - Math.exp(-RATE * dt));

/** Muda o modo-alvo. Entrar em erro (vindo de outro modo) dispara o clarão breve; permanecer em erro não repete. */
export function setMode(s, mode) {
  if (s.mode === mode || !MODES[mode]) return s;
  if (mode === 'error') s.flash = 1;
  s.mode = mode;
  return s;
}

/** Avança `dt` segundos (mutando `s`). Retorna o próprio estado. */
export function stepCore(s, dt) {
  const t = MODES[s.mode];
  s.rot = ap(s.rot, t.rot, dt); s.wave = ap(s.wave, t.wave, dt); s.amp = ap(s.amp, t.amp, dt);
  s.warm = ap(s.warm, t.warm, dt); s.err = ap(s.err, t.err, dt);
  s.flash = s.flash * Math.exp(-FLASH_DECAY * dt);
  s.angle += s.rot * dt; s.time += s.wave * dt;
  return s;
}

/** Tom de erro efetivo (0..1): resíduo do modo + clarão. */
export const errTint = (s) => Math.min(1, s.err + s.flash * FLASH_TINT);

/** O estado já assentou no alvo (a animação pode ir a uma taxa de quadros menor)? */
export function isSettled(s, eps = 0.002) {
  const t = MODES[s.mode];
  return Math.abs(s.rot - t.rot) < eps && Math.abs(s.wave - t.wave) < eps * 4 && Math.abs(s.amp - t.amp) < eps && Math.abs(s.warm - t.warm) < eps * 4 && Math.abs(s.err - t.err) < eps * 4 && s.flash < 0.01;
}

/**
 * Intervalo mínimo entre quadros (ms), ou null para NÃO desenhar em loop.
 * Página oculta ou movimento reduzido: nenhum loop. Assentado no repouso: poucos quadros. Atividade: ~30 quadros por segundo.
 */
export function frameInterval({ hidden = false, reduced = false, settled = false, mode = 'idle' } = {}) {
  if (hidden || reduced) return null;
  if (settled && (mode === 'idle' || mode === 'awaiting' || mode === 'error')) return 80;
  return 33;
}

/** Salta direto ao alvo (movimento reduzido: sem transição contínua, só o estado estático correto). */
export function snapCore(s) {
  const t = MODES[s.mode];
  s.rot = t.rot; s.wave = t.wave; s.amp = t.amp; s.warm = t.warm; s.err = t.err; s.flash = 0;
  return s;
}
