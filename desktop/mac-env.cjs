// Ajustes só do macOS para a casca desktop. Módulo puro (sem Electron) para ser testado em qualquer sistema.
const fs = require('node:fs');
const path = require('node:path').posix; // só roda no macOS; posix deixa o comportamento idêntico ao ser testado no Windows

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Versões do nvm, da mais nova para a mais antiga (ordem numérica; "v20.10.0" > "v9.1.0"). */
function nvmBins(home, { listDir, exists }) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let names = [];
  try { names = listDir(root); } catch { return []; }
  const key = (n) => n.replace(/^v/, '').split('.').map((x) => Number(x) || 0);
  const cmp = (a, b) => { const A = key(a), B = key(b); for (let i = 0; i < 3; i++) if ((A[i] ?? 0) !== (B[i] ?? 0)) return (B[i] ?? 0) - (A[i] ?? 0); return 0; };
  // só versões de verdade: um nome com ":" viraria uma entrada relativa no PATH
  return names.filter((n) => /^v\d+(\.\d+){0,2}$/.test(n)).sort(cmp).map((n) => path.join(root, n, 'bin')).filter(exists);
}

/**
 * PATH do servidor quando o app é aberto pelo Finder (que NÃO herda o PATH do shell).
 *  - `front`: git instalado pelo usuário passa na frente do git antigo da Apple (comportamento anterior, mantido);
 *  - `back`: onde costuma ficar o `claude` e o Node dele (instalador nativo, npm global, nvm, volta, bun). Vai no FIM: um diretório gravável pelo
 *    usuário nunca ganha precedência sobre `git`/`node` do sistema, mas ainda é achado quando o programa não existe antes.
 */
function buildMacPath({ home, pathEnv, exists = fs.existsSync, listDir = fs.readdirSync } = {}) {
  const front = [path.join(home, '.local', 'git', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(exists);
  const back = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'), ...nvmBins(home, { listDir, exists })].filter(exists);
  const base = (pathEnv || SYSTEM_PATH).split(':');
  return [...front, ...base, ...back].filter((d, i, a) => d && a.indexOf(d) === i).join(':');
}

/** Menu mínimo do macOS: sem ele não existem Cmd+C/V/A/Z nem Cmd+Q (a barra de menus do app fica vazia). */
function macMenuTemplate() {
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}

module.exports = { buildMacPath, macMenuTemplate, nvmBins };
