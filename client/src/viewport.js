// Matemática do canvas do Cockpit (funções puras, sem React nem DOM): zoom, enquadramento e navegação.
// Convenção: a "vista" é { x, y, k }. Um ponto do mundo (wx, wy) aparece na tela em (x + wx*k, y + wy*k), em pixels do viewport.

export const ZOOM = Object.freeze({ min: 0.25, max: 2.5, fitMax: 1.3, step: 1.2, readable: 0.6 });

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampZoom = (k, z = ZOOM) => clamp(k, z.min, z.max);

/** Zoom por `factor` mantendo FIXO o ponto (px, py) do viewport (o cursor). */
export function zoomAt(view, factor, px, py, z = ZOOM) {
  const k = clampZoom(view.k * factor, z);
  const r = k / view.k;
  return { k, x: px - (px - view.x) * r, y: py - (py - view.y) * r };
}

/** Fator de zoom de um evento de roda: pequeno por tique do mouse, bem menor em gestos de pinça do trackpad (ctrlKey). */
export function wheelFactor({ deltaY = 0, deltaMode = 0, ctrlKey = false }) {
  let d = deltaY;
  if (deltaMode === 1) d *= 16; else if (deltaMode === 2) d *= 100; // linhas / páginas -> pixels
  d = clamp(d, -120, 120);
  return Math.exp(-d * (ctrlKey ? 0.01 : 0.0015));
}

/** Ajusta o conteúdo inteiro ao viewport (com margem), limitado a [min, fitMax]. */
export function fitView(content, size, { pad = 16, maxK = ZOOM.fitMax, z = ZOOM } = {}) {
  if (!(content.w > 0) || !(content.h > 0) || !(size.w > 0) || !(size.h > 0)) return { x: 0, y: 0, k: 1 };
  const k = clamp(Math.min((size.w - 2 * pad) / content.w, (size.h - 2 * pad) / content.h), z.min, Math.min(maxK, z.max));
  return { k, x: (size.w - content.w * k) / 2, y: (size.h - content.h * k) / 2 };
}

/**
 * Enquadramento inicial de uma missão. Grafos que cabem ocupam a área útil (até fitMax). Grafos grandes não encolhem até ficar ilegíveis:
 * param em `readable` e ficam alinhados ao topo (a raiz do grafo), para o usuário navegar a partir dali.
 */
export function initialView(content, size, opts = {}) {
  const z = opts.z || ZOOM, pad = opts.pad ?? 16;
  const fit = fitView(content, size, opts);
  if (fit.k >= z.readable || !(content.w > 0)) return fit;
  const k = z.readable;
  const w = content.w * k;
  return { k, x: w <= size.w - 2 * pad ? (size.w - w) / 2 : pad, y: pad };
}

/** Vista que centraliza `rect` (em coordenadas do mundo) no viewport, opcionalmente com um zoom alvo. */
export function centerOn(rect, size, view, targetK, z = ZOOM) {
  const k = clampZoom(targetK ?? view.k, z);
  return { k, x: size.w / 2 - (rect.x + rect.w / 2) * k, y: size.h / 2 - (rect.y + rect.h / 2) * k };
}

/** `rect` (mundo) aparece inteiro no viewport? */
export function isVisible(rect, size, view, margin = 0) {
  const l = view.x + rect.x * view.k, t = view.y + rect.y * view.k;
  return l >= margin && t >= margin && l + rect.w * view.k <= size.w - margin && t + rect.h * view.k <= size.h - margin;
}

/** Desloca o mínimo necessário para `rect` ficar visível; se não couber, centraliza. Não muda o zoom. */
export function ensureVisible(rect, size, view, margin = 24) {
  if (isVisible(rect, size, view, margin)) return view;
  const w = rect.w * view.k, h = rect.h * view.k;
  const shift = (pos, len, span) => { // deslocamento (em tela) a aplicar neste eixo
    if (len > span - 2 * margin) return span / 2 - (pos + len / 2); // não cabe: centraliza
    if (pos < margin) return margin - pos;
    if (pos + len > span - margin) return span - margin - (pos + len);
    return 0;
  };
  const l = view.x + rect.x * view.k, t = view.y + rect.y * view.k;
  return { k: view.k, x: view.x + shift(l, w, size.w), y: view.y + shift(t, h, size.h) };
}

export const panBy = (view, dx, dy) => ({ k: view.k, x: view.x + dx, y: view.y + dy });

/** Zoom em passos (botões e teclado), em torno do centro do viewport. */
export function stepZoom(view, dir, size, z = ZOOM) {
  return zoomAt(view, dir > 0 ? z.step : 1 / z.step, size.w / 2, size.h / 2, z);
}

export const toWorld = (view, sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });
export const toScreen = (view, wx, wy) => ({ x: view.x + wx * view.k, y: view.y + wy * view.k });

/** Interpolação (0..1) com saída suave, para animar mudanças de vista sem biblioteca. */
export const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;
export const lerpView = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, k: a.k + (b.k - a.k) * t });

/** Valida uma vista lida de armazenamento (nunca confia em dado salvo). */
export function sanitizeView(v, z = ZOOM) {
  if (!v || ![v.x, v.y, v.k].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: v.x, y: v.y, k: clampZoom(v.k, z) };
}

/** Só enquadra sozinho enquanto o usuário não mexeu na vista (nunca sobrescreve zoom/posição manuais). */
export const shouldAutoFrame = ({ touched }) => !touched;
