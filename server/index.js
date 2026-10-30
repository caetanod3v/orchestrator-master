import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { uid, now } from './store.js';
import { claudeCodeExecutor as realExecutor } from './executor/index.js';
import { gitInfo } from './git.js';
import { validateDir, setupWorkspaceRemoval } from './workspaces.js';
import { setupExecution, blockedReason } from './execution.js';
import { missionStatus } from './mission-status.js';
import { setupCycle, DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS } from './cycle.js';
import { createClaudePlanner, plannerConfigFromEnv } from './planner.js';
import { routingFromEnv, createRouter } from './routing.js';
import { cycleLimitsFromEnv } from './limits.js';
import { planModeFromEnv } from './plan.js';
import { setupChat } from './chat.js';
import { summarizeUsage } from './usage.js';
import { createVerifier, setupVerification } from './verify.js';
import { acquireInstanceLock } from './instance-lock.js';
import { createChildRegistry } from './child-registry.js';
import { installShutdown } from './shutdown.js';

// Costura de teste: só código em processo (nunca env, rede ou requisição) pode injetar executor/planner simulados.
const testDeps = globalThis.__ORCH_TEST_DEPS__ ?? {};
const claudeCodeExecutor = testDeps.executor ?? realExecutor;
const routingMode = routingFromEnv(); // ORCH_PLANNER_ROUTING=off|on (padrão off); valor inválido impede o boot, antes de qualquer acesso a dados
const router = routingMode === 'on' ? createRouter() : null;
const cycleLimits = cycleLimitsFromEnv(); // ORCH_CYCLE_MAX_PLANNER_CALLS / ORCH_CYCLE_MAX_ESTIMATED_COST_USD (padrão: desativados); valor inválido impede o boot
const multiStepPlan = planModeFromEnv(); // ORCH_CYCLE_PLAN=on|off (padrão off): permite o Planner propor um plano de várias etapas (M4); valor inválido impede o boot
const childRegistry = createChildRegistry(); // PIDs do Planner e do verificador no banco (db.childProcesses), para o boot reclamar o que um servidor anterior deixou vivo
const planner = testDeps.planner ?? createClaudePlanner({ ...plannerConfigFromEnv(), routing: routingMode, track: childRegistry.track }); // ORCH_PLANNER_MODEL / ORCH_PLANNER_EFFORT (opcionais); valor inválido impede o boot
const verifier = testDeps.verifier ?? createVerifier({ track: childRegistry.track });
const planning = () => planner.busy();

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1'; // somente local
// Trava de instância ANTES de qualquer operação que possa tocar o banco (load, setupExecution, recover): uma 2ª instância sai sem alterar nada.
const lock = acquireInstanceLock({ dir: store.dataDir, autoRelease: true });
if (!lock.ok) { console.error(`[orchestrator] ${lock.message}`); process.exit(1); }
installShutdown({ lock, executor: claudeCodeExecutor, children: [planner, verifier], store }); // ao sair: encerra os filhos (executor, Planner, verificador), grava o que está pendente e libera a trava
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
// blockedReason: motivo pelo qual a tarefa não pode rodar agora (calculado no servidor).
const withStatus = (m) => ({ ...m, status: missionStatus(m), tasks: m.tasks.map((t) => ({ ...t, blockedReason: blockedReason(db, claudeCodeExecutor, m, t) })) });

// ---------- Estado geral ----------
app.get('/api/state', async (req, res) => {
  const probe = await claudeCodeExecutor.probe();
  const tasks = visibleMissions().flatMap((m) => m.tasks);
  res.json({
    system: claudeCodeExecutor.isBusy() || planning() ? 'running' : probe.available ? 'idle' : 'degraded',
    executor: { id: claudeCodeExecutor.id, connected: probe.available, busy: claudeCodeExecutor.isBusy(), current: claudeCodeExecutor.current(), ...probe },
    planner: { connected: probe.available, busy: planning(), detail: probe.available ? 'Planner pronto (Claude Code sem ferramentas).' : probe.detail },
    counts: {
      activeAgents: (claudeCodeExecutor.isBusy() ? 1 : 0) + (planning() ? 1 : 0),
      running: tasks.filter((t) => t.status === 'running').length,
      pending: tasks.filter((t) => ['queued', 'awaiting_approval'].includes(t.status)).length,
      awaitingApproval: tasks.filter((t) => t.status === 'awaiting_approval').length,
    },
    persistenceIncident: store.persistenceIncident(), // aditivo (M2): último incidente de gravação (início, nº de falhas, quando foi reconciliado); null se nunca houve
    persistence: store.persistenceStatus(), // aditivo: ok, código do último erro, quando falhou e quantas falhas seguidas (sem caminhos)
    settings: { cycleMaxIterations: DEFAULT_MAX_ITERATIONS, ...db.settings, cycleHardMax: HARD_MAX_ITERATIONS },
    activeWorkspace: find(db.workspaces, db.settings.activeWorkspaceId) || null,
    // costUsd/runs (legado: execuções reais que reportaram custo) + durationMs + tokens agregados por agente/missão/ciclo (ver usage.js); null sem nenhum dado
    usage: summarizeUsage(visibleMissions(), db.chat),
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
  if (m.tasks.some((t) => t.status === 'running') || (m.cycle && ['planning', 'running'].includes(m.cycle.status))) return bad(res, 'Há uma tarefa ou ciclo em andamento nesta missão.', 409);
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
    { id: 'planner', name: 'Planner', role: 'Decide a próxima tarefa a partir do objetivo e dos relatórios do Executor (continue, complete ou blocked). Não tem ferramentas: só recebe e devolve texto.', status: planning() ? 'running' : probe.available ? 'idle' : 'not_connected', detail: planning() ? 'Planejando a próxima rodada.' : probe.available ? 'Pronto: usa o Claude Code sem ferramentas e é validado pelo backend.' : probe.detail, availability: probe.available ? 'connected' : 'unavailable' },
    { id: 'executor', name: 'Executor (Claude Code)', role: 'Executa uma tarefa autorizada por vez no workspace da missão, com permissões padrão (leitura e edição de arquivos).', status: claudeCodeExecutor.isBusy() ? 'running' : probe.available ? 'idle' : 'not_connected', detail: claudeCodeExecutor.isBusy() ? 'Executando uma tarefa.' : probe.detail, version: probe.version || null, available: probe.available, availability: probe.available ? 'connected' : 'unavailable' },
  ]);
});

app.get('/api/activity', (req, res) => res.json(db.activity.slice(0, 200)));

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.showDemoData === 'boolean') db.settings.showDemoData = b.showDemoData;
  if (b.cycleMaxIterations !== undefined) {
    if (!Number.isInteger(b.cycleMaxIterations) || b.cycleMaxIterations < 1 || b.cycleMaxIterations > HARD_MAX_ITERATIONS) return bad(res, `cycleMaxIterations deve ser um inteiro de 1 a ${HARD_MAX_ITERATIONS}.`);
    db.settings.cycleMaxIterations = b.cycleMaxIterations;
  }
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

const { startTaskRun } = setupExecution(app, { db, executor: claudeCodeExecutor, verifier });
childRegistry.reclaim({ executor: claudeCodeExecutor }); // órfãos do Planner/verificador: depois dos do Executor, antes de qualquer ciclo (setupCycle) e de ouvir a porta
setupVerification(app, { db, verifier });
setupWorkspaceRemoval(app, { db });
const cycle = setupCycle(app, { db, executor: claudeCodeExecutor, planner, startTaskRun, verifier, router, limits: cycleLimits, multiStep: multiStepPlan });
setupChat(app, { db, planner, cycle, multiStep: multiStepPlan }); // M5: chat geral; só prepara propostas, executar exige /api/chat/approve

app.use('/api', (req, res) => bad(res, 'Rota não encontrada.', 404));
app.use((err, req, res, next) => bad(res, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.', err.status || 500));
app.listen(PORT, HOST, () => console.log(`AI Dev Orchestrator API em http://${HOST}:${PORT}`));
