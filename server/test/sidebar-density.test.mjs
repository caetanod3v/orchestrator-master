// Sidebar compacta: só padding, gap e altura mínima (sem margens negativas nem posicionamento artificial); o logo, o botão "+" e a área clicável dos itens não mudam. Guarda estática; a medição foi feita no navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../../client/src/retro.css', import.meta.url), 'utf8');
const block = css.slice(css.indexOf('/* ---------- Sidebar compacta'));

test('compactação por espaçamento estrutural: padding, gap e min-height', () => {
  assert.match(block, /\.oc-side \{ padding: var\(--sp-2\) var\(--sp-3\); gap: var\(--sp-1\); \}/);
  assert.match(block, /\.oc-side-head \{ min-height: 32px; \}/, 'a altura do cabeçalho é a do logo (32 px)');
  assert.match(block, /\.oc-side-title \{ min-height: 26px; padding: var\(--sp-1\) var\(--sp-1\) 0 var\(--sp-2\); align-items: center; \}/);
  assert.match(block, /\.oc-side\.collapsed \.oc-side-head \{ gap: var\(--sp-1\); \}/, 'recolhida também compacta');
});

test('sem artifícios e sem mexer no que não é espaçamento', () => {
  assert.doesNotMatch(block, /margin-top: -|margin: -|position: absolute|translate|transform/, 'sem margens negativas nem deslocamentos');
  assert.doesNotMatch(block, /(?<!min-)(?<!max-)width:|(?<!min-)(?<!max-)height:|font-size|\.oc-env\b|\.oc-plus|\.oc-brand svg/, 'tamanhos do logo, do "+" e dos itens (área clicável) ficam como estão');
});
