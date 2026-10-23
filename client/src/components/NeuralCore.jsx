import React, { useEffect, useRef, useState } from 'react';

const GREEN = '63,178,127', RED = '229,83,75', GREY = '200,208,217';

// Evento real do backend -> reação visual. `node` = nó que acende; `link` = [origem, destino]
// percorrido por pontos de tráfego; `ring` = onda para fora; `inward` = onda de parada.
// Eventos de agentes (e.agent) só existirão quando a API os registrar; hoje nenhum é emitido.
export function reactionFor(e) {
  if (e.agent === 'planner' || e.agent === 'executor') return { node: e.agent, link: [e.agent, 'core'], color: GREY };
  switch (e.type) {
    case 'approval': return { node: 'gate', link: ['gate', 'core'], ring: true, color: GREEN };
    case 'rejection': return { node: 'gate', link: ['gate', 'core'], ring: true, color: RED };
    case 'mission':
    case 'task': return { node: 'queue', link: ['queue', 'core'], ring: true, soft: true, color: GREY };
    case 'workspace': return { node: 'workspace', link: ['workspace', 'core'], color: GREY };
    case 'system': // interrupção: só destaca o executor se a API confirmou que parou algo
      return e.stopped ? { node: 'executor', inward: true, color: RED } : { inward: true, soft: true, color: GREY };
    default: return { ring: true, soft: true, color: GREY };
  }
}

const N = 14000, SPARKS = 700; // SPARKS: partículas internas, tênues, que dão sensação de atividade
const base = (() => {
  const x = new Float32Array(N), y = new Float32Array(N), z = new Float32Array(N), s = new Float32Array(N), ph = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    x[i] = r * Math.cos(a); y[i] = u; z[i] = r * Math.sin(a);
    s[i] = i < SPARKS ? 0.25 + 0.55 * Math.random() : 0.9 + 0.1 * Math.pow(Math.random(), 0.3);
    ph[i] = Math.random() * Math.PI * 2;
  }
  return { x, y, z, s, ph };
})();

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
const LIVE = new Set(['active', 'idle', 'live', 'awaiting']);
const TIERS = [1, 0.7, 0.5, 0.35]; // qualidade em degraus (adaptar de forma contínua faz o brilho oscilar)
const BUCKETS = 16; // níveis de alfa: quanto mais, menos saltos visíveis entre quadros
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * Esfera de partículas + rede de conexões, em tela cheia.
 * nodes: [{id, x, y, state}] (x,y em fração da área); links: [[a,b]]; `core` é implícito.
 * fresh: {batch, events} com eventos NOVOS do backend (nunca o histórico). Só eles geram tráfego.
 * selected: id do nó selecionado (realça as conexões e provoca uma onda no núcleo).
 */
export default function NeuralCore({ running, awaiting, nodes, links, fresh, selected, layout, forceMotion, center = { x: 0.5, y: 0.5 } }) {
  const canvas = useRef(null);
  const live = useRef({});
  const pulses = useRef([]);
  const kick = useRef(0);
  const redraw = useRef(null);
  const still = usePrefersReduced() && !forceMotion;
  live.current = { running, awaiting, nodes, links, center, selected };

  // eventos reais novos -> pulsos
  useEffect(() => {
    if (!fresh?.events.length) return;
    for (const e of fresh.events) {
      pulses.current.push({ ...reactionFor(e), t0: performance.now() });
      kick.current = Math.min(1, kick.current + 0.4);
    }
  }, [fresh?.batch]);

  // seleção -> onda breve no núcleo
  const firstSel = useRef(true);
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return; }
    if (selected) { pulses.current.push({ ring: true, soft: true, color: GREY, t0: performance.now() }); kick.current = Math.min(1, kick.current + 0.3); }
    redraw.current?.();
  }, [selected]);
  useEffect(() => { redraw.current?.(); const t = setTimeout(() => redraw.current?.(), 320); return () => clearTimeout(t); }, [nodes, awaiting, layout]);

  useEffect(() => {
    const cv = canvas.current, ctx = cv.getContext('2d');
    let w = 0, h = 0, dpr = 1, raf = 0, rot = 0, last = performance.now(), time = 0, glow = 0, frames = 0;
    let tiltX = 0, tiltY = 0, tx = 0, ty = 0, q = 1, ema = 16, tier = 0, lastAdapt = 0; // q: fração das partículas da casca
    const hi = {}; // intensidade de destaque por conexão (suavizada)
    const px = new Float32Array(N), py = new Float32Array(N), pb = new Uint8Array(N);
    const order = new Uint16Array(N), cnt = new Uint32Array(BUCKETS + 1);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      if (still) frame(performance.now());
    };

    function frame(now) {
      const t0 = performance.now();
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); const raw = (now - last) * 1000 / 1000; last = now; frames++;
      if (!still && frames > 3 && raw < 250) { // mantém ~30+ fps trocando de nível (com espera) se a máquina não acompanhar
        ema += (raw - ema) * 0.1;
        if (ema > 32 && tier < TIERS.length - 1 && now - lastAdapt > 1500) { tier++; lastAdapt = now; }
        else if (ema < 20 && tier > 0 && now - lastAdapt > 4000) { tier--; lastAdapt = now; }
        q = TIERS[tier];
      }
      const { running: run, awaiting: wait, nodes: nds, links: lks, center: c, selected: sel } = live.current;
      if (!still) { time += dt; rot += dt * (run ? 0.3 : 0.09); }
      // respostas suavizadas (independentes de taxa de quadros)
      glow = approach(glow, (sel ? 0.45 : 0) + kick.current * 0.55, 2.2, dt);
      kick.current = approach(kick.current, 0, 1.4, dt);
      tiltX = approach(tiltX, tx, 3, dt); tiltY = approach(tiltY, ty, 3, dt);

      const cx = w * c.x, cy = h * c.y;
      const R0 = Math.min(w * 0.27, h * 0.31);
      const R = R0 * (1 + (0.03 + 0.01 * glow) * Math.sin(time * 0.8) + 0.012 * Math.sin(time * 1.9 + 1.3));
      const bright = 0.93 + 0.07 * Math.sin(time * 0.8 + 0.5) + 0.08 * glow;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const g = ctx.createRadialGradient(cx, cy, R * 0.75, cx, cy, R * 1.45);
      g.addColorStop(0, 'rgba(210,222,240,0)');
      g.addColorStop(0.5, `rgba(210,222,240,${(0.05 + 0.05 * glow) * bright})`);
      g.addColorStop(1, 'rgba(210,222,240,0)');
      ctx.fillStyle = g; ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);

      // conexões (estáticas: a relação existe; tráfego só aparece nos pulsos de eventos reais)
      const pos = {}; const cr = cv.getBoundingClientRect(); // posição real dos nós no DOM (acompanha transições)
      nds.forEach((n) => { const el = document.getElementById(`node-${n.id}`); if (!el) return; const r = el.getBoundingClientRect(); pos[n.id] = { x: r.left + r.width / 2 - cr.left, y: r.top + r.height / 2 - cr.top, s: n.state }; });
      pos.core = { x: cx, y: cy, s: 'live' };
      const geom = (a, b) => {
        const A = pos[a], B = pos[b];
        if (a === 'core' || b === 'core') {
          const o = a === 'core' ? B : A, dx = o.x - cx, dy = o.y - cy, d = Math.hypot(dx, dy) || 1;
          const p0 = { x: cx + (dx / d) * R * 1.05, y: cy + (dy / d) * R * 1.05 };
          return a === 'core' ? [p0, null, B] : [A, null, p0];
        }
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        return [A, { x: mx + (mx - cx) * 0.55, y: my + (my - cy) * 0.55 }, B];
      };
      const at = ([p, q, r], t) => (q
        ? { x: (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * q.x + t * t * r.x, y: (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * q.y + t * t * r.y }
        : { x: p.x + (r.x - p.x) * t, y: p.y + (r.y - p.y) * t });
      for (const [a, b] of lks) {
        if (!pos[a] || !pos[b]) continue;
        const key = `${a}-${b}`;
        hi[key] = approach(hi[key] || 0, sel && (a === sel || b === sel) ? 1 : 0, 8, dt);
        const gm = geom(a, b), H = hi[key];
        const err = pos[a].s === 'error' || pos[b].s === 'error';
        const isLive = LIVE.has(pos[a].s) && LIVE.has(pos[b].s);
        const pending = wait > 0 && (a === 'gate' || b === 'gate') && (a === 'core' || b === 'core');
        ctx.save();
        ctx.lineWidth = 1 + 0.8 * H;
        ctx.strokeStyle = err ? `rgba(229,83,75,${0.5 + 0.4 * H})`
          : pending ? `rgba(212,167,44,${0.65 + 0.3 * H})`
          : isLive ? `rgba(200,208,217,${0.28 + 0.5 * H})` : `rgba(139,148,158,${0.2 + 0.4 * H})`;
        if (!isLive && !err) ctx.setLineDash([3, 6]);
        ctx.beginPath(); ctx.moveTo(gm[0].x, gm[0].y);
        if (gm[1]) ctx.quadraticCurveTo(gm[1].x, gm[1].y, gm[2].x, gm[2].y); else ctx.lineTo(gm[2].x, gm[2].y);
        ctx.stroke();
        ctx.restore();
      }

      // partículas
      const ca = Math.cos(rot), sa = Math.sin(rot), tilt = 0.35 + tiltY, ct = Math.cos(tilt), st = Math.sin(tilt);
      const amp = run ? 0.2 : 0.14, n = SPARKS + Math.max(1500, Math.floor(Math.min(N - SPARKS, Math.max(4500, R0 * R0 * 0.2)) * q)); // faíscas internas sempre; só a casca escala com a qualidade
      cnt.fill(0);
      for (let i = 0; i < n; i++) {
        const x = base.x[i], y = base.y[i], z = base.z[i];
        const d = 1 + amp * (Math.sin(2.3 * x + 1.7 * y + time * 0.35) + 0.8 * Math.sin(3.1 * y - 2.1 * z + time * 0.3) + 0.6 * Math.sin(2.7 * z + 1.3 * x - time * 0.24)) / 2.4;
        let r = d * base.s[i];
        const spark = i < SPARKS;
        if (spark) r *= 1 + 0.12 * Math.sin(time * 0.7 + base.ph[i]); // deriva interna lenta
        const X = x * r, Y = y * r, Z = z * r;
        const x1 = X * ca + Z * sa, z1 = -X * sa + Z * ca;
        const x2 = x1 * Math.cos(tiltX) + z1 * Math.sin(tiltX), z2a = -x1 * Math.sin(tiltX) + z1 * Math.cos(tiltX);
        const y2 = Y * ct - z2a * st, z2 = Y * st + z2a * ct;
        const k = 3 / (3 - z2 * 0.8);
        px[i] = cx + x2 * R * k; py[i] = cy + y2 * R * k;
        let b;
        if (spark) b = Math.floor(BUCKETS * (0.38 + 0.14 * (0.5 + 0.5 * Math.sin(time * 1.1 + base.ph[i])))); // cintilar contínuo
        else {
          const rho = Math.hypot(x2, y2); // limbo mais brilhante, centro escuro
          const wave = 0.22 * Math.sin(1.6 * x + 1.2 * y - time * 0.5);
          b = Math.max(0, Math.min(BUCKETS - 1, Math.floor((rho * 3.6 - 1 + wave) * (BUCKETS / 4))));
        }
        pb[i] = b; cnt[b + 1]++;
      }
      for (let b = 0; b < BUCKETS; b++) cnt[b + 1] += cnt[b];
      const fill = cnt.slice(0, BUCKETS);
      for (let i = 0; i < n; i++) order[fill[pb[i]]++] = i;
      ctx.fillStyle = '#e8edf2';
      const sz = (1.0 + R / 420) * (1 + (1 - q) * 0.3); // menos partículas: um pouco maiores e mais brilhantes
      const comp = Math.min(1.3, Math.pow(1 / q, 0.3));
      for (let b = 0, s = 0; b < BUCKETS; b++) {
        const e = cnt[b + 1];
        ctx.globalAlpha = Math.min(1, (0.12 + (b / (BUCKETS - 1)) * 0.78 + (run ? 0.06 : 0)) * bright * comp);
        for (; s < e; s++) { const i = order[s]; ctx.fillRect(px[i], py[i], sz, sz); }
      }
      ctx.globalAlpha = 1;

      if (wait > 0 || run) {
        ctx.strokeStyle = wait > 0 ? 'rgba(212,167,44,.5)' : 'rgba(76,141,255,.5)';
        ctx.setLineDash([2, 7]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }

      // pulsos de eventos reais
      const list = pulses.current;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i], t = (now - p.t0) / (p.ring || p.inward ? 2000 : 1800);
        if (t >= 1 || still) { list.splice(i, 1); continue; }
        const e = t * t * (3 - 2 * t);
        const a = (p.soft ? 0.35 : 0.65) * (1 - t);
        if (p.ring || p.inward) {
          ctx.strokeStyle = `rgba(${p.color},${a})`; ctx.lineWidth = p.inward ? 1.6 : 1;
          ctx.beginPath(); ctx.arc(cx, cy, R * (p.inward ? 1.5 - 0.45 * e : 1.05 + 0.4 * e), 0, Math.PI * 2); ctx.stroke();
        }
        if (p.link && pos[p.link[0]] && pos[p.link[1]]) {
          const gm = geom(p.link[0], p.link[1]);
          for (let d = 0; d < 3; d++) { // três pontos em fila, cada um com rastro curto
            const head = e - d * 0.11;
            if (head < 0 || head > 1) continue;
            for (let k = 0; k < 3; k++) {
              const q = at(gm, Math.max(0, head - k * 0.025));
              ctx.fillStyle = `rgba(${p.color},${(1 - t * 0.6) * (1 - k * 0.3)})`;
              ctx.beginPath(); ctx.arc(q.x, q.y, 2.8 - k * 0.7, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }
      cv.dataset.pulses = String(list.length); cv.dataset.frames = String(frames); cv.dataset.ms = (performance.now() - t0).toFixed(1); cv.dataset.q = q.toFixed(2); cv.dataset.n = String(n);
      if (!still) raf = requestAnimationFrame(frame);
    }
    redraw.current = still ? () => frame(performance.now()) : null;

    const onMove = (ev) => {
      const r = cv.getBoundingClientRect();
      tx = ((ev.clientX - r.left) / r.width - 0.5) * 0.5; ty = ((ev.clientY - r.top) / r.height - 0.5) * 0.3;
    };
    const onLeave = () => { tx = 0; ty = 0; };
    const onDown = () => { pulses.current.push({ ring: true, soft: true, color: GREY, t0: performance.now() }); };
    const onVis = () => { last = performance.now(); }; // evita salto de tempo ao voltar para a aba
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cv);
    if (!still) {
      cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerleave', onLeave); cv.addEventListener('pointerdown', onDown);
      document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(frame);
    }
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); redraw.current = null;
      cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerleave', onLeave); cv.removeEventListener('pointerdown', onDown);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [still]);

  return <canvas ref={canvas} className="core-canvas" aria-hidden="true" />;
}
