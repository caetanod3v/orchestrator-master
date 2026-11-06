// Transição AI Dev Orchestrator -> FORGE no MCP: o nome do servidor de uma instalação EXISTENTE (`orchestrator_<hex>`, citado no histórico das sessões retomadas e na
// pré-autorização --allowedTools) é preservado; instalações novas recebem `forge_<hex>`. Só diretórios temporários.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcpname-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const M = await import('../maestro.js');
const { claudeProvider } = await import('../providers/claude.js');
const { MCP_CATALOG, SKILLS } = await import('../loadouts.js');
const { ROLES } = await import('../terminals.js');

const SID = '00000000-0000-4000-8000-000000000001';

test('instalação existente: o nome orchestrator_<hex> é PRESERVADO (nada é regravado nem girado)', () => {
  const db = { mcpServerName: 'orchestrator_ab12cd' }; let saves = 0;
  assert.equal(M.stableServerName(db, { save: () => { saves++; } }), 'orchestrator_ab12cd');
  assert.equal(db.mcpServerName, 'orchestrator_ab12cd'); assert.equal(saves, 0);
});

test('instalação já no formato novo: forge_<hex> também é preservado', () => {
  const db = { mcpServerName: 'forge_0f9e8d' }; let saves = 0;
  assert.equal(M.stableServerName(db, { save: () => { saves++; } }), 'forge_0f9e8d'); assert.equal(saves, 0);
});

test('instalação nova: nasce forge_<hex>, é gravada uma vez e fica estável no boot seguinte', () => {
  const db = {}; let saves = 0;
  const a = M.stableServerName(db, { save: () => { saves++; }, gen: () => 'c0ffee' });
  assert.equal(a, 'forge_c0ffee'); assert.equal(db.mcpServerName, a); assert.equal(saves, 1);
  assert.equal(M.stableServerName(db, { save: () => { saves++; } }), a); assert.equal(saves, 1);
});

test('nome previsível ou malformado NÃO é aceito: é substituído por um forge_<hex> aleatório', () => {
  for (const ruim of ['orchestrator', 'forge', 'forge_', 'forge_ZZZZZZ', 'forge_abc', 'forge_abcdef0', 'orchestrator_ABCDEF', 'orchestrator_abcde', 'outro_abc123', 'forge-abc123', '', null, 42, { x: 1 }]) {
    const db = { mcpServerName: ruim };
    const nome = M.stableServerName(db);
    assert.match(nome, /^forge_[0-9a-f]{6}$/, `${JSON.stringify(ruim)} -> ${nome}`);
    assert.notEqual(nome, ruim);
  }
  assert.match(M.stableServerName({}, { gen: () => 'ZZ' }), /^forge_[0-9a-f]{6}$/, 'gerador defeituoso cai no aleatório válido');
});

test('o nome (antigo ou novo) vira a chave do .mcp.json do terminal e o --allowedTools do Claude Code', () => {
  for (const nome of ['orchestrator_ab12cd', 'forge_ab12cd']) {
    const dir = path.join(tmp, `mcp-${nome}`);
    const m = M.createMaestro({ getTerminals: () => [], mcpDir: dir, url: 'http://127.0.0.1:1/mcp', serverName: nome, lockDir: () => {} });
    const { configPath } = m.issue({ terminalId: 'term_aaaaaaaa', role: 'builder' });
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(cfg.mcpServers), [nome]);
    const args = claudeProvider.paneArgs({ mode: 'new', prompt: 'P', label: 'L', sessionId: SID, mcp: { configPath, serverName: m.serverName } });
    assert.equal(args[args.indexOf('--allowedTools') + 1], `mcp__${nome}`, 'a pré-autorização cita exatamente o nome do servidor do pane');
  }
});

test('sem serverName o padrão é "forge" (servidor e provedor concordam)', () => {
  assert.equal(M.SERVER_NAME, 'forge');
  const args = claudeProvider.paneArgs({ mode: 'new', prompt: 'P', label: 'L', sessionId: SID, mcp: { configPath: '/c.json' } });
  assert.equal(args[args.indexOf('--allowedTools') + 1], `mcp__${M.SERVER_NAME}`);
});

test('textos entregues ao agente não citam mais "servidor orchestrator" (o nome real é por instalação) e apontam para o servidor MCP do FORGE', () => {
  for (const [papel, r] of Object.entries(ROLES)) {
    assert.ok(!/servidor orchestrator/i.test(r.prompt), `prompt de ${papel}`);
    if (papel === 'maestro') assert.match(r.prompt, /servidor MCP do FORGE/); else assert.match(r.prompt, /report_done do servidor MCP do FORGE/);
  }
  const textoSkills = JSON.stringify(SKILLS);
  assert.ok(!/servidor orchestrator/i.test(textoSkills)); assert.match(textoSkills, /servidor MCP do FORGE/);
});

test('catálogo informativo de MCPs: id e rótulo FORGE; o id antigo não existe mais', () => {
  assert.deepEqual(Object.keys(MCP_CATALOG), ['forge']);
  assert.equal(MCP_CATALOG.forge.id, 'forge'); assert.equal(MCP_CATALOG.forge.label, 'FORGE (Maestro)'); assert.equal(MCP_CATALOG.forge.builtin, true);
});
