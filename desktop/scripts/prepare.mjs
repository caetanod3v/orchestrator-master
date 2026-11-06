// Monta desktop/stage: o que vai DENTRO do pacote, sem alterar nada fora de desktop/ (nem client/dist, nem data/).
//   stage/orchestrator : server/ (sem testes), package.json + dependências de produção (express), client/dist NOVO (build para uma pasta própria)
//   stage/node         : node.exe (o mesmo Node que roda este script) + node_modules/npm ao lado (o servidor procura o npm junto do node.exe)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), DESKTOP = path.resolve(HERE, '..'), ROOT = path.resolve(DESKTOP, '..');
const STAGE = path.join(DESKTOP, 'stage'), APP = path.join(STAGE, 'orchestrator'), NODE = path.join(STAGE, 'node');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, shell: false, ...opts });
const step = (t) => console.log(`\n== ${t}`);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

step('limpando stage'); rm(STAGE); fs.mkdirSync(APP, { recursive: true }); fs.mkdirSync(NODE, { recursive: true });

step('cliente: build para uma pasta própria (client/dist NÃO é tocado)');
const viteBin = path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) throw new Error('vite não encontrado: rode "npm install" em client/ antes.');
run(process.execPath, [viteBin, 'build', '--outDir', path.join(APP, 'client', 'dist'), '--emptyOutDir'], { cwd: path.join(ROOT, 'client') });

step('servidor: server/ sem testes');
fs.cpSync(path.join(ROOT, 'server'), path.join(APP, 'server'), { recursive: true, filter: (src) => !/[\\/]server[\\/]test([\\/]|$)/.test(src) });

step('dependências de produção (express) a partir do package-lock do projeto');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pkg = { name: rootPkg.name, version: rootPkg.version, private: true, type: 'module', dependencies: rootPkg.dependencies, devDependencies: rootPkg.devDependencies };
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(pkg, null, 2));
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(APP, 'package-lock.json'));
const npmCli = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p)) ?? '';
if (!fs.existsSync(npmCli)) throw new Error('npm não encontrado junto do Node atual.');
run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: APP });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ ...pkg, devDependencies: undefined, scripts: undefined }, null, 2)); // o pacote não tem scripts de desenvolvimento

step('Node embutido (node + npm)');
if (process.platform === 'win32') {
  fs.copyFileSync(process.execPath, path.join(NODE, 'node.exe'));
  fs.cpSync(path.join(path.dirname(process.execPath), 'node_modules', 'npm'), path.join(NODE, 'node_modules', 'npm'), { recursive: true });
} else { // macOS/Linux: bin/node + lib/node_modules/npm (o servidor procura o npm nos dois layouts)
  fs.mkdirSync(path.join(NODE, 'bin'), { recursive: true }); fs.mkdirSync(path.join(NODE, 'lib', 'node_modules'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(NODE, 'bin', 'node')); fs.chmodSync(path.join(NODE, 'bin', 'node'), 0o755);
  fs.cpSync(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'), path.join(NODE, 'lib', 'node_modules', 'npm'), { recursive: true });
}

fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify({ app: rootPkg.version, node: process.version, builtAt: new Date().toISOString() }, null, 2));
const size = (d) => { let n = 0; const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); e.isDirectory() ? walk(f) : (n += fs.statSync(f).size); } }; walk(d); return (n / 1048576).toFixed(1); };
console.log(`\nstage pronto: orchestrator ${size(APP)} MB, node ${size(NODE)} MB`);
