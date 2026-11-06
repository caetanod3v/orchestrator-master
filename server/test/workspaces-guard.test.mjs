// validateDir: caminhos de rede/dispositivo (UNC) em todas as formas e workspaces amplos demais (home, ancestrais, APPDATA, Library, .config).
// Só diretórios TEMPORÁRIOS e `opts` injetados; o home real é usado apenas como texto de caminho (leitura), nunca alterado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const { validateDir } = await import('../workspaces.js');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wsguard-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

const home = mk('fakehome', 'caetano');
const appdata = mk('fakehome', 'caetano', 'AppData', 'Roaming');
const localappdata = mk('fakehome', 'caetano', 'AppData', 'Local');
const library = mk('fakehome', 'caetano', 'Library');
const dotconfig = mk('fakehome', 'caetano', '.config');
const proj = mk('fakehome', 'caetano', 'projetos', 'x');
const opts = { home, env: { APPDATA: appdata, LOCALAPPDATA: localappdata } };

test('UNC: \\\\h\\s, //h/s, \\\\?\\UNC\\h\\s e caminhos de dispositivo são recusados antes de tocar o disco/rede', () => {
  const real = fs.statSync, seen = [];
  fs.statSync = (p, ...r) => { seen.push(String(p)); return real(p, ...r); };
  try {
    for (const p of ['\\\\h\\s', '\\\\h\\s\\dir', '//h/s', '//h/s/dir', '\\\\?\\UNC\\h\\s\\d', '//?/UNC/h/s/d', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '\\/h/s', '"\\\\h\\s"', '  //h/s  ']) {
      const v = validateDir(p, opts);
      assert.equal(v.ok, false, p);
      assert.match(v.error, /UNC|dispositivo|absoluto/, p); // no POSIX, "\hs" nem é absoluto
    }
    assert.equal(validateDir('//h/s', opts).error, 'Caminhos de rede (UNC) não são permitidos.');
    assert.equal(validateDir('//?/UNC/h/s', opts).error, 'Caminhos de rede (UNC) não são permitidos.');
    if (process.platform === 'win32') {
      assert.equal(validateDir('\\\\h\\s', opts).error, 'Caminhos de rede (UNC) não são permitidos.');
      assert.equal(validateDir('\\\\?\\UNC\\h\\s', opts).error, 'Caminhos de rede (UNC) não são permitidos.');
    }
  } finally { fs.statSync = real; }
  assert.deepEqual(seen.filter((s) => /(^|[\\/])h[\\/]s/.test(s)), [], 'nenhum statSync em caminho de rede');
});

test('home, ancestrais do home, APPDATA, LOCALAPPDATA, Library e .config são recusados', () => {
  for (const [nome, dir] of [['home', home], ['pai do home', path.dirname(home)], ['avô do home', path.dirname(path.dirname(home))], ['APPDATA', appdata], ['LOCALAPPDATA', localappdata], ['AppData (ancestral de ambos)', path.dirname(appdata)], ['Library', library], ['.config', dotconfig]]) {
    const v = validateDir(dir, opts);
    assert.equal(v.ok, false, nome);
    assert.match(v.error, /amplo demais/, nome);
  }
});

test('o home REAL e seu pai (ex.: C:\\Users, /Users) também são recusados por padrão', () => {
  const h = os.homedir();
  assert.equal(validateDir(h).ok, false);
  const up = path.dirname(h);
  if (path.parse(up).root !== up) assert.equal(validateDir(up).ok, false, up);
  if (process.env.APPDATA) assert.equal(validateDir(process.env.APPDATA).ok, false);
  if (process.env.LOCALAPPDATA) assert.equal(validateDir(process.env.LOCALAPPDATA).ok, false);
});

test('projeto dentro do home, filhos de APPDATA/Library e diretórios temporários continuam aceitos', () => {
  const v = validateDir(proj, opts);
  assert.equal(v.ok, true, v.error); assert.equal(v.path, proj);
  const sub = mk('fakehome', 'caetano', 'AppData', 'Local', 'Temp', 'w1');
  assert.equal(validateDir(sub, opts).ok, true);
  assert.equal(validateDir(mk('fakehome', 'caetano', 'Library', 'app'), opts).ok, true);
  assert.equal(validateDir(mk('outro', 'projeto'), opts).ok, true);
  assert.equal(validateDir(os.tmpdir()).ok, true, 'os.tmpdir() fica dentro do LOCALAPPDATA/home e deve ser aceito');
  assert.equal(validateDir(tmp).ok, true);
  assert.equal(validateDir(process.cwd()).ok, true, 'o próprio repositório é aceito');
});

test('raiz de disco segue recusada; uma chamada com 1 argumento continua funcionando', () => {
  assert.equal(validateDir(path.parse(tmp).root, opts).ok, false);
  assert.match(validateDir(path.parse(tmp).root, opts).error, /raiz/);
  assert.equal(validateDir(tmp).ok, true);
  assert.equal(validateDir(undefined).ok, false);
  assert.equal(validateDir('relativo/x').ok, false);
  assert.equal(validateDir(path.join(tmp, 'nao-existe')).ok, false);
  assert.equal(validateDir(proj, undefined).ok, true, 'opts indefinido usa os do sistema');
});

test('sem env/home definidos nada é inventado: só o que existe vale', () => {
  assert.equal(validateDir(proj, { home: '', env: {} }).ok, true);
  assert.equal(validateDir(home, { home: '', env: {} }).ok, true);
});

test('link simbólico para o home é resolvido (realpath) e recusado', (t) => {
  const link = path.join(tmp, 'atalho');
  try { fs.symlinkSync(home, link, 'junction'); } catch { t.skip('sem permissão para criar link/junction'); return; }
  assert.equal(validateDir(link, opts).ok, false);
});
