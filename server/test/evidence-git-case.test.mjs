// Evidência/escopo: `.git` sem distinção de caixa (e com ponto/espaço final) é o diretório interno do Git em safeRelPath e nos instantâneos. Só diretórios temporários.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const { safeRelPath, isGitName, isSkippedDir, snapshotWorkspace } = await import('../evidence.js');
const { scopeSnapshot } = await import('../scope.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evgit-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const ws = (files) => { const d = path.join(tmp, `w${++n}`); fs.mkdirSync(d); for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); } return d; };

test('isGitName: .git em qualquer caixa e com ponto/espaço/fluxo final; .github e afins não', () => {
  for (const x of ['.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', '.GIT::$INDEX_ALLOCATION']) assert.equal(isGitName(x), true, x);
  for (const x of ['.github', '.gitignore', '.gitattributes', '.gitkeep', 'git', 'x.git', '.git2', '.gi', '', null, undefined]) assert.equal(isGitName(x), false, String(x));
  assert.equal(isSkippedDir('.GIT'), true); assert.equal(isSkippedDir('node_modules'), true); assert.equal(isSkippedDir('src'), false); assert.equal(isSkippedDir('.github'), false);
});

test('safeRelPath: .GIT, .Git, .git., ".git " e .git em segmento intermediário são recusados', () => {
  for (const p of ['.GIT/hooks/x', '.Git/config', '.git./hooks/x', '.git /x', '.git/config', 'sub/.GIT/hooks/x', 'a\\.Git\\x', './.GIT/x', 'a/b/.git', '.git::$INDEX_ALLOCATION/x']) assert.equal(safeRelPath(p), null, p);
});

test('safeRelPath: .github, .gitignore, .gitattributes, .gitkeep e nomes comuns continuam aceitos', () => {
  for (const p of ['.github/workflows/a.yml', '.gitignore', '.gitattributes', 'lib/.gitkeep', 'src/git/util.js', 'meu.git/x.txt', 'README.git.md']) assert.equal(safeRelPath(p), p, p);
  assert.equal(safeRelPath('./a/./b.txt'), 'a/b.txt');
});

test('snapshotWorkspace e scopeSnapshot não percorrem .GIT (nem .git) mas percorrem .github', () => {
  const d = ws({
    '.GIT/hooks/pre-commit.test.js': 'x', '.GIT/package.json': '{}', '.git/package.json': '{}', '.Git/.env': 'S=1',
    '.github/workflows/ci.yml': 'on: push', 'package.json': '{}', '.env': 'A=1', 'sub/package.json': '{}',
  });
  const snap = snapshotWorkspace(d);
  assert.deepEqual(Object.keys(snap.files).sort(), ['.github/workflows/ci.yml', 'package.json', 'sub/package.json']);
  const sc = scopeSnapshot(d);
  assert.deepEqual(Object.keys(sc.files).sort(), ['.env', '.github/workflows/ci.yml', 'package.json', 'sub/package.json']);
});

test('nome curto 8.3 do NTFS (GIT~1) é tratado como .git; nomes parecidos não', () => {
  for (const x of ['GIT~1', 'git~1', '.GIT~1', 'GIT~12']) assert.equal(isGitName(x), true, x);
  for (const x of ['git~', 'git~a', 'gitx~1', 'mygit~1', 'GITHUB~1']) assert.equal(isGitName(x), false, x);
  assert.equal(safeRelPath('GIT~1/hooks/pre-commit'), null);
  assert.equal(safeRelPath('src/ok.js'), 'src/ok.js');
});

test('arquivo esperado em .GIT/... não é lido: o instantâneo o ignora (caminho recusado)', () => {
  const d = ws({ '.GIT/config': 'segredo', 'ok.txt': 'a' });
  const snap = snapshotWorkspace(d, { expected: ['.GIT/config', 'sub/.Git/x', 'ok.txt'] });
  assert.deepEqual(Object.keys(snap.expected), ['ok.txt']);
});
