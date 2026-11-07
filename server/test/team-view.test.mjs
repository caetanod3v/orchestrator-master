// Equipe do workspace: presets, nomes, composição e impacto da troca (client/src/team-view.js) + persistência por workspace no layout (servidor e cliente). PURO.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PRESETS, PRESET_IDS, isPresetId, presetById, missingRoles, extraRoles, changeImpact, inferTeam } from '../../client/src/team-view.js';
import { readLayout, validateLayoutPatch, TEAM_PRESETS } from '../layouts.js';
import { createLayoutSync, sanitizeLayout } from '../../client/src/layout-state.js';

const src = (f) => fs.readFileSync(new URL(`../../client/src/${f}`, import.meta.url), 'utf8');

test('nomes e composição: Dupla 2, Squad 4, Squad de 6 = 6, Construtor 1; ids internos preservados; "Squad de 4" não existe mais', () => {
  assert.deepEqual(PRESETS.map((p) => [p.id, p.label, p.roles.length]), [['duo', 'Dupla', 2], ['squad', 'Squad', 4], ['full', 'Squad de 6', 6], ['builder', 'Construtor', 1]]);
  assert.deepEqual(presetById('squad').roles, ['maestro', 'builder', 'builder', 'reviewer'], 'a composição real do squad não mudou');
  assert.deepEqual(presetById('full').roles, ['maestro', 'scout', 'builder', 'builder', 'builder', 'reviewer']);
  for (const f of ['team-view.js', 'components/TerminalGrid.jsx', 'components/TeamMenu.jsx', 'components/SettingsDialog.jsx']) assert.doesNotMatch(src(f), /Squad de 4/, `${f} ainda cita "Squad de 4"`);
  assert.ok(isPresetId('duo') && !isPresetId('squad4') && !isPresetId(undefined));
});

test('missingRoles/extraRoles: multiconjunto; nunca sugere encerrar', () => {
  assert.deepEqual(missingRoles(['maestro', 'builder', 'builder', 'reviewer'], ['builder', 'reviewer']), ['maestro', 'builder']);
  assert.deepEqual(missingRoles(['builder', 'reviewer'], ['builder', 'builder', 'reviewer', 'scout']), []);
  assert.deepEqual(extraRoles(['builder', 'reviewer'], ['builder', 'builder', 'reviewer', 'scout']), ['builder', 'scout']);
  assert.deepEqual(missingRoles(presetById('duo').roles, []), ['builder', 'reviewer']);
});

test('impacto da troca: informa o que continua rodando e o que será aberto, respeita o limite e só pede confirmação com terminais ativos', () => {
  const label = { maestro: 'Maestro', builder: 'Construtor', reviewer: 'Revisor', scout: 'Batedor' };
  const im = changeImpact({ from: 'duo', to: 'squad', liveRoles: ['builder', 'reviewer'], labelOf: (r) => label[r] ?? r, room: 8 });
  assert.equal(im.needsConfirm, true); assert.deepEqual(im.open, ['maestro', 'builder']);
  assert.match(im.text, /2 terminais ativos continuam rodando: nenhum processo, sessão ou worktree é encerrado/); assert.match(im.text, /Serão abertos 2 terminais novos.*Maestro, Construtor/);
  const tight = changeImpact({ from: 'duo', to: 'full', liveRoles: ['builder', 'reviewer'], room: 1 }); assert.equal(tight.open.length, 1); assert.equal(tight.skipped, 3); assert.match(tight.text, /3 terminais não cabem/);
  assert.equal(changeImpact({ from: null, to: 'duo', liveRoles: [], room: 8 }).needsConfirm, false);
  assert.equal(changeImpact({ from: 'duo', to: 'duo', liveRoles: ['builder', 'reviewer'], room: 8 }).open.length, 0);
  assert.equal(changeImpact({ to: 'nada', liveRoles: [] }), null);
});

test('servidor: a equipe é um campo opcional do layout do workspace, validado por lista fixa; workspaces antigos mantêm o formato de sempre', () => {
  assert.deepEqual(TEAM_PRESETS, PRESET_IDS, 'os ids do servidor e do cliente são os mesmos');
  assert.deepEqual(readLayout({ order: [] }), { order: [], maximized: null, grids: {} }, 'sem equipe: nenhum campo novo aparece');
  assert.equal(readLayout({ team: 'squad' }).team, 'squad'); assert.equal('team' in readLayout({ team: 'hacker' }), false); assert.equal('team' in readLayout({ team: null }), false);
  assert.deepEqual(validateLayoutPatch({ team: 'full' }).patch, { team: 'full' }); assert.deepEqual(validateLayoutPatch({ team: null }).patch, { team: null });
  assert.match(validateLayoutPatch({ team: 'squad de 4' }).error, /team deve ser/); assert.match(validateLayoutPatch({ team: 3 }).error, /team deve ser/);
  assert.match(validateLayoutPatch({ team: 'duo', foo: 1 }).error, /Propriedades não permitidas: foo/);
});

test('cliente: sanitizeLayout mantém só equipe válida; setTeam grava por workspace e um não afeta o outro; limpar e repetir o mesmo valor não gravam à toa', async () => {
  assert.equal(sanitizeLayout({ team: 'duo' }).team, 'duo'); assert.equal('team' in sanitizeLayout({ team: 'x' }), false);
  const puts = [];
  const sync = createLayoutSync({ get: async () => ({ layouts: {} }), put: async (ws, body) => { puts.push([ws, body]); return { layout: { order: [], maximized: null, grids: {}, ...(body.team ? { team: body.team } : {}) } }; }, storage: null, debounceMs: 0, retryMs: 10, setTimer: (fn) => { fn(); return 0; }, clearTimer() {} });
  await sync.load();
  sync.actions.setTeam('wsA', 'squad'); sync.actions.setTeam('wsB', 'duo');
  await sync.flush(); await sync.flush();
  assert.equal(sync.getSnapshot().layouts.wsA.team, 'squad'); assert.equal(sync.getSnapshot().layouts.wsB.team, 'duo');
  assert.deepEqual(puts.map(([w, b]) => [w, b.team]).sort(), [['wsA', 'squad'], ['wsB', 'duo']]);
  const n = puts.length; sync.actions.setTeam('wsA', 'squad'); sync.actions.setTeam('wsA', 'não-existe'); await sync.flush(); assert.equal(puts.length, n, 'mesmo valor ou valor inválido: nada é gravado');
  sync.actions.setTeam('wsA', null); await sync.flush(); assert.equal(puts.at(-1)[1].team, null); assert.equal(sync.getSnapshot().layouts.wsA.team ?? null, null); assert.equal(sync.getSnapshot().layouts.wsB.team, 'duo', 'o outro workspace não foi tocado');
});

test('toolbar: dois grupos num único container (equipe | operacionais), presets só sem equipe, identificação compacta com equipe, + Terminal, Visualização e Histórico fora da barra', () => {
  const g = src('components/TerminalGrid.jsx');
  assert.match(g, /className="oc-bar tbx"/); assert.equal((g.match(/className="tbx-g/g) ?? []).length, 2, 'dois grupos: workspace e equipe | controles operacionais');
  assert.match(g, /hasTeam\s*\n?\s*\? <TeamMenu/); assert.match(g, /tbx-presets/);
  assert.doesNotMatch(g, /Novo terminal<|<Icon name="plus" size=\{14\} \/> Terminal/, 'o + Terminal destacado saiu da barra');
  assert.doesNotMatch(g, /LAYOUT_MODES|oc-seg|aria-label="Histórico"|setHistOpen|<SessionHistory/, 'Grade/Colunas/Linhas/Foco e Histórico saíram da tela principal');
  const menu = src('components/TeamMenu.jsx');
  for (const t of ['Composição atual', 'Alterar preset', 'Adicionar agente ou terminal', 'Redefinir equipe']) assert.match(menu, new RegExp(t));
  assert.match(menu, /aria-label=\{s\.status === 'running' \? `Encerrar/);
  const css = src('retro.css'); assert.match(css, /--tb-h: 24px/); assert.match(css, /@container \(max-width: 760px\)/); assert.match(css, /@container \(max-width: 520px\)/);
});

test('Configurações: Visualização (modo da grade do workspace aberto) e Histórico de sessões moram nas Configurações, com o mesmo controle e o mesmo conteúdo de antes', () => {
  const st = src('components/SettingsDialog.jsx');
  assert.match(st, /\['visualizacao', 'Visualização'/); assert.match(st, /\['historico', 'Histórico de sessões'/);
  assert.match(st, /LAYOUT_MODES\.map/); assert.match(st, /useLayoutMode\(openWs\?\.id\)/); assert.match(st, /<SessionHistoryBody ws=\{openWs\}/);
  assert.match(st, /onAutoRestore=\{setAutoRestore\}/, 'o interruptor da restauração automática continua no histórico');
  assert.match(src('components/TerminalGrid.jsx'), /useLayoutMode\(ws\?\.id\)/, 'o cockpit lê o mesmo modo que as Configurações gravam');
  assert.match(src('components/TerminalGrid.jsx'), /onOpenSettings\?\.\('historico'\)/, 'o botão "Restaurar sessões" do estado vazio leva ao histórico, em Configurações');
});
