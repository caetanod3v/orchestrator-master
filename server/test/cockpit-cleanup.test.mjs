// Cockpit limpo: Maestro e Worktrees saíram da área principal e continuam acessíveis (Configurações e botão contextual). Guarda estática do código-fonte do cliente (sem navegador).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (f) => fs.readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');
const grid = src('components/TerminalGrid.jsx'), settings = src('components/SettingsDialog.jsx'), pop = src('components/MaestroPopover.jsx'), ctrl = src('components/MaestroControls.jsx'), app = src('App.jsx');

test('o cockpit não renderiza mais as barras permanentes do Maestro e dos Worktrees', () => {
  assert.doesNotMatch(grid, /function MaestroPanel|<MaestroPanel/);
  assert.doesNotMatch(grid, /className="tg-wt"|Worktrees dos terminais|<WorktreePanel/);
  assert.match(grid, /<MaestroPopover/, 'o Maestro continua acessível pelo botão contextual da barra de terminais');
});

test('Configurações > Orquestração > Maestro Autônomo e Workspaces e Worktrees existem e usam os componentes de sempre (sem duplicar funcionalidade)', () => {
  assert.match(settings, /\['orquestracao', 'Orquestração'/); assert.match(settings, /\['worktrees', 'Workspaces e Worktrees'/);
  assert.match(settings, /Maestro Autônomo/); assert.match(settings, /<MaestroControls/); assert.match(settings, /<WorktreePanel terminals/);
  assert.match(settings, /Todos os workspaces/, 'a tela separa o workspace aberto de todos os workspaces');
});

test('o controle do modo autônomo mantém a confirmação e a mesma rota; só ele liga/desliga (o painel contextual apenas aponta para as configurações)', () => {
  assert.match(ctrl, /window\.confirm\(aviso\)/); assert.match(ctrl, /\/api\/maestro\/autonomy/);
  assert.doesNotMatch(pop, /\/api\/maestro\/autonomy/);
  assert.match(pop, /onOpenSettings\?\.\('orquestracao'\)/);
});

test('aprovações pendentes nunca ficam escondidas: contador no botão, painel abre sozinho com tarefa nova, aprovar/recusar no painel; autônomo ligado sempre sinalizado', () => {
  assert.match(pop, /mpo-n warn/); assert.match(pop, /setOpen\(true\)/);
  assert.match(pop, /tasks\/\$\{t\.id\}\/approve/); assert.match(pop, /tasks\/\$\{t\.id\}\/reject/);
  assert.match(pop, /mpo-auto/);
});

test('o botão de engrenagem continua abrindo as Configurações (o evento do clique não vira nome de aba) e o painel do Maestro abre na aba certa', () => {
  assert.match(app, /typeof tab === 'string' \? tab : 'perfil'/); assert.match(app, /<SettingsDialog initial=\{settingsTab\}/); assert.match(app, /onOpenSettings=\{openSettings\}/);
});
