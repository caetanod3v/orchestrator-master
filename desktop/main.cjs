// FORGE — casca desktop (Electron). NÃO reimplementa nada: sobe o MESMO servidor (server/index.js) com o Node embutido no pacote, numa porta livre de 127.0.0.1,
// com o banco na pasta de dados do usuário, e mostra a interface numa janela própria. Fechar a janela encerra o servidor (e o que ele iniciou).
//   - o banco fica em %APPDATA%\FORGE\data (ORCH_DATA_DIR; na primeira execução os dados de %APPDATA%\AI Dev Orchestrator\data são COPIADOS para cá, ver migrate-userdata.cjs); nunca em uma pasta de código e nunca no `data\` do repositório;
//   - o Node é o do pacote (resources\node\node.exe, com o npm ao lado: as verificações reais procuram o npm junto do node.exe);
//   - o Claude Code continua sendo exigido no PATH da máquina (o orquestrador o executa, não o inclui).
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { buildMacPath, macMenuTemplate } = require('./mac-env.cjs');
const { migrateUserData } = require('./migrate-userdata.cjs');

app.setName('FORGE');
app.setPath('userData', path.join(app.getPath('appData'), 'FORGE')); // explícito: a pasta de dados não depende de como o Electron deriva o nome
const SMOKE = process.env.ORCH_DESKTOP_SMOKE || null; // só para verificação do pacote: sobe, confere as rotas e sai com um código
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'stage');
const IS_WIN = process.platform === 'win32';
const APP_DIR = path.join(RES, 'orchestrator'), NODE_EXE = IS_WIN ? path.join(RES, 'node', 'node.exe') : path.join(RES, 'node', 'bin', 'node'); // macOS/Linux: layout oficial do Node (bin/node + lib/node_modules/npm)
const DATA_DIR = process.env.ORCH_DESKTOP_DATA || path.join(app.getPath('userData'), 'data');
const LOG_FILE = path.join(app.getPath('userData'), 'logs', 'server.log');

let child = null, port = 0, win = null, quitting = false, tail = [];
// M2: token de sessão por boot. Vai ao servidor por ORCH_API_TOKEN (que o remove do ambiente dos filhos) e é injetado SÓ nas requisições da janela à própria origem;
// o agente de um pane não o recebe, então não consegue aprovar as próprias tarefas nem escrever na entrada de outro pane com um curl.
const API_TOKEN = randomBytes(32).toString('hex');

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, text: await r.text() }; };

function log(line) {
  tail.push(line); if (tail.length > 40) tail.shift();
  try { fs.appendFileSync(LOG_FILE, line.endsWith('\n') ? line : `${line}\n`); } catch { /* sem log em disco: a janela de erro ainda mostra o final */ }
}

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (!fs.existsSync(NODE_EXE)) throw new Error(`Node embutido não encontrado: ${NODE_EXE}`);
  const env = { ...process.env, PORT: String(port), ORCH_DATA_DIR: DATA_DIR, ORCH_API_TOKEN: API_TOKEN };
  if (!IS_WIN) env.PATH = buildMacPath({ home: require('node:os').homedir(), pathEnv: env.PATH }); // app aberto pelo Finder não herda o PATH do shell (git do usuário na frente; claude/node do usuário no fim)
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; // o servidor roda no Node do pacote, nunca como Electron
  child = spawn(NODE_EXE, [path.join(APP_DIR, 'server', 'index.js')], { cwd: APP_DIR, env, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] }); // fora do Windows o servidor lidera o próprio grupo de processos (permite encerrar a árvore)
  log(`--- servidor iniciado (pid ${child.pid}) em 127.0.0.1:${port}; dados em ${DATA_DIR}`);
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(log));
  child.once('exit', (code, sig) => { log(`--- servidor encerrou (código ${code}, sinal ${sig})`); child = null; if (!quitting) fail('O servidor do orquestrador parou.'); });
}

/** Primeira execução depois da troca de nome: copia os dados de "AI Dev Orchestrator" para "FORGE". Com dados explícitos (verificação do pacote) não mexe em nada. */
function runMigration() {
  if (SMOKE || process.env.ORCH_DESKTOP_DATA) return; // verificação do pacote: nunca toca os dados reais
  const r = migrateUserData({ appData: app.getPath('appData') });
  if (r.status === 'migrated') {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    log(`--- dados migrados de ${r.from} para ${r.to} (a pasta original foi mantida)`);
    if (r.skippedLinks && r.skippedLinks.length) log(`--- links não copiados (a cópia é sempre real): ${r.skippedLinks.join(', ')}`);
  }
  else if (r.status === 'blocked') throw new Error(`A versão anterior (AI Dev Orchestrator, pid ${r.pid}) parece estar aberta. Feche-a e abra o FORGE de novo. Se ela NÃO estiver aberta, o arquivo de trava ficou para trás depois de uma queda: apague ${r.lock} e tente de novo. Nenhum dado foi copiado.`);
  else if (r.status === 'error') throw new Error(`Não foi possível copiar os dados da versão anterior: ${r.error}. A pasta original não foi alterada.`);
}

function fail(message) {
  if (quitting) return; quitting = true;
  if (SMOKE) { fs.writeFileSync(SMOKE, JSON.stringify({ ok: false, error: message, tail })); app.exit(1); return; }
  dialog.showErrorBox('FORGE',`${message}\n\nÚltimas linhas do servidor:\n${tail.slice(-8).join('\n')}\n\nLog completo: ${LOG_FILE}`);
  stopServer(); app.exit(1);
}

/** Interrompe a execução em curso (se houver) e encerra o servidor com TODA a árvore de processos (Claude Code incluído). */
function stopServer() {
  const c = child; child = null; if (!c?.pid) return;
  if (IS_WIN) { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch { /* já encerrado */ } return; }
  // macOS/Linux: SIGTERM primeiro (o servidor encerra o Claude Code e os terminais dele e libera a trava); se não sair em ~4 s, SIGKILL no grupo inteiro
  const alive = () => { try { process.kill(c.pid, 0); return true; } catch { return false; } };
  try { process.kill(c.pid, 'SIGTERM'); } catch { return; }
  for (let t = 0; t < 4000 && alive(); t += 100) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (alive()) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { process.kill(c.pid, 'SIGKILL'); } catch { /* já encerrado */ } } }
}
async function gracefulStop() {
  try { await fetch(`http://127.0.0.1:${port}/api/execution/stop`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-orch-token': API_TOKEN }, body: '{}', signal: AbortSignal.timeout(2500) }); } catch { /* o servidor pode já ter caído */ }
  stopServer();
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    if (!child) throw new Error('O servidor encerrou durante a inicialização.');
    try { const r = await get('/api/state'); if (r.status === 200) return; } catch { /* ainda subindo */ }
    await sleep(250);
  }
  throw new Error('O servidor não respondeu em 30 s.');
}

function createWindow() {
  const origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#000000', title: 'FORGE', autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged } });
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => { details.requestHeaders['x-orch-token'] = API_TOKEN; cb({ requestHeaders: details.requestHeaders }); });
  win.once('ready-to-show', () => win.show());
  // a janela só navega dentro do próprio servidor local; qualquer link externo abre no navegador padrão
  // compara a origem por URL, não por prefixo de texto (`http://127.0.0.1:5000` não pode "conter" `http://127.0.0.1:50001`)
  const isInternal = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => { if (!isInternal(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url) && !isInternal(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  win.loadURL(`${origin}/`);
}

const lock = SMOKE ? true : app.requestSingleInstanceLock();
if (!lock) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(macMenuTemplate()) : null); // macOS sem menu = sem Cmd+C/V/Q; Windows continua sem menu
    try {
      runMigration(); // antes de subir o servidor: ele abre o banco assim que inicia
      port = await freePort(); startServer(); await waitReady();
      if (SMOKE) {
        const index = await get('/'), state = await get('/api/state'), ws = await get('/api/workspaces'), terms = await get('/api/terminals'), mcp = await get('/mcp'); // terminais (PTY) e /mcp: o /mcp tem de responder 405, nunca o HTML do cliente
        fs.writeFileSync(SMOKE, JSON.stringify({ ok: index.status === 200 && /<div id="root">/.test(index.text) && state.status === 200 && ws.status === 200 && terms.status === 200 && mcp.status === 405, port, indexStatus: index.status, stateStatus: state.status, terminalsStatus: terms.status, mcpStatus: mcp.status, dataDir: DATA_DIR, node: NODE_EXE, system: JSON.parse(state.text).system }));
        quitting = true; await gracefulStop(); app.exit(0); return;
      }
      createWindow();
    } catch (e) { fail(e.message || String(e)); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => { if (quitting) return; quitting = true; e.preventDefault(); gracefulStop().finally(() => app.exit(0)); });
}
