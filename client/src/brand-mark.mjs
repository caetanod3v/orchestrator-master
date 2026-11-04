// Marca do Orchestrator: um maestro em pixel art (cabeça branca, olhos em fendas, bastão azul escuro). Fonte ÚNICA: a interface (Sidebar), o favicon e o ícone do app desktop saem desta grade.
// X = branco, C = acento azul escuro (o bastão), . = vazio. O desenho é o mesmo de sempre (14x13 células), só recortado rente e centrado numa caixa de 16x16:
// com 16 células por lado, 16, 32, 48, 64, 128 e 256 px dão sempre um número INTEIRO de pixels por célula (antes eram 20 células e 16 px davam 0,8 px: borrava).
export const GRID = [
  '.............C',
  '............C.',
  '...........C..',
  '..........C...',
  'XXXXXXXXXX....',
  'XXXXXXXXXX....',
  'XXX.XXXX.X....',
  'XXX.XXXX.X....',
  'XXXXXXXXXX....',
  'XXXXXXXXXX....',
  '.XXXXXXXX.....',
  '..XXXXXX......',
  '..XX..XX......',
];
export const PAD = 1;
export const BOX = 16;

/** Caminho SVG (um quadrado 1x1 por pixel) de cada cor. */
export function pixelPaths() {
  const out = { X: '', C: '' };
  GRID.forEach((row, y) => [...row].forEach((ch, x) => { if (out[ch] !== undefined) out[ch] += `M${x + PAD} ${y + PAD}h1v1h-1z`; }));
  return { white: out.X, accent: out.C };
}

/** SVG completo da marca (ladrilho preto de cantos arredondados). Usado no favicon e no ícone do desktop. */
export function markSvg({ size = 256, bg = '#000', white = '#fff', accent = '#1d4ed8', radius = 3.5 } = {}) {
  const p = pixelPaths();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}" shape-rendering="crispEdges"><rect width="${BOX}" height="${BOX}" rx="${radius}" fill="${bg}"/><path d="${p.white}" fill="${white}"/><path d="${p.accent}" fill="${accent}"/></svg>`;
}
