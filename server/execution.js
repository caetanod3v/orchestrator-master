// Orquestração da execução real: autorização humana -> execução -> revisão humana.
// As rotas aceitam apenas ids; workspace, prompt e argumentos são montados no servidor.
import * as store from './store.js';
import { bus } from './executor/index.js';
import { runBlockers, authorizeBlockers } from './executor/policy.js';
import { validateDir } from './workspaces.js';
import { gitChanges } from './git.js';

const MAX_LOG = 600;
const find = (arr, id) => arr.find((x) => x.id === id);
const bad = (res, msg, code = 409) => res.status(code).json({ error: msg });

export function blockedReason(db, executor, mission, task) {
  return runBlockers({
    mission, task,
    workspace: find(db.workspaces, mission.workspaceId) || null,
    validateDir, busy: executor.isBusy(), cliAvailable: executor.cachedAvailability(),
  });
}

function buildPrompt(mission, task) {
  const deps = task.dependsOn.map((id) => find(mission.tasks, id)).filter(Boolean)
    .map((d) => `- ${d.title}: ${(d.report || '(sem relatório)').slice(0, 800)}`).join('\n');
  return [
    'Você executa UMA tarefa de desenvolvimento orquestrada por uma ferramenta local, dentro do diretório atual.',
    `Missão: ${mission.title}`,
    mission.objective ? `Objetivo da missão: ${mission.objective}` : '',
    `TAREFA A EXECUTAR (somente esta): ${task.title}`,
    deps ? `Contexto das tarefas anteriores já aprovadas:\n${deps}` : '',
    'Regras:',
    '- Trabalhe apenas dentro do diretório atual e faça somente esta tarefa; não antecipe tarefas futuras.',
    '- Você só pode ler e editar arquivos (sem shell, sem rede). Não apague arquivos, não faça commit nem push.',
    '- Ao terminar, responda com um relatório curto: o que foi feito, arquivos alterados e pendências.',
  ].filter(Boolean).join('\n');
}

export function setupExecution(app, { db, executor }) {
  const emitTask = (mission, task) => bus.emit('task', { missionId: mission.id, taskId: task.id, status: task.status });

  // Processos órfãos: se o servidor caiu no meio de uma execução, o estado real é "interrompida".
  for (const m of db.missions) for (const t of m.tasks) {
    if (t.status === 'running') {
      t.status = 'interrupted'; t.error = 'O servidor foi reiniciado durante a execução.'; t.finishedAt = store.now();
      t.log = [...(t.log || []), '[sistema] servidor reiniciado durante a execução; processo não é mais acompanhado'];
      store.log('execution', `Execução interrompida (servidor reiniciado): ${t.title}`, { missionId: m.id, taskId: t.id, agent: 'executor' });
    }
  }
  store.save();

  app.post('/api/missions/:id/tasks/:tid/authorize', (req, res) => {
    const mission = find(db.missions, req.params.id), task = mission && find(mission.tasks, req.params.tid);
    const why = authorizeBlockers({ mission, task });
    if (why) return bad(res, why, task ? 409 : 404);
    task.status = 'queued'; task.authorized = true; task.authorizedAt = store.now();
    store.log('approval', `Execução autorizada: ${task.title}`, { missionId: mission.id, taskId: task.id });
    store.save(); emitTask(mission, task);
    res.json(task);
  });

  app.post('/api/missions/:id/tasks/:tid/revoke', (req, res) => {
    const mission = find(db.missions, req.params.id), task = mission && find(mission.tasks, req.params.tid);
    if (!task) return bad(res, 'Tarefa não encontrada.', 404);
    if (task.status !== 'queued' || !task.authorized) return bad(res, 'Não há autorização pendente para revogar.');
    task.authorized = false;
    store.log('approval', `Autorização revogada: ${task.title}`, { missionId: mission.id, taskId: task.id });
    store.save(); emitTask(mission, task);
    res.json(task);
  });

  app.post('/api/missions/:id/tasks/:tid/run', async (req, res) => {
    const mission = find(db.missions, req.params.id), task = mission && find(mission.tasks, req.params.tid);
    if (!task) return bad(res, 'Tarefa não encontrada.', 404);
    const probe = await executor.probe();
    const check = () => runBlockers({
      mission, task, workspace: find(db.workspaces, mission.workspaceId) || null,
      validateDir, busy: executor.isBusy(), cliAvailable: probe.available,
    });
    let why = check();
    if (why) return bad(res, why);
    const workspace = find(db.workspaces, mission.workspaceId);
    const before = await gitChanges(workspace.path); // linha de base para saber o que a execução alterou
    why = check(); // revalida: outra requisição pode ter tomado o lock durante o await
    if (why) return bad(res, why);

    const beforePaths = new Set(before.files.map((f) => f.path));
    let handle;
    try {
      handle = executor.start({
        missionId: mission.id, taskId: task.id, cwd: workspace.path, prompt: buildPrompt(mission, task),
        onLine: (line) => {
          task.logTotal = (task.logTotal || 0) + 1;
          task.log.push(line.slice(0, 2000));
          if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
          bus.emit('log', { missionId: mission.id, taskId: task.id, count: task.logTotal, line: line.slice(0, 2000) });
          store.saveSoon();
        },
      });
    } catch (e) {
      return bad(res, e.code === 'BUSY' ? 'Outra execução está em andamento.' : e.message);
    }

    Object.assign(task, {
      status: 'running', authorized: false, startedAt: store.now(), finishedAt: null, exitCode: null, error: null,
      usage: null, report: '', files: [], log: [], logTotal: 0, pid: handle.pid, dirtyBefore: before.files.length > 0, gitRepo: before.isRepo,
    });
    if (task.dirtyBefore) { task.log.push('[aviso] o workspace já tinha alterações não commitadas antes desta execução'); task.logTotal = 1; }
    store.log('execution', `Execução iniciada: ${task.title}`, { missionId: mission.id, taskId: task.id, agent: 'executor' });
    store.save(); emitTask(mission, task); bus.emit('state', {});
    res.status(202).json(task);

    const r = await handle.done;
    const after = await gitChanges(workspace.path);
    task.files = after.files.map((f) => ({ ...f, preexisting: beforePaths.has(f.path) }));
    task.finishedAt = store.now(); task.exitCode = r.exitCode; task.error = r.error; delete task.pid;
    task.usage = r.result ? { costUsd: r.result.costUsd, durationMs: r.result.durationMs, turns: r.result.turns } : null;
    task.report = r.result?.text || (r.error ? `Sem relatório: ${r.error}` : '');
    // Sucesso do processo NÃO conclui a tarefa: o resultado aguarda revisão humana.
    task.status = r.status === 'completed' ? 'awaiting_approval' : r.status;
    const msg = {
      awaiting_approval: `Execução terminada, aguardando revisão: ${task.title}`,
      failed: `Execução falhou (${r.error}): ${task.title}`,
      interrupted: `Execução interrompida: ${task.title}`,
    }[task.status];
    store.log('execution', msg, { missionId: mission.id, taskId: task.id, agent: 'executor', exitCode: r.exitCode });
    store.save(); emitTask(mission, task); bus.emit('state', {});
  });

  app.post('/api/execution/stop', async (req, res) => {
    const r = await executor.stop();
    store.log('system', `Interrupção solicitada: ${r.detail}`, { stopped: r.stopped });
    store.save();
    res.json(r);
  });

  app.get('/api/execution', (req, res) => res.json({ busy: executor.isBusy(), current: executor.current() }));

  // SSE: o frontend recebe logs e mudanças de estado sem recarregar. Reconectar nunca inicia execução.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { busy: executor.isBusy(), current: executor.current() });
    const on = (event) => (d) => send(event, d);
    const h = { task: on('task'), log: on('log'), state: on('state') };
    for (const [k, fn] of Object.entries(h)) bus.on(k, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); for (const [k, fn] of Object.entries(h)) bus.off(k, fn); });
  });
}
