// Teste REAL (consome creditos do Claude): servidor real + Claude Code real num workspace de teste dentro do repositorio (.test-workspace, ignorado pelo git). Rode: npm run test:real
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url))); // raiz do repositorio, em qualquer pasta e sistema
const WS = path.join(ROOT, '.test-workspace');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS);
execFileSync('git', ['init', '-q'], { cwd: WS });
fs.writeFileSync(`${WS}/LEIAME.txt`, 'Workspace de teste do FORGE.\n');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-real-'));
const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '4398', ORCH_DATA_DIR: data }, stdio: 'ignore' });
const B = 'http://127.0.0.1:4398';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  for (let i = 0; i < 30; i++) { try { await fetch(B + '/api/state'); break; } catch { await sleep(300); } }
  const ws = (await api('POST', '/api/workspaces', { path: WS, name: 'test-workspace' })).body;
  const m = (await api('POST', '/api/missions', { title: 'Teste real do executor', objective: 'Validar a integração com o Claude Code em um workspace de teste.', workspaceId: ws.id })).body;
  const t = (await api('POST', `/api/missions/${m.id}/tasks`, { title: 'Crie o arquivo hello.txt na raiz contendo exatamente a frase: olá do orquestrador. Não altere nenhum outro arquivo.' })).body;
  const P = `/api/missions/${m.id}/tasks/${t.id}`;
  console.log('sem autorização ->', (await api('POST', `${P}/run`)).body.error);
  console.log('autorizar ->', (await api('POST', `${P}/authorize`)).status);

  // SSE em paralelo, contando eventos recebidos
  const seen = { log: 0, task: 0 };
  const ctrl = new AbortController();
  fetch(B + '/api/events', { signal: ctrl.signal }).then(async (r) => { const rd = r.body.getReader(); const d = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; const s = d.decode(value); seen.log += (s.match(/event: log/g) || []).length; seen.task += (s.match(/event: task/g) || []).length; } }).catch(() => {});

  const t0 = Date.now();
  const run = await api('POST', `${P}/run`);
  console.log('run ->', run.status, run.body?.status ?? run.body?.error);
  let cur;
  while (Date.now() - t0 < 240000) {
    cur = (await api('GET', `/api/missions/${m.id}`)).body.tasks[0];
    if (cur.status !== 'running') break;
    await sleep(1000);
  }
  ctrl.abort();
  console.log('\n=== resultado ===');
  console.log('status:', cur.status, '| exit:', cur.exitCode, '| erro:', cur.error, '| duração(s):', ((Date.now() - t0) / 1000).toFixed(1));
  console.log('uso real:', JSON.stringify(cur.usage));
  console.log('relatório:', cur.report);
  console.log('arquivos:', JSON.stringify(cur.files));
  console.log('eventos SSE recebidos:', JSON.stringify(seen));
  console.log('--- log ---\n' + cur.log.join('\n'));
  console.log('--- disco ---');
  console.log('hello.txt existe:', fs.existsSync(`${WS}/hello.txt`), '->', fs.existsSync(`${WS}/hello.txt`) ? JSON.stringify(fs.readFileSync(`${WS}/hello.txt`, 'utf8')) : '');
  console.log('LEIAME.txt intacto:', fs.readFileSync(`${WS}/LEIAME.txt`, 'utf8') === 'Workspace de teste do FORGE.\n');
  console.log('git status:', execFileSync('git', ['status', '--porcelain'], { cwd: WS }).toString().trim());
  console.log('commits no workspace:', (() => { try { return execFileSync('git', ['log', '--oneline'], { cwd: WS, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'nenhum'; } catch { return 'nenhum'; } })());
} finally {
  server.kill();
}
