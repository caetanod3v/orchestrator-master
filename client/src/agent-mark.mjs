// Ícone de AGENTE em pixel art (um bichinho de terminal: antenas, cabeça e pernas) usado à esquerda de cada tópico na sidebar. É distinto do maestro da marca (brand-mark.mjs):
// a marca aparece uma vez; este aparece por linha e leva a cor do estado (verde saudável, amarelo trabalhando, âmbar aguardando, vermelho falha, cinza parado).
// X = pixel cheio, . = vazio. 8x8 células: com 16 px (2 px por célula) o desenho fica nítido.
export const AGENT_GRID = [
  'X......X',
  '.X....X.',
  '..XXXX..',
  '.XXXXXX.',
  'XX.XX.XX',
  '.XXXXXX.',
  '..X..X..',
  '.X....X.',
];
export const AGENT_SIZE = 8;

/** Caminho SVG (um quadrado 1x1 por pixel cheio). */
export function agentPath() {
  let d = '';
  AGENT_GRID.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'X') d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}
