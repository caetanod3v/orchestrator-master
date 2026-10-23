import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { uid, now } from './store.js';
import { claudeCodeExecutor } from './executor/index.js';
import { gitInfo } from './git.js';
import { validateDir } from './workspaces.js';
import { setupExecution, blockedReason } from './execution.js';

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1'; // somente local
const db = store.load();
const app = express();
app.use(express.json({ limit: '100kb' }));

// Bloqueia requisições de outras origens (proteção contra CSRF vindo de páginas externas).
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return res.status(403).json({ error: 'Origem não permitida.' });
  }
  next();
});

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const find = (arr, id) => arr.find((x) => x.id === id);
const commit = () => store.save();

function visibleMissions() {
  return db.settings.showDemoData ? db.missions : db.missions.filter((m) => !m.demo);
}
function missionStatus(m) {
  const s = m.tasks.map((t) => t.status);
  if (!s.length) return 'queued';
  if (s.includes('running')) return 'running';
  if (s.includes('failed')) return 'failed';
  if (s.includes('interrupted')) return 'interrupted';
  if (s.includes('awaiting_approval')) return 'awaiting_approval';
  if (s.every((x) => x === 'completed')) return 'completed';
  return 'queued';
}
// blockedReason: motivo pelo qual a tarefa não pode rodar agora (calculado no servidor).
const withStatus = (m) => ({ ...m, status: missionStatus(m), tasks: m.tasks.map((t) => ({ ...t, blockedReason: blockedReason(db, claudeCodeExecutor, m, t) })) });

// ---------- Estado geral ----------
app.get('/api/state', async (req, res) => {
  const probe = await claudeCodeExecutor.probe();
  const tasks = visibleMissions().flatMap((m) => m.tasks);
  res.json({
    system: claudeCodeExecutor.isBusy() ? 'running' : probe.available ? 'idle' : 'degraded',
    executor: { id: claudeCodeExecutor.id, connected: probe.available, busy: claudeCodeExecutor.isBusy(), current: claudeCodeExecutor.current(), ...probe },
    planner: { connected: false, detail: 'Planejador ainda não implementado.' },
    counts: {
      activeAgents: claudeCodeExecutor.isBusy() ? 1 : 0,
      running: tasks.filter((t) => t.status === 'running').length,
      pending: tasks.filter((t) => ['queued', 'awaiting_approval'].includes(t.status)).length,
      awaitingApproval: tasks.filter((t) => t.status === 'awaiting_approval').length,
    },
    settings: db.settings,
    activeWorkspace: find(db.workspaces, db.settings.activeWorkspaceId) || null,
    usage: (() => { // somado apenas de execuções reais que reportaram custo
      const u = tasks.map((t) => t.usage).filter((x) => x && typeof x.costUsd === 'number');
      return u.length ? { costUsd: u.reduce((a, x) => a + x.costUsd, 0), runs: u.length } : null;
    })(),
  });
});

// ---------- Workspaces ----------
app.get('/api/workspaces', (req, res) => res.json(db.workspaces));

app.post('/api/workspaces/validate', (req, res) => res.json(validateDir(req.body?.path)));

app.post('/api/workspaces', (req, res) => {
  const v = validateDir(req.body?.path);
  if (!v.ok) return bad(res, v.error);
  if (db.workspaces.some((w) => w.path.toLowerCase() === v.path.toLowerCase())) {
    return bad(res, 'Workspace já cadastrado.', 409);
  }
  const ws = {
    id: uid('ws'),
    name: str(req.body?.name, 80) || path.basename(v.path),
    path: v.path,
    hasGit: v.hasGit,
    hasPackageJson: v.hasPackageJson,
    createdAt: now(),
  };
  db.workspaces.push(ws);
  if (!db.settings.activeWorkspaceId) db.settings.activeWorkspaceId = ws.id;
  store.log('workspace', `Workspace cadastrado: ${ws.name}`, { workspaceId: ws.id });
  commit();
  res.status(201).json(ws);
});

app.post('/api/workspaces/:id/activate', (req, res) => {
  const ws = find(db.workspaces, req.params.id);
  if (!ws) return bad(res, 'Workspace não encontrado.', 404);
  db.settings.activeWorkspaceId = ws.id;
  store.log('workspace', `Workspace ativo: ${ws.name}`, { workspaceId: ws.id });
  commit();
  res.json(ws);
});

app.delete('/api/workspaces/:id', (req, res) => {
  const ws = find(db.workspaces, req.params.id);
  if (!ws) return bad(res, 'Workspace não encontrado.', 404);
  if (db.missions.some((m) => m.workspaceId === ws.id && m.tasks.some((t) => t.status === 'running'))) return bad(res, 'Há uma execução em andamento neste workspace.', 409);
  db.workspaces = db.workspaces.filter((w) => w.id !== ws.id);
  if (db.settings.activeWorkspaceId === ws.id) db.settings.activeWorkspaceId = db.workspaces[0]?.id ?? null;
  store.log('workspace', `Workspace removido do cadastro: ${ws.name} (arquivos intactos)`);
  commit();
  res.status(204).end();
});

app.get('/api/workspaces/:id/git', async (req, res) => {
  const ws = find(db.workspaces, req.params.id);
  if (!ws) return bad(res, 'Workspace não encontrado.', 404);
  res.json(await gitInfo(ws.path));
});

// ---------- Missões ----------
app.get('/api/missions', (req, res) => res.json(visibleMissions().map(withStatus)));

app.get('/api/missions/:id', (req, res) => {
  const m = find(db.missions, req.params.id);
  if (!m) return bad(res, 'Missão não encontrada.', 404);
  res.json(withStatus(m));
});

app.post('/api/missions', (req, res) => {
  const title = str(req.body?.title, 120);
  if (!title) return bad(res, 'Título obrigatório.');
  const workspaceId = req.body?.workspaceId || db.settings.activeWorkspaceId || null;
  if (workspaceId && !find(db.workspaces, workspaceId)) return bad(res, 'Workspace inválido.');
  const m = {
    id: uid('mis'),
    demo: false,
    title,
    objective: str(req.body?.objective, 2000),
    workspaceId,
    createdAt: now(),
    tasks: [],
  };
  db.missions.unshift(m);
  store.log('mission', `Missão criada: ${title}`, { missionId: m.id });
  commit();
  res.status(201).json(withStatus(m));
});

app.delete('/api/missions/:id', (req, res) => {
  const m = find(db.missions, req.params.id);
  if (!m) return bad(res, 'Missão não encontrada.', 404);
  if (m.tasks.some((t) => t.status === 'running')) return bad(res, 'Há uma tarefa em execução nesta missão.', 409);
  db.missions = db.missions.filter((x) => x.id !== m.id);
  store.log('mission', `Missão removida: ${m.title}`);
  commit();
  res.status(204).end();
});

// Tarefas (hoje criadas manualmente; o planejador as gerará no futuro).
app.post('/api/missions/:id/tasks', (req, res) => {
  const m = find(db.missions, req.params.id);
  if (!m) return bad(res, 'Missão não encontrada.', 404);
  const title = str(req.body?.title, 200);
  if (!title) return bad(res, 'Título da tarefa obrigatório.');
  const dependsOn = Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.filter((d) => find(m.tasks, d)) : [];
  const task = { id: uid('task'), title, status: 'queued', authorized: false, dependsOn, report: '', files: [], log: [] };
  m.tasks.push(task);
  store.log('task', `Tarefa adicionada: ${title}`, { missionId: m.id, taskId: task.id });
  commit();
  res.status(201).json(task);
});

app.delete('/api/missions/:id/tasks/:tid', (req, res) => {
  const m = find(db.missions, req.params.id);
  const task = m && find(m.tasks, req.params.tid);
  if (!task) return bad(res, 'Tarefa não encontrada.', 404);
  if (task.status === 'running') return bad(res, 'Tarefa em execução não pode ser removida.', 409);
  m.tasks = m.tasks.filter((t) => t.id !== task.id);
  m.tasks.forEach((t) => (t.dependsOn = t.dependsOn.filter((d) => d !== task.id)));
  store.log('task', `Tarefa removida: ${task.title}`, { missionId: m.id });
  commit();
  res.status(204).end();
});

function decide(kind) {
  return (req, res) => {
    const m = find(db.missions, req.params.id);
    const task = m && find(m.tasks, req.params.tid);
    if (!task) return bad(res, 'Tarefa não encontrada.', 404);
    if (task.status !== 'awaiting_approval') return bad(res, 'A tarefa não está aguardando aprovação.', 409);
    task.status = kind === 'approve' ? 'completed' : 'failed';
    task.rejected = kind === 'reject'; // distingue rejeição humana de falha de execução
    task.decidedAt = now();
    store.log(
      kind === 'approve' ? 'approval' : 'rejection',
      `${kind === 'approve' ? 'Aprovada' : 'Rejeitada'}: ${task.title}${m.demo ? ' [demo]' : ''}`,
      { missionId: m.id, taskId: task.id },
    );
    commit();
    res.json(task);
  };
}
app.post('/api/missions/:id/tasks/:tid/approve', decide('approve'));
app.post('/api/missions/:id/tasks/:tid/reject', decide('reject'));

// ---------- Agentes, atividade, configurações ----------
app.get('/api/agents', async (req, res) => {
  const probe = await claudeCodeExecutor.probe();
  res.json([
    { id: 'planner', name: 'Planner', role: 'Divide a missão em tarefas, analisa relatórios e propõe a próxima tarefa.', status: 'not_connected', detail: 'Não implementado nesta fase.', availability: 'unavailable' },
    { id: 'executor', name: 'Executor (Claude Code)', role: 'Executa uma tarefa autorizada por vez no workspace da missão, com permissões padrão (leitura e edição de arquivos).', status: claudeCodeExecutor.isBusy() ? 'running' : probe.available ? 'idle' : 'not_connected', detail: claudeCodeExecutor.isBusy() ? 'Executando uma tarefa.' : probe.detail, version: probe.version || null, available: probe.available, availability: probe.available ? 'connected' : 'unavailable' },
  ]);
});

app.get('/api/activity', (req, res) => res.json(db.activity.slice(0, 200)));

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.showDemoData === 'boolean') db.settings.showDemoData = b.showDemoData;
  // requireApproval é fixo: aprovação humana é obrigatória.
  store.log('settings', 'Configurações atualizadas');
  commit();
  res.json(db.settings);
});

// ---------- Frontend buildado (opcional) ----------
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

setupExecution(app, { db, executor: claudeCodeExecutor });

app.use('/api', (req, res) => bad(res, 'Rota não encontrada.', 404));
app.use((err, req, res, next) => bad(res, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.', err.status || 500));
app.listen(PORT, HOST, () => console.log(`AI Dev Orchestrator API em http://${HOST}:${PORT}`));
