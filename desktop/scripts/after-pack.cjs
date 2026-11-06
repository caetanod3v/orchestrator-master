// O electron-builder descarta qualquer pasta "node_modules" ao copiar extraResources. O servidor precisa do express (orchestrator/node_modules) e o Node embutido precisa do npm
// (node/node_modules/npm, que o servidor procura ao lado do node.exe nas verificações reais). Este gancho roda ANTES dos instaladores e as coloca no pacote.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const mac = context.electronPlatformName === 'darwin';
  const stage = path.join(context.packager.projectDir, 'stage'), res = mac ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources');
  const nodeMods = mac ? ['node', 'lib', 'node_modules'] : ['node', 'node_modules']; // macOS: layout oficial do Node (bin/node + lib/node_modules/npm)
  for (const [from, to] of [[path.join(stage, 'orchestrator', 'node_modules'), path.join(res, 'orchestrator', 'node_modules')], [path.join(stage, ...nodeMods), path.join(res, ...nodeMods)]]) {
    if (!fs.existsSync(from)) throw new Error(`stage incompleto: ${from} (rode "npm run stage")`);
    fs.cpSync(from, to, { recursive: true });
  }
  if (mac) { // o node-pty publica o spawn-helper sem bit de execução; sem ele nenhum terminal (PTY) abre
    const pre = path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'prebuilds');
    for (const d of fs.existsSync(pre) ? fs.readdirSync(pre) : []) { const h = path.join(pre, d, 'spawn-helper'); if (fs.existsSync(h)) fs.chmodSync(h, 0o755); }
  }
  for (const must of [path.join(res, 'orchestrator', 'node_modules', 'express', 'package.json'), path.join(res, ...nodeMods, 'npm', 'bin', 'npm-cli.js'), mac ? path.join(res, 'node', 'bin', 'node') : path.join(res, 'node', 'node.exe'), mac ? path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'prebuilds', `darwin-${context.arch === 3 ? 'arm64' : 'x64'}`, 'pty.node') : path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'lib', 'index.js')]) {
    if (!fs.existsSync(must)) throw new Error(`o pacote ficou sem ${must}`);
  }
};
