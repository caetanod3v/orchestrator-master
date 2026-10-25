// P2 de ponta a ponta: servidores REAIS (server/index.js) como processos filhos, SEMPRE com ORCH_DATA_DIR temporário e porta livre própria.
// Nenhum Claude/modelo é chamado (o boot não executa nada); o banco real nunca é tocado. Todos os filhos são encerrados no fim.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'index.js');
const LOCK_MOD = pathToFileURL(path.join(HERE, '..', 'instance-lock.js')).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-boot-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let n = 0;
const newDir = () => { const d = path.join(root, `d${++n}`); fs.mkdirSync(d); assert.ok(d.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário'); return d; };

/** Sobe `node server/index.js`; `exited` resolve com o código; `waitFor` espera um padrão na saída (com tempo máximo). */
function server(dir, port) {
  const child = spawn(process.execPath, [INDEX], { env: { ...process.env, ORCH_DATA_DIR: dir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const waitFor = (re, ms = 20_000) => new Promise((resolve, reject) => {
    const t0 = Date.now(), iv = setInterval(() => {
      if (re.test(out)) { clearInterval(iv); resolve(out); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`tempo esgotado esperando ${re}; saída: ${out}`)); }
    }, 25);
    exited.then(() => { clearInterval(iv); if (re.test(out)) resolve(out); else reject(new Error(`o processo encerrou antes de ${re}; saída: ${out}`)); });
  });
  return { child, exited, out: () => out, waitFor, kill: () => child.kill() };
}
const UP = /AI Dev Orchestrator API em/;
const lockFile = (d) => path.join(d, 'server.lock');
/** Estado "no meio de uma execução": uma tarefa running. O boot de uma instância marca isso como interrupted (e grava). */
const runningDb = () => ({ version: 1, settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: false }, workspaces: [], activity: [], missions: [{ id: 'm1', demo: false, title: 'em execução', workspaceId: null, tasks: [{ id: 't1', title: 'x', status: 'running', dependsOn: [], log: [], files: [] }] }] });
const plantDb = (d) => fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify(runningDb(), null, 2));
const snapshot = (d) => { const f = path.join(d, 'db.json'); return { bytes: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs }; };
const taskStatus = (d) => JSON.parse(fs.readFileSync(path.join(d, 'db.json'), 'utf8')).missions[0].tasks[0].status;

test('a 2ª instância (outra porta OU a mesma) sai com erro claro sem alterar o banco nem a trava da 1ª; depois de abandonada, a trava é recuperada', async () => {
  const dir = newDir(), p1 = await freePort();
  plantDb(dir);
  const s1 = server(dir, p1); await s1.waitFor(UP);
  assert.equal(taskStatus(dir), 'interrupted', 'o boot da 1ª instância tratou a tarefa órfã');
  const lock1 = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')); assert.equal(lock1.pid, s1.child.pid);

  plantDb(dir);                                                                    // "a 1ª instância está no meio de uma execução": tarefa running de novo
  const before = snapshot(dir), lockBefore = fs.readFileSync(lockFile(dir), 'utf8');
  for (const port of [await freePort(), p1]) {                                    // outra porta (mesmo diretório de dados) e a mesma porta
    const s2 = server(dir, port);
    assert.equal(await s2.exited, 1, 'código de saída 1');
    assert.match(s2.out(), /outra instância do servidor em execução \(PID \d+/); assert.ok(s2.out().includes(dir));
    assert.doesNotMatch(s2.out(), UP, 'a 2ª não chegou a subir');
    const after_ = snapshot(dir);
    assert.equal(after_.bytes, before.bytes, 'db.json byte a byte igual'); assert.equal(after_.mtime, before.mtime, 'db.json não foi regravado');
    assert.equal(taskStatus(dir), 'running', 'a tarefa running não foi marcada como interrompida pela 2ª instância');
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), lockBefore, 'a trava da 1ª está intacta');
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'db.json' && f !== 'server.lock'), [], 'nenhum arquivo extra (.corrupt, .tmp, .stale…)');

  // A trava vem ANTES do store.load(): com um db.json inválido o load() de uma 2ª instância preservaria/recriaria arquivos.
  fs.writeFileSync(path.join(dir, 'db.json'), '{"quebrado":');
  const invalid = snapshot(dir);
  const s2b = server(dir, await freePort());
  assert.equal(await s2b.exited, 1); assert.doesNotMatch(s2b.out(), /RECUPERAÇÃO|banco recuperado|preservada/, 'o load() nem chegou a rodar');
  assert.equal(snapshot(dir).bytes, invalid.bytes); assert.equal(snapshot(dir).mtime, invalid.mtime);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'db.json' && f !== 'server.lock'), [], 'sem .corrupt-*, .restore nem .tmp criados pela 2ª instância');
  plantDb(dir);                                                                    // volta ao estado "tarefa running" para o restante do cenário

  // 1ª instância morre sem liberar (encerramento forçado): trava abandonada
  s1.kill(); await s1.exited;
  assert.ok(fs.existsSync(lockFile(dir)), 'a trava ficou para trás');
  const s3 = server(dir, await freePort()); await s3.waitFor(UP);
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).pid, s3.child.pid, 'a nova instância assumiu a trava');
  assert.equal(taskStatus(dir), 'interrupted', 'e executou o boot normal (recuperou a tarefa órfã)');
  s3.kill(); await s3.exited;
});

test('encerramento normal (process.exit) libera a trava; encerrar outra vez não falha', async () => {
  const dir = newDir();
  const code = `import { acquireInstanceLock } from ${JSON.stringify(LOCK_MOD)};
    const l = acquireInstanceLock({ dir: ${JSON.stringify(dir)}, autoRelease: true }); if (!l.ok) process.exit(9); process.exit(0);`;
  const run = () => new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', windowsHide: true }); children.add(c); c.on('exit', resolve); });
  assert.equal(await run(), 0); assert.equal(fs.existsSync(lockFile(dir)), false, 'liberada pelo handler de saída');
  assert.equal(await run(), 0, 'e uma nova instância consegue assumir logo em seguida');
});

test('falha de inicialização depois da trava (porta ocupada por outro programa) libera a trava', async () => {
  const dir = newDir(), blocker = net.createServer(), port = await new Promise((r) => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
  try {
    const s = server(dir, port);
    assert.notEqual(await s.exited, 0); assert.match(s.out(), /EADDRINUSE/);
    assert.equal(fs.existsSync(lockFile(dir)), false, 'a trava não fica presa quando o boot falha');
  } finally { blocker.close(); }
});
