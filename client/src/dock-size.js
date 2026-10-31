// Altura da conversa no Cockpit (funções puras): limites, teclado e leitura saneada do valor salvo. Sem React nem DOM.

// min/graphMin: o desejável para a conversa e para o grafo. panelFloor/graphFloor: pisos da degradação em janelas baixas (veja dockLimits).
export const DOCK = Object.freeze({ min: 200, graphMin: 200, panelFloor: 120, graphFloor: 80, step: 24, bigStep: 96, key: 'cockpit-chat-h' });

const num = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Altura padrão (a mesma de antes do divisor): 36% da janela, entre 280 e 420px. */
export const defaultDock = (viewportH) => (num(viewportH) && viewportH > 0 ? clamp(Math.round(viewportH * 0.36), 280, 420) : 320);

/**
 * Limites [min, max] da altura da conversa para o espaço disponível.
 * `room` = altura do contêiner menos tudo que não é o corpo da conversa nem o canvas (cabeçalho da missão, barra, divisor, margens).
 *  - Com espaço: a conversa varia de `min` até o que deixa `graphMin` ao grafo.
 *  - Janela baixa (não cabem os dois mínimos): o GRAFO tem prioridade. A conversa encolhe até `panelFloor` para o grafo manter `graphMin`;
 *    se nem isso couber, o grafo recebe o que sobra, mas nunca menos que `graphFloor` (a conversa cede de novo). Nesse modo min = max (o divisor não ajusta).
 *  - Janela extrema (room menor que graphFloor): a conversa vai a 0 e o grafo fica com todo o espaço; nenhum valor é negativo nem há sobreposição.
 * A preferência salva nunca entra aqui: só o valor efetivo é limitado.
 */
export function dockLimits(room, d = DOCK) {
  if (!num(room)) return { min: d.min, max: d.min };
  const roomy = Math.floor(room - d.graphMin);
  if (roomy >= d.min) return { min: d.min, max: roomy };
  const hi = Math.max(0, Math.min(Math.max(d.panelFloor, roomy), Math.floor(room - d.graphFloor)));
  return { min: hi, max: hi };
}

/** Maior altura da conversa para o espaço disponível (veja dockLimits). */
export const maxDock = (room, d = DOCK) => dockLimits(room, d).max;

/** Valor efetivo: o preferido (ou o padrão) limitado a [min, max]. */
export const clampDock = (h, max, d = DOCK) => clamp(num(h) ? Math.round(h) : d.min, d.min, Math.max(d.min, max));

/** Valor salvo (texto) -> número válido ou null. Nunca confia no armazenamento. */
export function parseDock(raw, d = DOCK) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return num(n) && n >= d.min && n <= 4000 ? Math.round(n) : null;
}

/** Teclado do divisor: a seta para cima aumenta a conversa (o divisor sobe). Retorna a nova altura, ou null se a tecla não é do divisor. */
export function nextDock(h, key, { shift = false, max, def } = {}, d = DOCK) {
  const step = shift ? d.bigStep : d.step;
  const hi = Math.max(d.min, max ?? d.min);
  switch (key) {
    case 'ArrowUp': return clamp(h + step, d.min, hi);
    case 'ArrowDown': return clamp(h - step, d.min, hi);
    case 'PageUp': return clamp(h + d.bigStep, d.min, hi);
    case 'PageDown': return clamp(h - d.bigStep, d.min, hi);
    case 'Home': return d.min;
    case 'End': return hi;
    case 'Enter': return def == null ? null : clamp(def, d.min, hi);
    default: return null;
  }
}
