// Escopo da rodada (scope.js): arquivos sensíveis/de segredo que MUDARAM de fato x o que foi autorizado. Só diretórios TEMPORÁRIOS; nenhum processo, banco ou modelo.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.ORCH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scope-data-')); // policy.js -> evidence.js; nunca os dados reais
const { scopeSnapshot, scopeCheck } = await import('../scope.js');
const { buildEvidence } = await import('../evidence.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scope-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(process.env.ORCH_DATA_DIR, { recursive: true, force: true }); });
let n = 0;
const ws = (files = {}) => { const d = path.join(tmp, `w${++n}`); fs.mkdirSync(d); for (const [p, c] of Object.entries(files)) put(d, p, c); return d; };
const put = (d, p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };
const check = (d, mutate, scope = {}) => { const before = scopeSnapshot(d); mutate(d); return scopeCheck({ before, after: scopeSnapshot(d), ...scope }); };
const SEGREDO = 'SEGREDO-TOPO-123';

test('snapshot: só arquivos sensíveis e de segredo, por hash; comuns, exemplos, node_modules e links ficam de fora; o conteúdo nunca aparece', () => {
  const d = ws({ 'a.js': 'x', 'package.json': '{}', 'Dockerfile': 'FROM x', '.env': SEGREDO, '.env.example': 'FOO=', 'node_modules/p/package.json': '{}', '.github/workflows/ci.yml': 'on: push', 'README.md': 'r' });
  const s = scopeSnapshot(d); assert.equal(s.complete, true); assert.deepEqual(Object.keys(s.files).sort(), ['.env', '.github/workflows/ci.yml', 'Dockerfile', 'package.json']);
  assert.deepEqual([s.files['.env'].kind, s.files['package.json'].kind], ['secret', 'sensitive']); assert.ok(!JSON.stringify(s).includes(SEGREDO), 'só o hash, nunca o conteúdo');
  assert.equal(scopeSnapshot(path.join(tmp, 'nao-existe')), null);
});

test('scopeCheck: arquivo sensível AUTORIZADO (expectedFiles ou aprovação) não é desvio; fora do escopo é; arquivo comum fora do escopo não conta', () => {
  let r = check(ws({ 'package.json': '{}' }), (d) => put(d, 'package.json', '{"a":1}'), { expected: ['package.json'] }); assert.deepEqual([r.status, r.files, r.changed], ['clean', [], 1]);
  r = check(ws({ 'package.json': '{}' }), (d) => put(d, 'package.json', '{"a":1}'), { expected: ['a.txt'], approvedSubjects: ['./package.json'] }); assert.equal(r.status, 'clean', 'aprovação humana da ação cobre o arquivo');
  r = check(ws({ 'package.json': '{}' }), (d) => put(d, 'package.json', '{"a":1}'), { expected: ['a.txt'] }); assert.deepEqual([r.status, r.files], ['exceeded', [{ path: 'package.json', change: 'modified', category: 'sensitive' }]]);
  r = check(ws({}), (d) => { put(d, 'Dockerfile', 'FROM x'); put(d, 'sub/requirements.txt', 'a'); put(d, 'comum.txt', 'x'); put(d, 'src/index.js', 'y'); }, { expected: [] }); assert.deepEqual(r.files.map((f) => `${f.path}:${f.change}`), ['Dockerfile:created', 'sub/requirements.txt:created']);
  r = check(ws({ 'Dockerfile': 'x' }), (d) => fs.rmSync(path.join(d, 'Dockerfile'))); assert.deepEqual(r.files, [{ path: 'Dockerfile', change: 'deleted', category: 'sensitive' }]);
  r = check(ws({ 'a.js': 'x' }), (d) => put(d, 'a.js', 'mudou'), {}); assert.deepEqual([r.status, r.changed], ['clean', 0], 'comum fora do escopo: comportamento atual mantido');
  r = check(ws({ 'package.json': '{}' }), (d) => put(d, 'package.json', '{}'), {}); assert.equal(r.status, 'clean', 'reescrever o MESMO conteúdo não é alteração');
});

test('scopeCheck: segredo fora do escopo é identificado SEM expor o conteúdo; menção sozinha não autoriza (só expected/aprovação)', () => {
  const r = check(ws({ '.env': SEGREDO }), (d) => put(d, '.env', `${SEGREDO}-NOVO`), { expected: ['outro.txt'] });
  assert.deepEqual([r.status, r.files], ['exceeded', [{ path: '.env', change: 'modified', category: 'secret' }]]); assert.ok(!JSON.stringify(r).includes('SEGREDO'), 'nem o antigo nem o novo conteúdo');
  const ev = buildEvidence({ report: { status: 'success', checks: [], verifications: [] }, verification: 'passed', configured: 1, expectedResults: [{ path: 'outro.txt', ok: true }], integrity: { status: 'clean', pending: [] }, scope: r });
  assert.ok(!JSON.stringify(ev).includes('SEGREDO')); assert.match(ev.reasons.join(), /fora do escopo autorizado.*\.env modificado/);
});

test('scopeCheck: sem ver tudo nunca se afirma que não houve desvio ("unknown"); evidência: exceeded => failed, unknown => inconclusive, clean => segue verified', () => {
  assert.equal(scopeCheck({ before: null, after: { complete: true, files: {} } }).status, 'unknown'); assert.equal(scopeCheck({ before: { complete: false, files: {} }, after: { complete: true, files: {} } }).status, 'unknown');
  const base = { report: { status: 'success', checks: [], verifications: [] }, verification: 'passed', configured: 1, expectedResults: [{ path: 'a.txt', ok: true }], integrity: { status: 'clean', pending: [] } };
  const lv = (scope) => buildEvidence({ ...base, ...(scope ? { scope } : {}) });
  assert.equal(lv(null).level, 'verified'); assert.equal(lv({ status: 'clean', files: [] }).level, 'verified'); assert.equal(lv({ status: 'clean', files: [] }).system.scope, 'clean');
  const bad = lv({ status: 'exceeded', files: [{ path: 'Dockerfile', change: 'created', category: 'sensitive' }] }); assert.equal(bad.level, 'failed'); assert.equal(bad.system.scope, 'exceeded'); assert.notEqual(bad.basis, 'executor_claim_only');
  const unk = lv({ status: 'unknown', reason: 'não foi possível ler o workspace' }); assert.equal(unk.level, 'inconclusive'); assert.match(unk.reasons.join(), /escopo das alterações não verificável/);
  assert.equal(lv(undefined).system.scope, undefined, 'sem escopo informado (rodadas antigas) nada muda');
});
