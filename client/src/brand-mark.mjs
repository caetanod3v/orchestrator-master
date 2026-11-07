// Marca do FORGE: o Elmo em Chamas, um capacete de cavaleiro preto em pixel art (cúpula redonda, testa com rebites e gema, aba da sobrancelha, viseira em brasa, bochechas e queixo em V), com fogo saindo da cabeça e dos olhos.
// Fonte ÚNICA: a interface (Sidebar, animada por brand-motion.mjs), o favicon e o ícone do app desktop saem destas grades. Grade de 14x14 células dentro de uma caixa de 16x16 (PAD = 1): 16, 32, 48, 64, 128 e 256 px dão sempre um número INTEIRO de pixels por célula.
// Paleta preto e vermelho: K = preto (moldura do visor), D = sombra, G/H/L = armadura (chapa, realce, brilho da borda esquerda e rebites), R/E/O/Y = fogo e brasa (vermelho escuro, vermelho, laranja, amarelo). Só o fogo tem cor viva.
export const PALETTE = { K: '#0b0405', D: '#1d1417', G: '#33262b', H: '#4d3b42', L: '#7d626b', R: '#8a1f12', E: '#c63d1b', O: '#f2922a', Y: '#ffd36b' };
export const COLORS = Object.keys(PALETTE);
export const PAD = 1;
export const BOX = 16;
export const SIZE = 14; // lado da grade
export const HELM_TOP = 3; // o capacete ocupa as linhas 3 a 13; o fogo da cabeça, as linhas 0 a 3 (a base se esconde atrás da cúpula)
export const VISOR_Y = 6;  // linha de cima dos olhos (a parte de cima de cada olho); a de baixo fica em VISOR_Y + 1

/**
 * Capacete (linhas 3 a 13). Cúpula redonda (4, 8 e 10 células de largura: o contorno de um círculo), testa curta com rebites (L) e uma gema que acende com o calor, e logo abaixo os OLHOS, no alto do rosto:
 * dois olhos separados e inclinados para dentro (bravos), cada um com 2 células em cima (v, a parte de fora, mais alta) e 2 embaixo (u, a parte de dentro, mais baixa), num encaixe preto (K) e com um vão escuro no meio (a ponte do nariz).
 * Embaixo dos olhos, a borda de apoio (H), as bochechas com realce diagonal (H) à esquerda, costura escura (D) à direita e fendas de ventilação (K), a fenda vertical do rosto (D) e a mandíbula que afina em V até o queixo, com o protetor de pescoço (D).
 * v e u são trocados pela cor do brilho do olho (ver VISOR); no resto, K = encaixe dos olhos e ventilação, L = brilho da borda esquerda e rebites, H = realce, G = chapa, D = sombra.
 */
const HELM = [
  '.....LHHD.....',
  '...LHHHHGGD...',
  '..LHLGGGGLGD..',
  '..LvvKKKKvvD..',
  '..LKuuKKuuKD..',
  '..LHHHHHHHHD..',
  '..LHGGDDGGDD..',
  '..LHGKDDKGDD..',
  '...LHGDDGDD...',
  '....LHDDDD....',
  '...DDDDDDDD...',
];

/** Brilho dos olhos por nível: [fora, dentro]. 0 = repouso (já com brasa acesa, vermelho-alaranjado), 1 = repouso respirando / começando a esquentar, 2 = quente, 3 = ao rubro. -1 = olhos apagados (piscando). */
export const VISOR = [['E', 'R'], ['O', 'R'], ['O', 'E'], ['Y', 'O']];

/** Fogo da cabeça (linhas 0 a 3), sobre a cúpula: baixo (repouso), médio e alto com miolo amarelo (trabalhando); o espalhamento do fogo fica por conta das faíscas (brand-motion.mjs); cada um com três inclinações (A reta, B para a esquerda, C para a direita). E = borda, O = corpo, Y = miolo. A linha 3 fica atrás da cúpula (só as pontas das chamas altas aparecem nas laterais dela). */
export const PLUMES = {
  calmA: ['..............', '......E.......', '.....EOE......', '..............'],
  calmB: ['..............', '.....E........', '.....EOE......', '..............'],
  calmC: ['..............', '.......E......', '.....EOE......', '..............'],
  midA: ['......E.......', '.....EOE......', '....EEOOE.....', '..............'],
  midB: ['.....E........', '.....EOE......', '....EEOOE.....', '..............'],
  midC: ['.......E......', '.....EOE......', '....EEOOE.....', '..............'],
  hotA: ['......E.......', '.....EOE......', '....EOYOE.....', '....E....E....'],
  hotB: ['.....E........', '....EOE.......', '...EOYOE......', '...E....E.....'],
  hotC: ['.......E......', '......EOE.....', '.....EOYOE....', '.....E....E...'],
};

export const GEM = [[6, 5], [7, 5]];            // gema da testa (2 células, entre os rebites)
export const GEM_COLOR = ['R', 'E', 'O', 'Y'];  // por nível de fogo: brasa fraca até o amarelo

/**
 * Chamas dos olhos, por nível de fogo (0 a 3): sempre uma chama pequena sobre o canto de fora de cada olho, que cresce com o calor mas nunca chega à chama da cabeça (no máximo 2 células de altura).
 * Nível 0 (repouso): só a base, uma brasa-chama que oscila entre vermelho e vermelho vivo; 1: base e uma língua curta que treme; 2: base, língua e uma fagulha que pula para fora; 3: o mesmo, com a base alargada.
 * `flick` (0/1) faz tremular. Células [x, y, cor].
 */
export function eyeFlames(fire, flick) {
  const out = [];
  for (const [x, inner, side] of [[3, 4, 2], [10, 9, 11]]) {
    out.push([x, VISOR_Y - 1, fire === 0 ? (flick ? 'E' : 'R') : fire >= 2 ? 'O' : 'E']);                 // base: uma célula logo acima do olho
    if (fire === 1) out.push([flick ? x : inner, VISOR_Y - 2, 'R']);                                      // língua curta que treme
    if (fire >= 2) { out.push([x, VISOR_Y - 2, 'E']); out.push(flick ? [side, VISOR_Y - 1, 'R'] : [inner, VISOR_Y - 2, 'R']); } // corpo + fagulha que pula para fora
    if (fire >= 3) out.push([inner, VISOR_Y - 1, flick ? 'E' : 'R']);                                     // base alargada
  }
  return out;
}

/**
 * Pose (mapa "x,y" -> cor): fogo da cabeça + capacete com o visor no nível `visor` (-1 = apagado, piscando). `fire` (0 a 3) é o nível de fogo do conjunto: tinge o topo da cúpula
 * (nível 2 vermelho escuro; nível 3 vermelho), acende a gema e acende as chamas dos olhos (sempre há uma pequena, mesmo em repouso). `flick` (0/1) faz as chamas tremularem.
 */
export function pose({ plume = 'calmA', visor = 0, fire = Math.max(0, visor), flick = 0 } = {}) {
  const cells = new Map();
  const put = (x, y, c) => { if (c !== '.') cells.set(`${x},${y}`, c); };
  PLUMES[plume].forEach((row, y) => [...row].forEach((c, x) => put(x, y, c)));
  HELM.forEach((row, i) => [...row].forEach((c, x) => put(x, HELM_TOP + i, c === 'v' ? (visor < 0 ? 'K' : VISOR[visor][0]) : c === 'u' ? (visor < 0 ? 'K' : VISOR[visor][1]) : c)));
  if (fire >= 2) for (let x = 5; x <= 8; x++) put(x, HELM_TOP, fire >= 3 ? 'E' : 'R');
  for (const [x, y, c] of eyeFlames(fire, flick)) put(x, y, c);
  for (const [x, y] of GEM) put(x, y, GEM_COLOR[fire]);
  return cells;
}

/** Brasas do ícone estático: [x, y, cor]. */
export const STATIC_EMBERS = [[1, 3, 'O'], [12, 3, 'Y'], [7, 0, 'R'], [0, 1, 'E']];
const STATIC = { plume: 'hotA', visor: 3, fire: 3, flick: 0 };
function staticCells() {
  const cells = pose(STATIC);
  for (const [x, y, c] of STATIC_EMBERS) cells.set(`${x},${y}`, c);
  return cells;
}
/** Grade estática (ícone, favicon): fogo alto na cabeça, visor ao rubro e algumas brasas. */
export const GRID = (() => {
  const cells = staticCells();
  return Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => cells.get(`${x},${y}`) ?? '.').join(''));
})();

/** Caminho SVG (um quadrado 1x1 por pixel) de cada cor, a partir de um mapa de células. */
export function cellPaths(cells) {
  const out = Object.fromEntries(COLORS.map((k) => [k, '']));
  for (const [key, c] of cells) { const [x, y] = key.split(',').map(Number); if (out[c] !== undefined) out[c] += `M${x + PAD} ${y + PAD}h1v1h-1z`; }
  return out;
}

/** Caminhos da grade estática. */
export function pixelPaths() { return cellPaths(staticCells()); }

/** SVG completo da marca (ladrilho escuro de cantos arredondados). Usado no favicon e no ícone do desktop. */
export function markSvg({ size = 256, bg = '#0d0807', radius = 3.5 } = {}) {
  const p = pixelPaths();
  const paths = COLORS.filter((k) => p[k]).map((k) => `<path d="${p[k]}" fill="${PALETTE[k]}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}" shape-rendering="crispEdges"><rect width="${BOX}" height="${BOX}" rx="${radius}" fill="${bg}"/>${paths}</svg>`;
}
