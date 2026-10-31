// Configuração CENTRAL do universo espacial do Cockpit (palco atrás do grafo). Nenhum outro módulo tem "número mágico" de cena.
// Unidades de mundo arbitrárias: a câmera fica na origem olhando para -Z; as estrelas ficam entre `near` e `far`.

export const UNIVERSE = Object.freeze({
  seed: 0x5eed1e,
  fov: 50, // graus (vertical)
  near: 1, far: 400,
  // razão de aspecto de PROJETO do campo: as estrelas são geradas para preencher até 2,6:1 e reescaladas na horizontal conforme o canvas real (o campo não é regerado ao redimensionar)
  designAspect: 2.6,
  // três faixas de profundidade, cada uma com seu tamanho, brilho e velocidade relativa
  layers: Object.freeze([
    { id: 'far', share: 0.58, depth: [130, 300], size: [0.6, 1.1], bright: [0.3, 0.7], drift: [0.85, 1.0] },
    { id: 'mid', share: 0.34, depth: [55, 130], size: [0.9, 1.7], bright: [0.4, 0.85], drift: [0.9, 1.1] },
    { id: 'near', share: 0.08, depth: [18, 55], size: [1.5, 2.8], bright: [0.6, 1.0], drift: [1.0, 1.25] },
  ]),
  // deriva em unidades de mundo por segundo (muito lenta): lateral, vertical e em direção à câmera. A paralaxe vem da perspectiva real (mesma velocidade, distâncias diferentes).
  drift: Object.freeze({ x: 0.16, y: -0.04, z: 0.3 }),
  twinkle: Object.freeze({ rate: [0.12, 0.55], depth: 0.2 }), // rad/s, desincronizado por estrela; profundidade da variação de brilho (0..1)
  sizeRef: 70, // profundidade de referência do tamanho aparente do ponto
  fps: 30, // teto de quadros por segundo da deriva (é lenta: 30 já é fluido e custa metade da GPU)
  staticTime: 90, // instante (s) em que a cena começa (campo já "em andamento")
  tint: Object.freeze({ warm: [1.0, 0.96, 0.9], cool: [0.8, 0.89, 1.0] }),
  // níveis de qualidade: partículas e teto de pixel ratio
  quality: Object.freeze({
    high: { count: 6400, dpr: 2 },
    medium: { count: 3800, dpr: 1.5 },
    low: { count: 1900, dpr: 1 },
  }),
});

export const QUALITY_KEY = 'universe-quality'; // localStorage: 'high' | 'medium' | 'low' | 'off' (preferência/diagnóstico; 'off' mostra só o fundo estático)

/**
 * Escolhe o nível de qualidade a partir de sinais do dispositivo (função pura, testável).
 * `override`: valor salvo pelo usuário (vence tudo). `softwareRenderer`: WebGL por software (SwiftShader/llvmpipe) => baixo.
 */
export function pickQuality({ override, cores, memory, width, softwareRenderer, saveData } = {}) {
  if (override === 'off') return 'off';
  if (override && UNIVERSE.quality[override]) return override;
  if (softwareRenderer || saveData) return 'low';
  if ((cores && cores <= 2) || (memory && memory <= 2)) return 'low';
  if ((cores && cores <= 4) || (memory && memory <= 4) || (width && width < 700)) return 'medium';
  return 'high';
}
