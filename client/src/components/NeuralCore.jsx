import React, { useEffect, useRef, useState } from 'react';
import { createCore, setMode, stepCore, isSettled, frameInterval, snapCore, errTint } from '../core-model.js';

const mq = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');
// Preferência do sistema por menos movimento (reativa a mudanças).
export function usePrefersReduced() {
  const [v, setV] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq(); if (!m) return undefined;
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

// A nuvem da referência (videoframe): partículas brancas finas numa casca irregular, mais densas no limbo e rarefeitas no centro.
const N = 1500, BUCKETS = 5;
const BONE = [244, 243, 239], WARN = [226, 176, 82], ERR = [238, 111, 102];
const base = (() => {
  const x = new Float32Array(N), y = new Float32Array(N), z = new Float32Array(N), s = new Float32Array(N);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const yy = 1 - ((i + 0.5) * 2) / N, r = Math.sqrt(1 - yy * yy), j = (Math.random() - 0.5) * 0.06;
    x[i] = Math.cos(ga * i + j) * r; y[i] = yy; z[i] = Math.sin(ga * i + j) * r; s[i] = 0.84 + 0.16 * Math.random(); // espessura da casca
  }
  return { x, y, z, s };
})();

/**
 * Indicador do orquestrador (Canvas 2D). Não desenha dados: o movimento e o tom seguem o MODO operacional real (ver coreMode em op-state.js):
 * ocioso quase parado; Planner trabalhando, movimento suave; Executor executando, movimento mais perceptível; aguardando decisão, desacelera com tom âmbar;
 * erro, um clarão breve. O texto ao lado diz o estado (a cor só reforça).
 * Sem loop quando a página está oculta ou o movimento é reduzido (nesse caso desenha só o estado estático).
 * mode: 'idle' | 'planning' | 'executing' | 'awaiting' | 'error'.
 */
export default function NeuralCore({ mode = 'idle', size = 112 }) {
  const canvas = useRef(null);
  const model = useRef(null);
  const control = useRef({ start: () => {}, drawNow: () => {} });
  const reduced = usePrefersReduced();
  if (!model.current) model.current = createCore(mode);

  useEffect(() => {
    const s = model.current;
    setMode(s, mode);
    if (reduced) { snapCore(s); control.current.drawNow(); } else control.current.start();
  }, [mode, reduced]);

  useEffect(() => {
    const cv = canvas.current, ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
    const s = model.current;
    const px = new Float32Array(N), py = new Float32Array(N), pb = new Uint8Array(N); // reutilizados em todos os quadros
    let raf = 0, last = 0, lastDraw = 0, frames = 0;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2, R = size * 0.4;
      const ca = Math.cos(s.angle), sa = Math.sin(s.angle), ct = Math.cos(0.4), st = Math.sin(0.4);
      const amp = s.amp, t = s.time;
      for (let i = 0; i < N; i++) {
        const x = base.x[i], y = base.y[i], z = base.z[i];
        // deformação orgânica: poucas ondas lentas, em vez de ruído por partícula
        const d = 1 + amp * (Math.sin(2.1 * x + 1.4 * y + t * 0.5) + 0.7 * Math.sin(2.9 * y - 1.9 * z + t * 0.42) + 0.5 * Math.sin(2.4 * z + 1.1 * x - t * 0.35)) / 2.2;
        const r = d * base.s[i];
        const X = x * r, Y = y * r, Z = z * r;
        const x1 = X * ca + Z * sa, z1 = -X * sa + Z * ca;
        const y2 = Y * ct - z1 * st, z2 = Y * st + z1 * ct;
        px[i] = c + x1 * R; py[i] = c - y2 * R;
        const limb = Math.min(1, Math.hypot(x1, y2)); // mais claro no limbo, rarefeito no centro
        pb[i] = Math.max(0, Math.min(BUCKETS - 1, Math.floor((limb * 0.75 + (z2 + 1) * 0.125) * BUCKETS * 1.05)));
      }
      const w = s.warm, e = errTint(s);
      const r0 = BONE[0] + (WARN[0] - BONE[0]) * w, g0 = BONE[1] + (WARN[1] - BONE[1]) * w, b0 = BONE[2] + (WARN[2] - BONE[2]) * w;
      ctx.fillStyle = `rgb(${(r0 + (ERR[0] - r0) * e) | 0},${(g0 + (ERR[1] - g0) * e) | 0},${(b0 + (ERR[2] - b0) * e) | 0})`;
      const sz = size > 100 ? 1.25 : 1;
      for (let b = 0; b < BUCKETS; b++) {
        ctx.globalAlpha = 0.1 + 0.7 * (b / (BUCKETS - 1));
        for (let i = 0; i < N; i++) if (pb[i] === b) ctx.fillRect(px[i], py[i], sz, sz);
      }
      ctx.globalAlpha = 1;
      cv.dataset.frames = String(++frames); cv.dataset.mode = s.mode; cv.dataset.rot = s.rot.toFixed(3); cv.dataset.wave = s.wave.toFixed(2);
    };

    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    const loop = (now) => {
      raf = 0;
      if (document.hidden || mq()?.matches) return; // oculta ou movimento reduzido: sem loop (o retorno à visibilidade religa)
      const every = frameInterval({ settled: isSettled(s), mode: s.mode });
      if (now - lastDraw >= every) { stepCore(s, Math.min(0.1, (now - last) / 1000)); last = now; lastDraw = now; draw(); }
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (raf || document.hidden || mq()?.matches) return; last = performance.now(); lastDraw = 0; raf = requestAnimationFrame(loop); };
    const onVis = () => { if (document.hidden) stop(); else if (!mq()?.matches) start(); };
    control.current = { start, drawNow: () => { stop(); draw(); } };
    document.addEventListener('visibilitychange', onVis);
    if (reduced) { snapCore(s); draw(); } else start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); control.current = { start: () => {}, drawNow: () => {} }; };
  }, [size, reduced]);

  return <canvas ref={canvas} className="orb" style={{ width: size, height: size }} aria-hidden="true" />;
}
