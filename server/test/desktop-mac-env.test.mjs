// Casca desktop no macOS: PATH do app aberto pelo Finder e menu mínimo. Lógica pura (desktop/mac-env.cjs), sem Electron e sem tocar no disco real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMacPath, macMenuTemplate, nvmBins } = require('../../desktop/mac-env.cjs');

const HOME = '/Users/ana';
const fsFake = (existing, nvm = []) => ({ exists: (d) => existing.includes(d), listDir: () => { if (!nvm.length) throw new Error('ENOENT'); return nvm; } });

test('PATH: git do usuário na FRENTE; diretórios do claude no FIM (nunca antes de git/node do sistema)', () => {
  const dirs = [`${HOME}/.local/git/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${HOME}/.local/bin`, `${HOME}/.claude/local`];
  const p = buildMacPath({ home: HOME, pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin', ...fsFake(dirs) }).split(':');
  assert.deepEqual(p, [`${HOME}/.local/git/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', `${HOME}/.local/bin`, `${HOME}/.claude/local`]);
  assert.ok(p.indexOf(`${HOME}/.local/bin`) > p.indexOf('/usr/bin'), '~/.local/bin não pode vir antes do PATH do sistema');
});

test('PATH: só entram diretórios que existem; sem PATH herdado usa o do sistema; sem duplicatas', () => {
  assert.equal(buildMacPath({ home: HOME, pathEnv: undefined, ...fsFake([]) }), '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(buildMacPath({ home: HOME, pathEnv: '/usr/local/bin:/usr/bin', ...fsFake(['/usr/local/bin']) }), '/usr/local/bin:/usr/bin');
  const dup = buildMacPath({ home: HOME, pathEnv: `/usr/bin:${HOME}/.local/bin`, ...fsFake([`${HOME}/.local/bin`]) }).split(':');
  assert.equal(dup.filter((d) => d === `${HOME}/.local/bin`).length, 1);
});

test('nvm: usa a versão mais nova (ordem numérica, v20.10.0 > v9.1.0), ignora entradas que não são versão e tolera pasta ausente', () => {
  const names = ['v9.1.0', 'v20.10.0', 'v20.9.1', 'default', 'alias'];
  const all = names.filter((n) => /^v/.test(n)).map((n) => `${HOME}/.nvm/versions/node/${n}/bin`);
  const bins = nvmBins(HOME, fsFake(all, names));
  assert.deepEqual(bins, [`${HOME}/.nvm/versions/node/v20.10.0/bin`, `${HOME}/.nvm/versions/node/v20.9.1/bin`, `${HOME}/.nvm/versions/node/v9.1.0/bin`]);
  assert.deepEqual(nvmBins(HOME, fsFake([])), [], 'sem ~/.nvm: lista vazia, sem lançar');
  const p = buildMacPath({ home: HOME, pathEnv: '/usr/bin', ...fsFake(all, names) }).split(':');
  assert.equal(p[0], '/usr/bin'); assert.equal(p[1], `${HOME}/.nvm/versions/node/v20.10.0/bin`);
});

test('nvm: nome de diretório que não é versão (com ":" ou ".." ) nunca entra no PATH', () => {
  const names = ['v20.1.0', 'v1:x', 'v2/../x', 'v3.4.5.6', 'vfoo'];
  const all = names.map((n) => `${HOME}/.nvm/versions/node/${n}/bin`);
  assert.deepEqual(nvmBins(HOME, fsFake(all, names)), [`${HOME}/.nvm/versions/node/v20.1.0/bin`]);
});

test('menu do macOS: aplicativo, edição (Cmd+C/V/A/Z) e janela', () => {
  assert.deepEqual(macMenuTemplate().map((m) => m.role), ['appMenu', 'editMenu', 'windowMenu']);
});
