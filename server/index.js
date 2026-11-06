import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { uid, now } from './store.js';
import { claudeCodeExecutor as realExecutor } from './executor/index.js';
import { gitInfo } from './git.js';
import { validateDir, setupWorkspaceRemoval, setupWorkspaceRename } from './workspaces.js';
import { topicsState, openAndActivate, snapshotTabs, restoreTabs, setupWorkspaceTabs, setupTopics } from './topics.js';
import { setupUiSettings } from './ui-settings.js';
import { createLoadouts, setupLoadouts } from './loadouts.js';
import { setupLayouts } from './layouts.js';
import { createConversationStore, setupConversations, startConversationCapture } from './conversations.js';
import { setupExecution, blockedReason } from './execution.js';
import { missionStatus } from './mission-status.js';
import { deliveryOf } from './delivery.js';
import { threadOf } from './result-message.js';
import { setupCycle, DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS } from './cycle.js';
import { createClaudePlanner, plannerConfigFromEnv } from './planner.js';
import { routingFromEnv, createRouter } from './routing.js';
import { cycleLimitsFromEnv } from './limits.js';
import { planModeFromEnv, stepRetriesFromEnv, resolveOrchestration, MAX_STEP_ATTEMPTS, MAX_STEP_RETRIES } from './plan.js';
import { resolveSupervision, supervisionMs, MAX_MINUTES_LIMIT, STALL_MINUTES_LIMIT, MAX_AUTO_RESUMES } from './supervisor.js';
import { resolveWorktreeIsolation, createWorktreeManager, setupWorktrees } from './worktrees.js';
import { createTerminalManager, setupTerminals } from './terminals.js';
import { createUsageReader } from './terminal-usage.js';
import { createMaestro, setupMaestro, stableServerName } from './maestro.js';
import { setupChat } from './chat.js';
import { summarizeUsage } from './usage.js';
import { createVerifier, setupVerification } from './verify.js';
import { acquireInstanceLock, pidAlive } from './instance-lock.js';
import { createChildRegistry } from './child-registry.js';
import { installShutdown } from './shutdown.js';
import { apiGuard } from './origin-guard.js';
import { consumeApiTokenFromEnv, createTokenGuard } from './session-token.js';

const apiToken = consumeApiTokenFromEnv(); // M2: lido e REMOVIDO de process.env antes de qualquer processo filho existir (ver session-token.js)

// Costura de teste: só código em processo (nunca env, rede ou requisição) pode injetar executor/planner simulados.
const testDeps = globalThis.__ORCH_TEST_DEPS__ ?? {};
const claudeCodeExecutor = testDeps.executor ?? realExecutor;
const routingMode = routingFromEnv(); // ORCH_PLANNER_ROUTING=off|on (padrão off); valor inválido impede o boot, antes de qualquer acesso a dados
const router = routingMode === 'on' ? createRouter() : null;
const cycleLimits = cycleLimitsFromEnv(); // ORCH_CYCLE_MAX_PLANNER_CALLS / ORCH_CYCLE_MAX_ESTIMATED_COST_USD (padrão: desativados); valor inválido impede o boot
stepRetriesFromEnv(); // ORCH_CYCLE_MAX_STEP_RETRIES=0|1|2|off: valor inválido impede o boot, antes de qualquer dado. O valor EFETIVO (ambiente > configurações > padrão) é resolvido por orchestration()
planModeFromEnv(); // ORCH_CYCLE_PLAN=on|off: valor inválido impede o boot, antes de qualquer dado. O valor EFETIVO (ambiente > configurações > padrão) é resolvido por orchestration()
resolveWorktreeIsolation({ settings: {} }); // Marco C: ORCH_WORKTREE_ISOLATION=on|off; valor inválido impede o boot, antes de qualquer dado
resolveSupervision({ settings: {} }); // Marco B: ORCH_CYCLE_SUPERVISOR / _MAX_MINUTES / _STALL_MINUTES / _AUTO_RESUMES; valor inválido impede o boot, antes de qualquer dado
const childRegistry = createChildRegistry(); // PIDs do Planner e do verificador no banco (db.childProcesses), para o boot reclamar o que um servidor anterior deixou vivo
const planner = testDeps.planner ?? createClaudePlanner({ ...plannerConfigFromEnv(), routing: routingMode, track: childRegistry.track }); // ORCH_PLANNER_MODEL / ORCH_PLANNER_EFFORT (opcionais); valor inválido impede o boot
const verifier = testDeps.verifier ?? createVerifier({ track: childRegistry.track });
const planning = () => planner.busy();

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1'; // somente local
// Trava de instância ANTES de qualquer operação que possa tocar o banco (load, setupExecution, recover): uma 2ª instância sai sem alterar nada.
const lock = acquireInstanceLock({ dir: store.dataDir, autoRelease: true });
if (!lock.ok) { console.error(`[orchestrator] ${lock.message}`); process.exit(1); }
installShutdown({ lock, executor: claudeCodeExecutor, children: [planner, verifier, { killActiveSync: () => worktrees.killActiveSync() }, { killActiveSync: () => terminals.killAllSync() }], store }); // ao sair: encerra os filhos (executor, Planner, verificador), grava o que está pendente e libera a trava
const db = store.load();
// Configuração efetiva de planejamento e retentativas (I4): ambiente > db.settings > padrão (desligados). Lida a cada mensagem do chat e a cada laço do ciclo.
const orchestration = () => resolveOrchestration({ settings: db.settings });
// Supervisão autônoma (Marco B): mesma precedência (ambiente > configurações > padrão DESLIGADO), lida a cada laço do ciclo.
const supervision = () => resolveSupervision({ settings: db.settings });
// Worktrees isolados (Marco C): execução do ciclo fora do workspace principal. Padrão DESLIGADO (ambiente > configurações > padrão). A recuperação só concilia o registro com o Git: não relança missões nem remove nada.
const worktreeIsolation = () => resolveWorktreeIsolation({ settings: db.settings });
const worktrees = createWorktreeManager({ db, track: childRegistry.track, children: childRegistry });
// Credenciais MCP dos panes: com ORCH_DATA_DIR (testes, app desktop) ficam na pasta de dados; no modo dev, FORA do repositório (um agente com cwd no repositório leria data/ sem pedir permissão).
const mcpDir = process.env.ORCH_DATA_DIR ? path.join(store.dataDir, 'mcp') : path.join(process.env.LOCALAPPDATA || os.homedir(), 'ai-dev-orchestrator', 'mcp');
const maestro = createMaestro({ getTerminals: () => terminals, mcpDir, url: `http://127.0.0.1:${PORT}/mcp`, serverName: stableServerName(db, { save: store.saveOrThrow }) }); // nome com sufixo aleatório POR INSTALAÇÃO (estável entre boots, ver maestro.js): um .mcp.json homônimo não herda a pré-autorização // coordenação entre panes por MCP local (aprovação do usuário por padrão)
// Conversas copiadas: com ORCH_DATA_DIR (testes, app desktop) na pasta de dados; no modo dev, FORA do repositório (mesmo motivo do mcpDir).
const historyDir = process.env.ORCH_DATA_DIR ? path.join(store.dataDir, 'history') : path.join(process.env.LOCALAPPDATA || os.homedir(), 'ai-dev-orchestrator', 'history');
// Skills por papel (loadouts.js): plugins de sessão gerados numa pasta própria, FORA do workspace do usuário (mesmo critério do mcpDir/historyDir).
const loadoutsDir = process.env.ORCH_DATA_DIR ? path.join(store.dataDir, 'loadouts') : path.join(process.env.LOCALAPPDATA || os.homedir(), 'ai-dev-orchestrator', 'loadouts');
const loadouts = createLoadouts({ db, dir: loadoutsDir });
const conversations = createConversationStore({ dir: historyDir }); // histórico de conversas próprio, por workspace (texto das trocas; ver conversations.js)
const terminals = createTerminalManager({ db, loadouts, onEnd: (rec) => { if (db.workspaces.some((w) => w.id === rec.workspaceId)) conversations.sync(rec); }, track: childRegistry.track, worktrees, mcp: maestro, persist: store.saveOrThrow, isChildAlive: (terminalId) => childRegistry.pending().some((r) => r && r.kind === 'terminal' && r.terminalId === terminalId && pidAlive(r.pid)), usage: createUsageReader({ pricesFile: path.join(store.dataDir, 'pricing.json') }) }); // terminais interativos (PTY) do Claude Code: um processo por pane, em paralelo
let worktreeRecovery = { settled: [], inconsistent: [], unregistered: [], unverified: [] }; // E3: preenchido logo DEPOIS do reclaim dos processos filhos (abaixo)
const app = express();
// Host válido em toda a /api, Origin permitido quando enviado e OBRIGATÓRIO em POST/PUT/PATCH/DELETE (CSRF, DNS rebinding e chamadas locais sem Origin; ver origin-guard.js).
// ANTES do parser de JSON: uma requisição recusada nem chega a ter o corpo lido (e um corpo malformado vindo de origem externa dá 403, não 400).
app.use('/api', apiGuard);
if (apiToken) app.use('/api', createTokenGuard(apiToken)); // M2: com token (app desktop), ações mutáveis e fluxos de terminal só da interface
app.use(express.json({ limit: '100kb' }));

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
  const o = orchestration(), sv = supervision();
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
    orchestration: { planMode: o.planMode, stepRetries: o.stepRetries, maxStepAttempts: MAX_STEP_ATTEMPTS, hardMaxIterations: HARD_MAX_ITERATIONS, source: o.source }, // efetivo + origem (env | settings | default)
    worktrees: { isolation: worktreeIsolation(), items: worktrees.list(), unregistered: worktreeRecovery.unregistered }, // Marco C, aditivo
    supervision: sv, // Marco B, aditivo: { supervisor, maxMinutes, stallMinutes, autoResumes, source } — efetivo + origem de cada valor
    activeWorkspace: find(db.workspaces, db.settings.activeWorkspaceId) || null,
    ...topicsState(db), // aditivo: openWorkspaceIds[] (abas), topics[] (só não arquivados) e activeTopicIds{ wsId: topicId }
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
  const snap = snapshotTabs(db);
  try {
    db.workspaces.push(ws);
    if (!db.settings.activeWorkspaceId) openAndActivate(db, ws.id); // o novo só vira ativo (e abre a aba) se não havia nenhum; senão fica cadastrado e fechado até open/activate
    store.saveOrThrow();
  } catch {
    db.workspaces.pop(); restoreTabs(db, snap);
    return bad(res, 'Não foi possível cadastrar o workspace: o banco não pôde ser gravado; nada foi alterado.', 500);
  }
  store.log('workspace', `Workspace cadastrado: ${ws.name}`, { workspaceId: ws.id });
  commit();
  res.status(201).json(ws);
});

app.post('/api/workspaces/:id/activate', (req, res) => {
  const ws = find(db.workspaces, req.params.id);
  if (!ws) return bad(res, 'Workspace não encontrado.', 404);
  const snap = snapshotTabs(db);
  try { openAndActivate(db, ws.id); store.saveOrThrow(); } catch { // ativar abre a aba implicitamente
    restoreTabs(db, snap);
    return bad(res, 'Não foi possível ativar o workspace: o banco não pôde ser gravado; nada foi alterado.', 500);
  }
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

// Relatório de entrega: somente leitura, derivado dos registros gravados (delivery.js). Nunca grava nem altera o estado da missão.
const deliveryFor = (m) => deliveryOf(m, find(db.workspaces, m.workspaceId) || null, { worktrees: db.worktrees, environments: Object.fromEntries((db.worktrees || []).filter((w) => w.missionId === m.id && w.prepare?.state === 'ready').map((w) => { const e = worktrees.environmentFor(w.id); return [w.id, { ok: e.ok, code: e.code }]; })) }); // E5: checagem ATUAL do ambiente só dos que dizem "ready"
app.get('/api/missions/:id/delivery', (req, res) => {
  const m = find(db.missions, req.params.id);
  if (!m) return bad(res, 'Missão não encontrada.', 404);
  const r = deliveryFor(m);
  if (!r.ok) return bad(res, r.error, 500);
  res.json(r.report);
});
// Conversa da missão + mensagem FINAL do orquestrador (derivada do relatório, nunca gravada: sem duplicatas ao reler). Somente leitura.
app.get('/api/missions/:id/thread', (req, res) => {
  const m = find(db.missions, req.params.id);
  if (!m) return bad(res, 'Missão não encontrada.', 404);
  const r = deliveryFor(m);
  res.json(threadOf(m, r.ok ? r.report : null));
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
  // Rodadas (do ciclo atual e dos anteriores) apontam para a tarefa por taskId; removê-la deixaria o histórico e o relatório com referência quebrada.
  const referenced = [m.cycle, ...(m.pastCycles || [])].some((c) => (c?.rounds || []).some((r) => r.taskId === task.id));
  if (referenced) return bad(res, 'A tarefa é referenciada por uma rodada de ciclo e não pode ser removida.', 409);
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
  // Validação ESTRITA de tudo ANTES de aplicar qualquer coisa (nada é gravado pela metade).
  if (b.cycleMaxIterations !== undefined && (!Number.isInteger(b.cycleMaxIterations) || b.cycleMaxIterations < 1 || b.cycleMaxIterations > HARD_MAX_ITERATIONS)) return bad(res, `cycleMaxIterations deve ser um inteiro de 1 a ${HARD_MAX_ITERATIONS}.`);
  if (b.planMode !== undefined && typeof b.planMode !== 'boolean') return bad(res, 'planMode deve ser verdadeiro ou falso.');
  if (b.stepRetries !== undefined && (!Number.isInteger(b.stepRetries) || b.stepRetries < 0 || b.stepRetries > MAX_STEP_RETRIES)) return bad(res, `stepRetries deve ser um inteiro de 0 a ${MAX_STEP_RETRIES}.`);
  if (b.supervisor !== undefined && typeof b.supervisor !== 'boolean') return bad(res, 'supervisor deve ser verdadeiro ou falso.');
  if (b.worktreeIsolation !== undefined && typeof b.worktreeIsolation !== 'boolean') return bad(res, 'worktreeIsolation deve ser verdadeiro ou falso.');
  for (const [k, max] of [['maxMinutes', MAX_MINUTES_LIMIT], ['stallMinutes', STALL_MINUTES_LIMIT], ['autoResumes', MAX_AUTO_RESUMES]]) {
    if (b[k] !== undefined && (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > max)) return bad(res, `${k} deve ser um inteiro de 0 a ${max}.`);
  }
  const orchKeys = ['planMode', 'stepRetries', 'supervisor', 'maxMinutes', 'stallMinutes', 'autoResumes', 'worktreeIsolation'].filter((k) => b[k] !== undefined);
  if (orchKeys.length) {
    const locked = orchKeys.filter((k) => (orchestration().source[k] ?? supervision().source[k] ?? (k === 'worktreeIsolation' ? worktreeIsolation().source : null)) === 'env');
    if (locked.length) return bad(res, `${locked.join(' e ')} ${locked.length > 1 ? 'são definidos' : 'é definido'} pelo ambiente do servidor (variáveis ORCH_CYCLE_*, como ORCH_CYCLE_PLAN) e não podem ser mudados pela interface; altere o ambiente e reinicie.`, 409);
    if (db.missions.some((m) => ['planning', 'running'].includes(m.cycle?.status))) return bad(res, 'Há um ciclo em andamento: aguarde terminar ou cancele antes de mudar o planejamento, as retentativas ou a supervisão.', 409);
  }
  // Aplica e GRAVA com confirmação; se o disco falhar, volta EXATAMENTE ao estado anterior (nada fica só na memória dizendo que foi salvo) e responde 503.
  const KEYS = ['showDemoData', 'cycleMaxIterations', 'planMode', 'stepRetries', 'supervisor', 'maxMinutes', 'stallMinutes', 'autoResumes', 'worktreeIsolation'], prev = new Map(KEYS.map((k) => [k, Object.hasOwn(db.settings, k) ? { v: db.settings[k] } : null]));
  if (typeof b.showDemoData === 'boolean') db.settings.showDemoData = b.showDemoData;
  if (b.cycleMaxIterations !== undefined) db.settings.cycleMaxIterations = b.cycleMaxIterations;
  if (b.planMode !== undefined) db.settings.planMode = b.planMode;
  if (b.stepRetries !== undefined) db.settings.stepRetries = b.stepRetries;
  for (const k of ['supervisor', 'maxMinutes', 'stallMinutes', 'autoResumes', 'worktreeIsolation']) if (b[k] !== undefined) db.settings[k] = b[k];
  // requireApproval é fixo: aprovação humana é obrigatória.
  try { store.saveOrThrow(); } catch (e) {
    for (const [k, p] of prev) { if (p) db.settings[k] = p.v; else delete db.settings[k]; }
    return bad(res, `As configurações NÃO foram salvas (o banco não pôde ser gravado: ${e?.code || e?.message || 'erro'}); nada foi alterado.`, 500); // 500: o contrato existente (persistence-api.test.mjs) para gravação que falha
  }
  store.log('settings', 'Configurações atualizadas'); store.saveSoon();
  res.json(db.settings);
});

// ---------- Frontend buildado (opcional) ----------
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  // CSP restritiva na interface (a UI renderiza saída de terminal e texto de agentes; um XSS alcançaria a API local sem autenticação). O bundle não usa eval, script inline nem hosts externos; 'unsafe-inline' só em estilos (atributos style do React).
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/mcp' || req.path.startsWith('/mcp/')) return next();
    res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(dist));
  app.get(/^(?!\/api)(?!\/mcp(?:\/|$)).*/, (req, res) => res.sendFile(path.join(dist, 'index.html'))); // /mcp nunca cai no SPA: o cliente MCP espera 405/401, não HTML
}

const { startTaskRun } = setupExecution(app, { db, executor: claudeCodeExecutor, verifier, workspaceOf: (m) => worktrees.workspaceFor(m) });
childRegistry.reclaim({ executor: claudeCodeExecutor });
worktreeRecovery = await worktrees.recover(); // E3: a conciliação dos worktrees (inclusive `prepare` interrompido) só roda DEPOIS do reclaim: ela depende de saber se o preparador ainda vive // órfãos do Planner/verificador: depois dos do Executor, antes de qualquer ciclo (setupCycle) e de ouvir a porta
setupVerification(app, { db, verifier });
setupWorkspaceRemoval(app, { db, terminals, onRemoved: (id) => conversations.removeWorkspace(id) });
setupWorkspaceRename(app, { db });
setupWorkspaceTabs(app, { db });
setupTopics(app, { db });
setupLoadouts(app, { loadouts }); // skills por papel: GET/PUT /api/loadouts
setupUiSettings(app, { db }); // preferências da interface (db.settings.ui): GET/PUT /api/ui
setupLayouts(app, { db }); // layout da grade por workspace
setupConversations(app, { db, conversations }); // GET/DELETE /api/workspaces/:id/conversations[/:rec]
{ const capture = startConversationCapture({ db, conversations }); setTimeout(() => { capture.sweep().catch(() => {}); }, 3000).unref?.(); } // captura ao vivo das sessões rodando + varredura única das interrompidas // layout da grade de terminais por workspace (db.settings.layouts): GET /api/layouts, PUT /api/workspaces/:id/layout
const cycle = setupCycle(app, { db, executor: claudeCodeExecutor, planner, startTaskRun, verifier, router, limits: cycleLimits, multiStep: () => orchestration().planMode, stepRetries: () => orchestration().stepRetries, supervision: () => supervisionMs(supervision()), worktrees, worktreeIsolation: () => worktreeIsolation().enabled });
setupWorktrees(app, { db, manager: worktrees });
setupTerminals(app, { manager: terminals });
setupMaestro(app, { maestro });
setupChat(app, { db, planner, cycle, multiStep: () => orchestration().planMode }); // M5: chat geral; só prepara propostas, executar exige /api/chat/approve

app.use('/api', (req, res) => bad(res, 'Rota não encontrada.', 404));
app.use((err, req, res, next) => bad(res, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.', err.status || 500));
app.listen(PORT, HOST, () => console.log(`AI Dev Orchestrator API em http://${HOST}:${PORT}`));
