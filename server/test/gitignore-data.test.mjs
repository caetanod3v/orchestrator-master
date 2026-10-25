// P6: arquivos auxiliares e cópias de diagnóstico de data/ (podem conter dados do usuário) não podem ser versionados por engano.
// Usa `git check-ignore` (somente leitura; os caminhos nem precisam existir). Nenhum arquivo real de data/ é lido ou alterado.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignored = (p) => { const r = spawnSync('git', ['check-ignore', '-q', '--', p], { cwd: REPO, windowsHide: true }); assert.ok(r.status === 0 || r.status === 1, `git check-ignore falhou: ${r.stderr}`); return r.status === 0; };
const TS = '1761000000000';

test('cópias de diagnóstico e auxiliares da recuperação (P1) estão ignorados', () => {
  for (const p of [`data/db.json.corrupt-${TS}`, `data/db.json.tmp.corrupt-${TS}`, `data/db.json.bak.corrupt-${TS}`, 'data/db.json.restore']) assert.equal(ignored(p), true, p);
});

test('as regras anteriores continuam válidas: banco, temporários, backup (P3) e trava (P2)', () => {
  for (const p of ['data/db.json', 'data/db.json.tmp', 'data/db.json.bak', 'data/db.json.bak.tmp', 'data/server.lock', 'data/server.lock.stale-1-abc123']) assert.equal(ignored(p), true, p);
});

test('controle negativo: código-fonte e outros arquivos NÃO são ignorados (as regras não são largas demais)', () => {
  for (const p of ['server/store.js', 'server/test/store-flush.test.mjs', 'package.json', 'data/outro-arquivo.json', 'server/corrupt-handler.js']) assert.equal(ignored(p), false, p);
});
