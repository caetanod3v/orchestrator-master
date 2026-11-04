// Tokens e custo por terminal, lidos do transcript do Claude Code (arquivo temporário; nenhum Claude real, nenhum dado do usuário).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageReader, loadPrices } from '../terminal-usage.js';
import { createTerminalManager } from '../terminals.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-')));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporário */ } });
const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const proj = path.join(tmp, 'projects', 'C--algum-projeto'); fs.mkdirSync(proj, { recursive: true });
const file = path.join(proj, `${SID}.jsonl`);
const line = (id, model, u, type = 'assistant') => JSON.stringify({ type, uuid: `u-${id}-${Math.random()}`, message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_creation_input_tokens: u[2], cache_read_input_tokens: u[3] } } }) + '\n';
const PRICES = { 'claude-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } };

test('lê tokens do transcript, conta cada mensagem UMA vez (linhas repetidas por bloco) e ignora linhas que não são do assistente', () => {
  const r = createUsageReader({ configDir: tmp, prices: PRICES, missMs: 0 });
  assert.equal(r.read(SID), null, 'sem arquivo ainda: null (não zero)');
  fs.writeFileSync(file, line('m1', 'claude-sonnet-5-5', [10, 100, 1000, 2000]) + line('m1', 'claude-sonnet-5-5', [10, 120, 1000, 2000]) + line('x', 'claude-sonnet-5-5', [999, 999, 999, 999], 'user') + 'lixo que não é json "usage"\n');
  const u = r.read(SID);
  assert.deepEqual([u.input, u.output, u.cacheWrite, u.cacheRead, u.total, u.turns, u.model], [10, 120, 1000, 2000, 3130, 1, 'claude-sonnet-5-5'], 'a última linha da mesma mensagem vence');
  assert.equal(u.costUsd, (10 * 3 + 120 * 15 + 1000 * 3.75 + 2000 * 0.3) / 1e6);
});

test('incremental: só o acrescentado é lido; linha incompleta espera a próxima leitura; arquivo que recomeça zera', () => {
  const r = createUsageReader({ configDir: tmp, prices: PRICES });
  fs.writeFileSync(file, line('a', 'claude-sonnet-5-5', [1, 1, 0, 0]));
  assert.equal(r.read(SID).turns, 1);
  const second = line('b', 'claude-sonnet-5-5', [2, 2, 0, 0]);
  fs.appendFileSync(file, second.slice(0, 30)); assert.equal(r.read(SID).turns, 1, 'linha pela metade não conta');
  fs.appendFileSync(file, second.slice(30)); assert.deepEqual([r.read(SID).turns, r.read(SID).input], [2, 3]);
  fs.writeFileSync(file, line('z', 'claude-sonnet-5-5', [5, 5, 0, 0])); assert.deepEqual([r.read(SID).turns, r.read(SID).input], [1, 5], 'recomeçou');
});

test('custo: sem preço do modelo (ou sem tabela) é null, nunca zero; vale o prefixo mais longo; tabela inválida é ignorada', () => {
  fs.writeFileSync(file, line('a', 'claude-modelo-novo', [1000, 1000, 0, 0]));
  assert.equal(createUsageReader({ configDir: tmp, prices: PRICES }).read(SID).costUsd, null);
  assert.equal(createUsageReader({ configDir: tmp }).read(SID).costUsd, null);
  fs.writeFileSync(file, line('a', 'claude-sonnet-5-5', [1000, 0, 0, 0]));
  assert.equal(createUsageReader({ configDir: tmp, prices: { 'claude-sonnet': { input: 3 }, 'claude-sonnet-5': { input: 6 } } }).read(SID).costUsd, 0.006);
  const pf = path.join(tmp, 'pricing.json');
  fs.writeFileSync(pf, JSON.stringify({ 'claude-sonnet': { input: 2, output: 0 }, ruim: 'x', neg: { input: -1 } }));
  assert.deepEqual(Object.keys(loadPrices(pf)), ['claude-sonnet']); assert.equal(createUsageReader({ configDir: tmp, pricesFile: pf }).read(SID).costUsd, 0.002);
  fs.writeFileSync(pf, '{quebrado'); assert.deepEqual(loadPrices(pf), {}); assert.deepEqual(loadPrices(path.join(tmp, 'nao-existe.json')), {});
});

test('mensagens sintéticas e sem consumo não anulam o custo nem contam tokens; a ausência do arquivo é lembrada por instantes e `forget` libera', () => {
  const r = createUsageReader({ configDir: tmp, prices: PRICES });
  fs.writeFileSync(file, line('a', 'claude-sonnet-5-5', [100, 100, 0, 0]) + line('s', '<synthetic>', [0, 0, 0, 0]) + line('z', 'claude-sonnet-5-5', [0, 0, 0, 0]));
  const u = r.read(SID); assert.deepEqual([u.turns, u.total, u.costUsd === null], [1, 200, false]);
  const SID2 = '0a1b2c3d-2222-4222-8333-444455556666', f2 = path.join(proj, `${SID2}.jsonl`); assert.equal(r.read(SID2), null);
  fs.writeFileSync(f2, line('q', 'claude-sonnet-5-5', [1, 1, 0, 0])); assert.equal(r.read(SID2), null, 'a ausência é lembrada por ~2 s (evita varrer as pastas a cada consulta)');
  r.forget(SID2); assert.equal(r.read(SID2).turns, 1);
});

test('subagentes: o consumo de <sessão>/subagents/*.jsonl entra no total do pane', () => {
  const r = createUsageReader({ configDir: tmp, prices: PRICES, missMs: 0 });
  fs.writeFileSync(file, line('a', 'claude-sonnet-5-5', [10, 10, 0, 0]));
  const sd = path.join(proj, SID, 'subagents'); fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-x.jsonl'), line('s1', 'claude-sonnet-5-5', [5, 7, 100, 200]) + line('s1', 'claude-sonnet-5-5', [5, 9, 100, 200]));
  fs.writeFileSync(path.join(sd, 'ignorar.txt'), 'x');
  let u = r.read(SID); assert.deepEqual([u.input, u.output, u.cacheWrite, u.cacheRead, u.turns], [15, 19, 100, 200, 2]);
  fs.appendFileSync(path.join(sd, 'agent-x.jsonl'), line('s2', 'claude-sonnet-5-5', [1, 1, 0, 0])); u = r.read(SID); assert.equal(u.turns, 3);
  fs.rmSync(path.join(proj, SID), { recursive: true, force: true });
});

test('id de sessão inválido (caminho, curinga) nunca vira caminho de arquivo', () => {
  const r = createUsageReader({ configDir: tmp, prices: PRICES });
  for (const bad of ['../x', `${SID}/../..`, '*', '', null, undefined, 7]) assert.equal(r.read(bad), null);
});

test('gerenciador de terminais: o uso aparece na sessão e uma falha do leitor nunca derruba a listagem', async () => {
  const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir);
  const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }] };
  fs.writeFileSync(file, line('a', 'claude-sonnet-5-5', [7, 3, 0, 0]));
  const lib = { spawn: (f, a) => ({ pid: 1_900_100_001, args: a, onData() {}, onExit() {}, write() {}, resize() {} }) };
  const mk = (usage) => createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, newSessionId: () => SID, usage });
  const ok = mk(createUsageReader({ configDir: tmp, prices: PRICES })); const { session } = await ok.create({});
  assert.deepEqual([session.usage.input, session.usage.output], [7, 3]); assert.deepEqual(ok.list()[0].usage.total, 10);
  const bad = mk({ read() { throw new Error('boom'); }, forget() { throw new Error('boom'); } }); const b = await bad.create({});
  assert.equal(b.session.usage, null); assert.equal(bad.list().length, 1); assert.equal(bad.close(b.session.id).ok, true);
});
