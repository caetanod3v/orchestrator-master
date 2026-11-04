// terminal-usage: `has` (uma sessão) e `present` (várias, um passe só) com um CLAUDE_CONFIG_DIR TEMPORÁRIO. Nada fora do diretório configurado é lido.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-has-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const { createUsageReader, claudeConfigDir } = await import('../terminal-usage.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333', OUT = '44444444-4444-4444-8444-444444444444';
const cfg = path.join(tmp, 'cfg'), outside = path.join(tmp, 'fora');
fs.mkdirSync(path.join(cfg, 'projects', 'C--Users-x-proj-a'), { recursive: true }); fs.mkdirSync(path.join(cfg, 'projects', 'C--Users-x-proj-b'), { recursive: true }); fs.mkdirSync(outside);
fs.writeFileSync(path.join(cfg, 'projects', 'C--Users-x-proj-a', `${U1}.jsonl`), '{}\n'); fs.writeFileSync(path.join(cfg, 'projects', 'C--Users-x-proj-b', `${U2}.jsonl`), '{}\n');
fs.writeFileSync(path.join(cfg, 'projects', 'C--Users-x-proj-a', 'nao-e-transcricao.txt'), 'x'); fs.mkdirSync(path.join(cfg, 'projects', 'C--Users-x-proj-a', `${U3}.jsonl`)); // diretório com nome de transcrição
fs.writeFileSync(path.join(outside, `${OUT}.jsonl`), '{}\n'); fs.writeFileSync(path.join(cfg, 'projects', 'solto.jsonl'), '{}\n');
const reader = () => createUsageReader({ configDir: cfg });

test('has: transcrição existente (em qualquer pasta de projeto) e inexistente', () => {
  const r = reader(); assert.equal(r.has(U1), true); assert.equal(r.has(U2), true, 'em outro projeto');
  assert.equal(r.has('55555555-5555-4555-8555-555555555555'), false, 'inexistente'); assert.equal(r.has(U3), false, 'um DIRETÓRIO com esse nome não é transcrição');
});

test('has/present: diretório de projetos vazio, ausente ou sem permissão de leitura não lançam e devolvem vazio', () => {
  const vazio = path.join(tmp, 'vazio'); fs.mkdirSync(path.join(vazio, 'projects'), { recursive: true });
  assert.equal(createUsageReader({ configDir: vazio }).has(U1), false); assert.equal(createUsageReader({ configDir: vazio }).present([U1]).size, 0);
  assert.equal(createUsageReader({ configDir: path.join(tmp, 'nao-existe') }).has(U1), false); assert.equal(createUsageReader({ configDir: path.join(tmp, 'nao-existe') }).present([U1]).size, 0);
});

test('identificadores inválidos são rejeitados antes de tocar o disco (sem travessia de caminho, sem curinga)', () => {
  const r = reader();
  for (const bad of [undefined, null, 7, {}, [], '', 'abc', '../fora/' + OUT, `..\\fora\\${OUT}`, `${U1}/../${U1}`, `${U1}.jsonl`, '*', '????????-????-????-????-????????????', '11111111-1111-4111-8111-11111111111g', ` ${U1}`, `${U1}\n`, `${U1}\0`]) {
    assert.equal(r.has(bad), false, JSON.stringify(bad)); assert.equal(r.present([bad]).size, 0, JSON.stringify(bad));
  }
  assert.equal(r.has(path.join('..', '..', 'fora', OUT)), false);
});

test('sem acesso fora do diretório configurado: transcrição em outro lugar e arquivo solto em projects/ não contam', () => {
  const r = reader(); assert.equal(r.has(OUT), false); assert.equal(r.present([OUT]).size, 0);
  assert.equal(createUsageReader({ configDir: outside }).has(OUT), false, 'também não vale sem a pasta projects/');
});

test('present: um passe só, devolve apenas os existentes, aceita lista com lixo e não guarda cache (reflete o disco agora)', () => {
  const r = reader(); const set = r.present([U1, U2, U3, OUT, 'lixo', null, U1]); assert.deepEqual([...set].sort(), [U1, U2]);
  assert.equal(r.present([]).size, 0); assert.equal(r.present('nao-e-lista').size, 0); assert.equal(r.present(undefined).size, 0);
  const novo = '66666666-6666-4666-8666-666666666666'; assert.equal(r.present([novo]).size, 0); fs.writeFileSync(path.join(cfg, 'projects', 'C--Users-x-proj-a', `${novo}.jsonl`), '{}\n');
  assert.equal(r.present([novo]).size, 1, 'passa a existir sem reiniciar o leitor'); assert.equal(r.has(novo), true); fs.rmSync(path.join(cfg, 'projects', 'C--Users-x-proj-a', `${novo}.jsonl`));
  assert.equal(r.present([novo]).size, 0, 'e deixa de existir'); assert.equal(r.has(novo), false);
});

test('CLAUDE_CONFIG_DIR define a pasta padrão e o leitor padrão a respeita', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: cfg }), cfg); const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = cfg;
  try { const r = createUsageReader(); assert.equal(r.has(U1), true); assert.deepEqual([...r.present([U1, OUT])], [U1]); } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
});
