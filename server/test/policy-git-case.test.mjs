// Política: `.git` sem distinção de caixa e com ponto/espaço final (Windows e macOS ignoram caixa) é pasta interna do Git; `.github`, `.gitignore` etc. não. Só texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from '../policy.js';

const ws = { id: 'ws', path: '/work/projeto' };
const verdict = (instructions, expectedFiles = []) => evaluateTask({ title: 'Etapa', instructions, acceptance: ['existe'], expectedFiles }, { workspace: ws, exists: () => false });
const ids = (v) => v.rules.map((r) => r.id);

test('.GIT, .Git, .git. e ".git " no texto são negados como pasta interna do Git', () => {
  for (const p of ['.GIT/hooks/x', '.Git/config', '.git./hooks', '.git /x', '.git/hooks/pre-commit', 'sub/.GIT/hooks/x', '.GIT', '.git..', '.Git /config']) {
    for (const text of [`Edite ${p}`, `Crie o arquivo "${p}"`, `Altere (${p})`]) {
      const v = verdict(text);
      assert.equal(v.decision, 'deny', text);
      assert.ok(ids(v).includes('git_internal'), `${text}: ${JSON.stringify(ids(v))}`);
    }
  }
  // com barras invertidas (o texto é normalizado)
  assert.ok(ids(verdict('Edite .GIT\\hooks\\x')).includes('git_internal'));
});

test('.git em texto livre: delimitadores comuns (vírgula, ponto e vírgula, =, &&, |) também são negados', () => {
  for (const text of ['Edite o .git, depois rode', 'Apague .git; e siga', 'use --git-dir=.git/hooks', 'rode x &&.git/config', 'cat x |.git/config', 'veja (.git)', 'abra {.git}', 'liste .GIT: agora']) {
    const v = verdict(text);
    assert.equal(v.decision, 'deny', text);
    assert.ok(ids(v).includes('git_internal'), `${text}: ${JSON.stringify(ids(v))}`);
  }
  for (const text of ['Edite o .gitignore, depois rode', 'Atualize .github; e siga', 'use meu.git/x', 'veja README.git.md', 'abra .gitattributes: agora']) {
    assert.ok(!ids(verdict(text)).includes('git_internal'), text);
  }
});

test('em expectedFiles, .GIT/.git. em qualquer segmento é negado (caminho inválido => outside_workspace)', () => {
  for (const f of ['.GIT/hooks/x', '.Git/config', '.git./hooks/x', '.git /x', 'sub/.GIT/config', 'a\\.Git\\x', '.git::$INDEX_ALLOCATION/x']) {
    const v = verdict('Crie o arquivo', [f]);
    assert.equal(v.decision, 'deny', f);
    assert.ok(ids(v).includes('outside_workspace'), `${f}: ${JSON.stringify(ids(v))}`);
  }
});

test('.github, .gitignore, .gitattributes, .gitkeep, src/git/util.js e afins NÃO são tomados por .git', () => {
  for (const p of ['.gitignore', '.gitattributes', '.gitkeep', '.gitmodules-x.txt', 'src/git/util.js', 'src/gitlab/a.js', 'lib/.gitkeep', 'meu.git/x.txt', 'README.git.md', 'docs/digit.git']) {
    const v = verdict(`Edite ${p}`);
    assert.ok(!ids(v).includes('git_internal'), `${p}: ${JSON.stringify(ids(v))}`);
    assert.ok(!ids(v).includes('outside_workspace'), `${p}: ${JSON.stringify(ids(v))}`);
  }
  for (const f of ['.gitignore', '.gitattributes', 'lib/.gitkeep', 'src/git/util.js', 'src/git.js']) {
    const v = verdict('Crie o arquivo', [f]);
    assert.ok(!ids(v).includes('git_internal') && !ids(v).includes('outside_workspace'), `${f}: ${JSON.stringify(ids(v))}`);
  }
  // .github/workflows continua sendo aprovação (arquivo sensível), não negação
  const w = verdict('Edite .github/workflows/a.yml', ['.github/workflows/a.yml']);
  assert.equal(w.decision, 'approval_required');
  assert.ok(!ids(w).includes('git_internal'));
  assert.equal(verdict('Edite .gitignore e src/git/util.js', ['.gitignore', 'src/git/util.js']).decision, 'allow');
});
