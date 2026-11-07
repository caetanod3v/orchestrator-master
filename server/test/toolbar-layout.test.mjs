// Toolbar de terminais: UMA linha, grupos independentes (esquerda | direita), degraus de largura intencionais. Guardas estáticas do cliente; a medição real foi feita no navegador (760 a 1920 px, sem corte nem sobreposição).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (f) => fs.readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');
const css = src('retro.css'), grid = src('components/TerminalGrid.jsx'), mp = src('components/MaestroPopover.jsx');

test('estrutura: um container flex SEM quebra por padrão; grupos que não encolhem; só o nome do workspace encolhe (reticências); os operacionais vão à direita pelo grupo', () => {
  assert.match(css, /\.tbx \{[^}]*display: flex; flex-wrap: nowrap; align-items: center;/);
  assert.match(css, /\.tbx-g \{[^}]*display: flex; flex: 0 0 auto; align-items: center;/);
  assert.match(css, /\.tbx-end \{ margin-left: auto; \}/, 'o empurrão para a direita é do grupo, nunca de controles avulsos');
  assert.match(css, /\.tbx-g:first-child \.oc-wschip b \{[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.tbx \.(btn|oc-sel|oc-wschip|oc-seg|oc-iso|mpo-btn|tm-btn)[^{]*\{[^}]*(position: absolute|margin-top: -|translate)/, 'nenhum controle é alinhado por deslocamento individual');
  assert.match(css, /\.tbx \.btn, \.tbx \.oc-sel, \.tbx \.oc-wschip, \.tbx \.oc-seg button, \.tbx \.oc-iso, \.tbx \.mpo-btn, \.tbx \.tm-btn \{ height: var\(--tb-h\)/, 'altura única para todo controle');
});

test('degraus de largura: compacto até 760 px (mesma linha) e duas linhas só abaixo de 520 px; só aí o flex-wrap liga', () => {
  const i = css.indexOf('@container (max-width: 760px)'), j = css.indexOf('@container (max-width: 520px)');
  assert.ok(i > 0 && j > i, 'os dois degraus existem, do mais largo para o mais estreito');
  const compact = css.slice(i, j), narrow = css.slice(j);
  assert.match(compact, /\.tbx-l, \.tbx \.oc-total \{ display: none; \}/); assert.match(compact, /\.tbx-s \{ display: inline; \}/);
  assert.doesNotMatch(compact, /flex-wrap: wrap/, 'no modo compacto continua em UMA linha');
  assert.match(narrow, /\.tbx \{ flex-wrap: wrap; \}/);
  assert.equal((css.match(/flex-wrap: wrap/g) ?? []).length >= 1, true);
  assert.equal(/\.tbx \{[^}]*flex-wrap: wrap/.test(css.slice(0, j)), false, 'acima de 520 px nunca quebra');
});

test('texto completo x compacto vem do mesmo controle: Encerrar todos mantém o rótulo acessível; "autônomo" vira "auto" sem sumir; tokens só aparecem com dado real', () => {
  assert.match(grid, /Encerrar<span className="tbx-l"> todos<\/span>/); assert.match(grid, /aria-label="Encerrar todos"/);
  assert.match(mp, /<span className="tbx-l">autônomo<\/span><span className="tbx-s" aria-hidden="true">auto<\/span>/);
  assert.match(grid, /\{total\.panes > 0 && <span className="oc-total"/, 'sem consumo real não se mostra "– tok · –"');
});
