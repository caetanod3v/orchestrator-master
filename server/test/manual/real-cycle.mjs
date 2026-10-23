// Teste MANUAL com o Claude Code REAL (consome créditos pequenos): ciclo Planner -> Executor -> Planner
// em um workspace descartável dentro do projeto. Uso: npm run test:real-cycle
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WS = path.join(ROOT, '.test-workspace');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS);
execFileSync('git', ['init', '-q'], { cwd: WS });
fs.writeFileSync(path.join(WS, 'LEIAME.txt'), 'Workspace de teste do ciclo.\n');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-realcycle-'));
const B = 'http://127.0.0.1:4395';
const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '4395', ORCH_DATA_DIR: data }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  for (let i = 0; i < 30; i++) { try { await fetch(B + '/api/state'); break; } catch { await sleep(300); } }
  const ws = (await api('POST', '/api/workspaces', { path: WS, name: 'test-workspace' })).body;
  const m = (await api('POST', '/api/missions', {
    title: 'Criar saudacao.txt',
    objective: 'Criar na raiz do workspace o arquivo saudacao.txt contendo exatamente a frase "olá do ciclo". Critério de aceitação: o arquivo existe, tem exatamente essa frase e nenhum outro arquivo foi alterado.',
    workspaceId: ws.id,
  })).body;
  const t0 = Date.now();
  const start = await api('POST', `/api/missions/${m.id}/cycle/start`, { maxIterations: 3 });
  console.log('start ->', start.status, start.body?.error ?? start.body?.status);
  let mis;
  while (Date.now() - t0 < 420000) {
    mis = (await api('GET', `/api/missions/${m.id}`)).body;
    if (!['planning', 'running'].includes(mis.cycle.status)) break;
    await sleep(2000);
  }
  const c = mis.cycle;
  console.log(`\n=== ciclo: ${c.status} em ${((Date.now() - t0) / 1000).toFixed(0)} s | rodadas: ${c.rounds.length}/${c.maxIterations} | consultas ao Planner: ${c.plannerCalls} ===`);
  if (c.blockedReason) console.log('bloqueio:', c.blockedCode, '-', c.blockedReason);
  for (const r of c.rounds) {
    console.log(`\n[rodada ${r.n}] ${r.plan.title} -> ${r.status}`);
    console.log('  plano:', r.plan.rationale);
    console.log('  instruções:', r.plan.instructions.slice(0, 300));
    console.log('  relatório:', r.report?.status, '|', (r.report?.summary || '').slice(0, 300).replace(/\n/g, ' '));
    console.log('  arquivos:', (r.report?.filesChanged || []).map((f) => f.path).join(', '), '| verificações:', (r.report?.checks || []).map((x) => `${x.name}=${x.result}`).join('; ') || (r.report?.checksReported ? 'nenhuma' : 'não reportadas'));
    console.log('  custo executor:', JSON.stringify(r.report?.usage), '| decisão:', r.decision ? `${r.decision.decision} - ${r.decision.rationale.slice(0, 200)}` : '-');
  }
  if (c.rejections.length) console.log('\nrespostas do Planner REJEITADAS:', JSON.stringify(c.rejections, null, 1));
  if (c.finalSummary) console.log('\nconclusão:', c.finalSummary, '\nevidências:', JSON.stringify(c.evidence));
  const f = path.join(WS, 'saudacao.txt');
  console.log('\n--- disco ---\nsaudacao.txt existe:', fs.existsSync(f), fs.existsSync(f) ? JSON.stringify(fs.readFileSync(f, 'utf8')) : '');
  console.log('LEIAME.txt intacto:', fs.readFileSync(path.join(WS, 'LEIAME.txt'), 'utf8') === 'Workspace de teste do ciclo.\n');
  console.log('git status:', execFileSync('git', ['status', '--porcelain'], { cwd: WS }).toString().trim().replace(/\n/g, ' | '));
  console.log('commits:', (() => { try { return execFileSync('git', ['log', '--oneline'], { cwd: WS, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'nenhum'; } catch { return 'nenhum'; } })());
} finally {
  server.kill();
}
