import React, { useEffect, useRef, useState } from 'react';
import { BOX, COLORS, PALETTE } from '../brand-mark.mjs';
import { mascotFrame, framePaths, easeHeat, phaseRate } from '../brand-motion.mjs';

const REDUCED_PHASE = 4, REDUCED_T = 1; // quadro fixo (penacho alto, visor ao rubro) quando o movimento está reduzido
const keyOf = (f) => `${f.plume}|${f.visor}|${f.fire}|${f.flick}|${f.embers.map((e) => `${e.x},${e.y},${e.c}`).join(';')}|${Math.round(f.heat * 20)}`;
const reducedMotion = () => {
  try { return document.documentElement.dataset.motion === 'reduced' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/**
 * Marca do FORGE: o Elmo em Chamas (pixel art, ver brand-mark.mjs), sem ladrilho de fundo: só o elmo e o fogo sobre a barra lateral. `working` = há alguma tarefa rodando em algum workspace.
 * Ocioso: acordado, olhos já com brasa acesa e uma pequena chama no canto de cada um (respiram, ficando um pouco mais quentes), chama baixa na cabeça balançando devagar e piscando de vez em quando. Trabalhando: esquenta rápido (visor até o amarelo, chama compacta na cabeça, línguas finas nos olhos e faíscas de chama voando para os lados e para cima, brilho laranja).
 * Ao terminar, o "calor" cai devagar (as faíscas somem uma a uma, o visor escurece e a chama abaixa) até voltar ao repouso. O laço só roda leve (poucas atualizações por segundo) quando está calmo.
 * Respeita "Animações reduzidas" (data-motion) e prefers-reduced-motion: mostra um quadro fixo, sem laço de animação rápido.
 */
export function MascotLogo({ size = 32, working = false }) {
  const s = useRef({ heat: 0, phase: 0, t: 0, last: 0, key: '' });
  const target = useRef(working); target.current = working;
  const [frame, setFrame] = useState(() => mascotFrame({ t: 1 }));

  useEffect(() => {
    let timer = 0, alive = true;
    const st = s.current; st.last = performance.now();
    const push = (f) => { const k = keyOf(f); if (k !== st.key) { st.key = k; setFrame(f); } };
    const tick = () => {
      if (!alive) return;
      const now = performance.now(), dt = Math.min(0.25, (now - st.last) / 1000); st.last = now;
      const tg = target.current ? 1 : 0;
      if (document.hidden) { timer = setTimeout(tick, 1000); return; }
      if (reducedMotion()) { st.heat = tg; push(mascotFrame({ phase: REDUCED_PHASE, heat: tg, t: REDUCED_T })); timer = setTimeout(tick, 1000); return; }
      st.heat = easeHeat(st.heat, tg, dt); st.phase += dt * phaseRate(st.heat); st.t += dt;
      push(mascotFrame({ phase: st.phase, heat: st.heat, t: st.t }));
      timer = setTimeout(tick, st.heat > 0 || tg ? 66 : 350); // quente: ~15 quadros/s (pixel art); calmo: o suficiente para o balanço lento e o piscar
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const p = framePaths(frame), glow = frame.heat > 0.05 ? `drop-shadow(0 0 ${(frame.heat * 5).toFixed(1)}px rgba(230, 80, 30, ${(frame.heat * 0.55).toFixed(2)}))` : undefined;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`} fill="none" shapeRendering="crispEdges" aria-hidden="true" focusable="false" style={glow ? { filter: glow } : undefined}>
      {COLORS.map((k) => (p[k] ? <path key={k} d={p[k]} fill={PALETTE[k]} /> : null))}
    </svg>
  );
}
