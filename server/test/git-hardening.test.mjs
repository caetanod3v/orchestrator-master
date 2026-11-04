// B6: `git status` no workspace não pode executar o comando de `core.fsmonitor` de um repositório hostil. Repositório TEMPORÁRIO; o "comando" só cria um arquivo-marcador.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-githard-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const { gitInfo, gitChanges } = await import('../git.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('gitInfo/gitChanges não executam core.fsmonitor do repositório (e o controle prova que o marcador seria criado sem a proteção)', async () => {
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  const marker = path.join(tmp, 'marcador-executado'), hook = path.join(tmp, 'hook.js');
  fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('');`);
  const g = (...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'safe.directory=*', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  g('config', 'core.fsmonitor', `node ${JSON.stringify(hook.replace(/\\/g, '/'))}`);
  // controle: o git cru, sem a proteção, executa o comando (se a versão do Git não o fizer, o teste não prova nada e é marcado como tal)
  try { execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'ignore' }); } catch { /* o comando pode falhar; o que importa é o marcador */ }
  const controlRan = fs.existsSync(marker); fs.rmSync(marker, { force: true });
  const info = await gitInfo(repo); const ch = await gitChanges(repo);
  assert.equal(fs.existsSync(marker), false, 'o comando de core.fsmonitor NÃO pode ser executado pelo orquestrador');
  assert.equal(info.isRepo, true); assert.equal(info.dirty, true); assert.deepEqual(ch.files.map((f) => f.path), ['a.txt']);
  if (!controlRan) console.warn('[aviso] este Git não executou core.fsmonitor no controle: o teste só confirma o funcionamento normal.');
});
