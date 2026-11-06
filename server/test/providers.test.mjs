// Provedores de agentes (server/providers): o adaptador do Claude Code gera EXATAMENTE os argumentos de sempre, o registro rejeita ids estranhos e o gerenciador de
// terminais grava o provedor na sessão, no histórico e na API. PTY SIMULADO (nenhum Claude real), banco em memória, ORCH_DATA_DIR temporário.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prov-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const P = await import('../providers/index.js');
const { claudeProvider, resolveClaude } = await import('../providers/claude.js');
const T = await import('../terminals.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SID = '00000000-0000-4000-8000-000000000001', OLD = '00000000-0000-4000-8000-000000000002';
const mcp = { configPath: '/tmp/x/mcp.json', serverName: 'orchestrator_abc123' };

test('registro: o padrão é o Claude Code; id desconhecido ou perigoso lança; sem id vale o padrão (sessões antigas)', () => {
  assert.equal(P.DEFAULT_PROVIDER, 'claude'); assert.deepEqual(P.providerIds(), ['claude']);
  assert.equal(P.getProvider(), claudeProvider); assert.equal(P.getProvider('claude'), claudeProvider); assert.equal(P.getProvider(undefined), claudeProvider);
  for (const bad of ['codex', '', 'CLAUDE', '__proto__', 'constructor', 'toString', null, 7, {}]) { assert.equal(P.isProvider(bad), false, String(bad)); if (bad !== undefined) assert.throws(() => P.getProvider(bad), /Provedor desconhecido/); }
  assert.ok(Object.isFrozen(claudeProvider));
});

test('claude.paneArgs: new, resume e fork geram os MESMOS argumentos de antes (com e sem MCP)', () => {
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'new', prompt: 'PAPEL', label: 'Construtor 1', sessionId: SID }), ['--append-system-prompt', 'PAPEL', '--name', 'Construtor 1', '--session-id', SID]);
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'new', prompt: 'PAPEL', label: 'L', sessionId: SID, mcp }),
    ['--append-system-prompt', 'PAPEL', '--name', 'L', '--session-id', SID, '--mcp-config', '/tmp/x/mcp.json', '--allowedTools', 'mcp__orchestrator_abc123']);
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'resume', sessionId: SID, resumeSessionId: OLD }), ['--resume', OLD]);
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'resume', sessionId: SID, resumeSessionId: OLD, mcp }), ['--resume', OLD, '--mcp-config', '/tmp/x/mcp.json', '--allowedTools', 'mcp__orchestrator_abc123']);
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'fork', sessionId: SID, resumeSessionId: OLD }), ['--resume', OLD, '--fork-session', '--session-id', SID]);
  assert.deepEqual(claudeProvider.paneArgs({ mode: 'new', prompt: 'P', label: 'L', sessionId: SID, mcp: { configPath: '/c.json' } }).slice(-1), ['mcp__orchestrator'], 'sem serverName vale o nome padrão');
});

test('claude.resolve: acha o `claude` no PATH, ignora diretórios sem ele e o terminals.js continua exportando resolveClaude', () => {
  const dir = path.join(tmp, 'bin'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
  assert.deepEqual(resolveClaude({ env: { PATH: [path.join(tmp, 'vazio'), dir].join(path.delimiter) }, platform: 'linux' }), { file: path.join(dir, 'claude'), args: [], viaShell: false });
  assert.equal(resolveClaude({ env: { PATH: path.join(tmp, 'vazio') }, platform: 'linux' }), null);
  assert.equal(T.resolveClaude, resolveClaude); assert.equal(claudeProvider.resolve, resolveClaude);
});

function world() {
  const spawned = []; let pid = 1_900_000_000, n = 0;
  const lib = { spawn(file, args, opts) { const p = { pid: ++pid, file, args, opts, onData() {}, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, exit(code = 0) { p.exitCb({ exitCode: code }); } }; spawned.push(p); return p; } };
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws, { recursive: true });
  const db = { settings: { activeWorkspaceId: 'ws1' }, workspaces: [{ id: 'ws1', name: 'W', path: ws }], worktrees: [], topics: [] };
  const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: '/fake/claude', args: [], viaShell: false }), killTree: () => {}, waitFor: () => true,
    newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0,
    usage: { read: () => null, has: () => true, forget() {} }, persist: () => {} });
  return { spawned, db, mgr };
}

test('terminais: a sessão, o registro, o histórico e a API trazem provider "claude"; a CLI recebe os argumentos do adaptador', async () => {
  const w = world(); const r = await w.mgr.create({ role: 'builder' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.session.provider, 'claude'); assert.equal(w.db.terminalSessions[0].provider, 'claude');
  assert.equal(w.mgr.history()[0].provider, 'claude'); assert.equal(w.mgr.list()[0].provider, 'claude'); assert.equal(w.mgr.get(r.session.id).provider, 'claude');
  const args = w.spawned[0].args; assert.equal(args[0], '--append-system-prompt'); assert.ok(args.includes('--session-id') && args.includes('--name'));
  assert.ok(!args.includes('--resume'));
});

test('terminais: sessão ANTIGA (sem o campo provider) é lida como claude e retomada com --resume', async () => {
  const w = world(); const r = await w.mgr.create({ role: 'builder' });
  w.spawned[0].exit(0); delete w.db.terminalSessions[0].provider; // simula o registro gravado antes de existir o campo
  assert.equal(w.mgr.history()[0].provider, 'claude');
  const again = await w.mgr.resume({ recordId: w.db.terminalSessions[0].id });
  assert.equal(again.ok, true, again.error); assert.equal(again.session.provider, 'claude');
  assert.deepEqual(w.spawned[1].args.slice(0, 2), ['--resume', w.db.terminalSessions[0].claudeSessionId]);
  assert.equal(r.session.provider, 'claude');
});
