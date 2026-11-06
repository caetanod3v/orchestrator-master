// Política: caminhos absolutos do macOS e do Linux fora do workspace são NEGADOS (outside_workspace). No macOS o diretório temporário real é /private/var/...,
// e /Library, /Applications, /System e /Volumes também são raízes do sistema. Só texto: nada é executado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from '../policy.js';

const ws = { id: 'ws', path: '/work/projeto' };
const verdict = (instructions) => evaluateTask({ title: 'Etapa', instructions, acceptance: ['existe'], expectedFiles: [] }, { workspace: ws });

test('raízes absolutas de sistema (Linux e macOS) são negadas como fora do workspace', () => {
  for (const p of ['/etc/hosts', '/usr/local/x', '/var/log/a', '/home/u/a', '/root/a', '/bin/sh', '/sbin/x', '/opt/a', '/tmp/a', '/Users/u/a', '/mnt/a', '/proc/1', '/sys/a',
    '/private/etc/hosts', '/private/var/folders/ab/T/x.txt', '/Library/LaunchDaemons/x.plist', '/Applications/App.app/x', '/System/Library/x', '/Volumes/Disco/x']) {
    for (const text of [`Edite ${p}`, `Crie o arquivo "${p}/novo.txt"`, `Altere (${p})`]) {
      const v = verdict(text);
      assert.equal(v.decision, 'deny', text);
      assert.ok(v.rules.some((r) => r.id === 'outside_workspace'), `${text}: ${JSON.stringify(v.rules.map((r) => r.id))}`);
    }
  }
});

test('rotas e caminhos relativos comuns NÃO são tomados por caminho de sistema', () => {
  for (const t of ['Crie a rota GET /api/users no servidor', 'Implemente o endpoint /health e /status', 'Edite src/private/util.js', 'Edite src/Library/a.js', 'Crie docs/System/overview.md', 'Edite a.js']) {
    const v = verdict(t);
    assert.ok(!v.rules.some((r) => r.id === 'outside_workspace'), `${t}: ${JSON.stringify(v.rules.map((r) => r.id))}`);
  }
});
