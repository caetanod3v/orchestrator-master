// O electron-builder descarta qualquer pasta "node_modules" ao copiar extraResources. O servidor precisa do express (orchestrator/node_modules) e o Node embutido precisa do npm
// (node/node_modules/npm, que o servidor procura ao lado do node.exe nas verificações reais). Este gancho roda ANTES dos instaladores e as coloca no pacote.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const stage = path.join(context.packager.projectDir, 'stage'), res = path.join(context.appOutDir, 'resources');
  for (const [from, to] of [[path.join(stage, 'orchestrator', 'node_modules'), path.join(res, 'orchestrator', 'node_modules')], [path.join(stage, 'node', 'node_modules'), path.join(res, 'node', 'node_modules')]]) {
    if (!fs.existsSync(from)) throw new Error(`stage incompleto: ${from} (rode "npm run stage")`);
    fs.cpSync(from, to, { recursive: true });
  }
  for (const must of [path.join(res, 'orchestrator', 'node_modules', 'express', 'package.json'), path.join(res, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(res, 'node', 'node.exe'), path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), path.join(res, 'orchestrator', 'node_modules', 'node-pty', 'lib', 'index.js')]) {
    if (!fs.existsSync(must)) throw new Error(`o pacote ficou sem ${must}`);
  }
};
