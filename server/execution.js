// Orquestração da execução real: autorização humana -> execução -> revisão humana.
// As rotas aceitam apenas ids; workspace, prompt e argumentos são montados no servidor.
import * as store from './store.js';
import { bus } from './executor/index.js';
import { runBlockers, authorizeBlockers } from './executor/policy.js';
import { validateDir } from './workspaces.js';
import { gitChanges } from './git.js';
import { reclaimOrphans, ORPHAN_NOTE } from './orphans.js';
import { asyncRoute } from './async-route.js';
import { pidAlive } from './instance-lock.js';
import { usageRecord, usageEvent } from './usage.js';
import { agentArgs } from './agents.js';

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
    task.instructions ? `Instruções:\n${task.instructions}` : '',
    task.acceptance?.length ? `Critérios de verificação:\n${task.acceptance.map((c) => `- ${c}`).join('\n')}` : '',
    deps ? `Contexto das tarefas anteriores já aprovadas:\n${deps}` : '',
    'Regras:',
    '- Trabalhe apenas dentro do diretório atual e faça somente esta tarefa; não antecipe tarefas futuras.',
    '- Você só pode ler e editar arquivos (sem shell, sem rede). Não apague arquivos, não faça commit nem push.',
    '- Ao terminar, responda com um relatório curto: o que foi feito, arquivos alterados e pendências.',
    task.auto ? 'Finalize com um bloco ```json: {"summary": "...", "checks": [{"name": "...", "result": "pass|fail|not_run", "detail": "..."}]} listando SOMENTE verificações que você realmente fez (releitura e conferência dos arquivos). Use not_run para o que não pôde verificar; não invente resultados.' : '',
    task.auto ? 'Depois da sua execução, o próprio orquestrador roda as verificações reais (testes/build) do projeto; não afirme que rodou testes.' : '',
  ].filter(Boolean).join('\n');
}

export function setupExecution(app, { db, executor, verifier = null, orphanTools = {} }) {
  const emitTask = (mission, task) => bus.emit('task', { missionId: mission.id, taskId: task.id, status: task.status });
  // SSE `usage`: métricas da tarefa (task.tokenUsage); acessórias, então nunca interrompem a execução nem a finalização.
  const emitUsage = (mission, task) => {
    try { if (task.tokenUsage) bus.emit('usage', usageEvent('executor', { missionId: mission.id, taskId: task.id }, task.tokenUsage)); } catch { /* métricas são acessórias */ }
  };

  // Processos órfãos: se o servidor caiu no meio de uma execução, o estado real é "interrompida" e o processo filho (que sobrevive ao pai)
  // pode continuar editando o workspace. Os PIDs gravados são conferidos e a execução abandonada é encerrada (ver orphans.js).
  // (os textos de ORPHAN_NOTE vivem em orphans.js, compartilhados com o registro de processos do Planner e do verificador)
  // Candidatos: toda tarefa que ainda guarda um PID (a que estava "running" e também a que ficou "interrupted" com processo não resolvido).
  const withPid = [];
  for (const m of db.missions) for (const t of m.tasks) {
    if (t.pid != null) withPid.push({ m, t });
    if (t.status === 'running') {
      t.status = 'interrupted'; t.error = 'O servidor foi reiniciado durante a execução.'; t.finishedAt = store.now();
      t.log = [...(t.log || []), '[sistema] servidor reiniciado durante a execução; processo não é mais acompanhado'];
      if (t.tokenUsage) t.tokenUsage = { ...t.tokenUsage, ended: true }; // métricas parciais (provisórias) da execução perdida são preservadas
      store.log('execution', `Execução interrompida (servidor reiniciado): ${t.title}`, { missionId: m.id, taskId: t.id, agent: 'executor' });
    }
  }
  const results = reclaimOrphans(withPid.map(({ t }) => ({ pid: t.pid, startedAt: t.startedAt })), orphanTools);
  results.forEach((r, i) => {
    const { m, t } = withPid[i];
    t.log = [...(t.log || []), `[sistema] PID ${r.pid}: ${ORPHAN_NOTE[r.outcome]}${r.detail ? ` (${r.detail})` : ''}`];
    store.log('execution', `Processo órfão (PID ${r.pid}) — ${r.outcome}: ${t.title}`, { missionId: m.id, taskId: t.id, agent: 'executor', orphan: r.outcome });
    if (r.outcome === 'kill_failed' || r.outcome === 'unverified') {
      executor.adoptOrphan?.(r.pid, r.processStart ?? r.expectedStart ?? null); // vivo e possivelmente ativo: o executor fica ocupado; o PID é mantido para reavaliar no próximo boot
    } else delete t.pid;
  });
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

  /**
   * Valida, toma o lock do executor e inicia a execução. Usado pela rota manual e pelo ciclo.
   * @returns {Promise<{ok:false, reason:string, cancelled?:true} | {ok:true, finished:Promise<void>}>}  `cancelled`: `shouldAbort()` ficou verdadeiro antes de o processo iniciar
   * `finished` só resolve depois de persistir o estado final da tarefa.
   */
  async function startTaskRun(mission, task, { autoAccept = false, shouldAbort = null } = {}) {
    // Perfil de agente (tarefas do ciclo trazem `agent`; as manuais não: nada muda para elas). Perfil desconhecido NUNCA inicia a CLI.
    let profileArgs;
    if (task?.agent !== undefined) { try { profileArgs = agentArgs(task.agent); } catch (e) { return { ok: false, reason: e.message }; } }
    // Cancelamento pedido durante a preparação: nada é iniciado (e não é falha). Cada checagem vem logo após um await; a última fica
    // colada em executor.start() SEM await no meio, então não há corrida entre "ainda não cancelado" e "processo iniciado".
    const aborted = () => (shouldAbort?.() ? { ok: false, cancelled: true, reason: 'Cancelado antes de iniciar a execução.' } : null);
    const probe = await executor.probe();
    if (aborted()) return aborted();
    const check = () => runBlockers({
      mission, task, workspace: find(db.workspaces, mission.workspaceId) || null,
      validateDir, busy: executor.isBusy(), cliAvailable: probe.available,
    });
    let why = check();
    if (why) return { ok: false, reason: why };
    const workspace = find(db.workspaces, mission.workspaceId);
    const before = await gitChanges(workspace.path); // linha de base para saber o que a execução alterou
    if (aborted()) return aborted();
    why = check(); // revalida: outra requisição pode ter tomado o lock durante o await
    if (why) return { ok: false, reason: why };

    const beforePaths = new Set(before.files.map((f) => f.path));
    let handle;
    try {
      handle = executor.start({
        missionId: mission.id, taskId: task.id, cwd: workspace.path, prompt: buildPrompt(mission, task), ...(profileArgs ? { args: profileArgs } : {}),
        onLine: (line) => {
          task.logTotal = (task.logTotal || 0) + 1;
          task.log.push(line.slice(0, 2000));
          if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
          bus.emit('log', { missionId: mission.id, taskId: task.id, count: task.logTotal, line: line.slice(0, 2000) });
          store.saveSoon();
        },
        // Atualização provisória durante a execução (mensagens distintas do stream) e, quando chega, o result final.
        onUsage: (snap) => {
          task.tokenUsage = usageRecord(snap, { ended: false, at: store.now() });
          emitUsage(mission, task); store.saveSoon();
        },
      });
    } catch (e) {
      return { ok: false, reason: e.code === 'BUSY' ? 'Outra execução está em andamento.' : e.message };
    }

    // Trecho crítico: o processo filho JÁ existe e o finalize ainda não foi ligado. Se registrar o início falhar (ex.: erro real de disco em
    // store.save()), o filho NÃO pode ficar rodando sem ninguém acompanhando: encerra-se o processo (liberando o executor), a tarefa vira
    // "failed" sem PID e o erro original segue para quem chamou (a rota devolve 500; o ciclo trata como erro interno).
    try {
      Object.assign(task, {
        status: 'running', authorized: false, startedAt: store.now(), finishedAt: null, exitCode: null, error: null,
        usage: null, tokenUsage: null, report: '', files: [], log: [], logTotal: 0, pid: handle.pid, dirtyBefore: before.files.length > 0, gitRepo: before.isRepo,
        permissionDenied: false,
      });
      if (task.dirtyBefore) { task.log.push('[aviso] o workspace já tinha alterações não commitadas antes desta execução'); task.logTotal = 1; }
      store.log('execution', `Execução iniciada: ${task.title}`, { missionId: mission.id, taskId: task.id, agent: 'executor' });
      store.saveOrThrow(); emitTask(mission, task); bus.emit('state', {}); // CONFIRMADA: o PID gravado é o que a recuperação de órfãos (P4/M1) usa; save()==false deixaria o filho sem rastro
    } catch (e) {
      let stopped = false;
      try { stopped = (await executor.stop()).stopped === true; } catch { try { executor.killActiveSync?.(); } catch { /* sem mais o que fazer */ } }
      // Encerramento NÃO confirmado e o processo ainda existe: o PID real fica na tarefa (junto com startedAt) para que um próximo salvamento o grave e
      // a recuperação de órfãs (P4) consiga identificá-lo depois de um reinício. O executor segue ocupado até o processo terminar (sem execução concorrente).
      const alive = !stopped && pidAlive(handle.pid);
      task.status = 'failed'; task.authorized = false; task.finishedAt = store.now();
      if (alive) task.pid = handle.pid; else delete task.pid;
      task.error = alive
        ? `Falha ao registrar o início da execução (${e.code || 'erro'}); o encerramento do processo NÃO foi confirmado (PID ${handle.pid} mantido para recuperação).`
        : `Falha ao registrar o início da execução (${e.code || 'erro'}); o processo foi encerrado.`;
      throw e;
    }

    const finalize = async () => {
      const r = await handle.done;
      const after = await gitChanges(workspace.path);
      task.files = after.files.map((f) => ({ ...f, preexisting: beforePaths.has(f.path) }));
      task.finishedAt = store.now(); task.exitCode = r.exitCode; task.error = r.error; delete task.pid;
      task.usage = r.result ? { costUsd: r.result.costUsd, durationMs: r.result.durationMs, turns: r.result.turns } : null;
      // Estado final das métricas: com result -> basis 'final'; sem result (falha/interrupção) -> o parcial fica como 'live' provisório; nada reportado -> null.
      task.tokenUsage = usageRecord(r.usage, { ended: true, at: store.now() });
      task.report = r.result?.text || (r.error ? `Sem relatório: ${r.error}` : '');
      // Pedido de permissão negado = a execução precisou de algo que não foi concedido (nunca é sucesso).
      task.permissionDenied = (r.result?.permissionDenials || 0) > 0
        || task.log.some((l) => /^\[erro de ferramenta\].*(permiss|denied|not allowed|negad)/i.test(l));
      if (r.status === 'completed' && task.permissionDenied && autoAccept) {
        r.status = 'failed'; task.error = 'A execução precisou de permissão que não foi concedida (negada automaticamente).';
      }
      // Sucesso do processo NÃO conclui a tarefa: aguarda revisão humana, salvo tarefas do ciclo (aceitas no relatório).
      task.status = r.status === 'completed' ? (autoAccept ? 'completed' : 'awaiting_approval') : r.status;
      if (autoAccept && task.status === 'completed') task.autoAccepted = true;
      const msg = {
        awaiting_approval: `Execução terminada, aguardando revisão: ${task.title}`,
        completed: `Execução terminada (relatório enviado ao Planner): ${task.title}`,
        failed: `Execução falhou (${task.error}): ${task.title}`,
        interrupted: `Execução interrompida: ${task.title}`,
      }[task.status];
      store.log('execution', msg, { missionId: mission.id, taskId: task.id, agent: 'executor', exitCode: r.exitCode });
      store.save(); emitTask(mission, task); emitUsage(mission, task); bus.emit('state', {});
    };
    // Nunca rejeita: qualquer erro na finalização leva a tarefa a um estado terminal coerente (jamais "running" sem processo).
    const finished = finalize().catch((e) => {
      try {
        if (task.status === 'running' || task.status === 'queued') {
          task.status = 'failed'; task.finishedAt = store.now(); task.error = `Falha ao finalizar a execução: ${e.message}`; delete task.pid;
          task.report = task.report || `Sem relatório: ${task.error}`; task.permissionDenied = !!task.permissionDenied;
        }
        store.log('execution', `Execução falhou ao finalizar (${e.message}): ${task.title}`, { missionId: mission.id, taskId: task.id, agent: 'executor' });
        store.save(); emitTask(mission, task); bus.emit('state', {});
      } catch (e2) { console.error('[execution] falha ao registrar o erro de finalização', e2); }
    });
    return { ok: true, finished };
  }

  app.post('/api/missions/:id/tasks/:tid/run', asyncRoute(async (req, res) => {
    const mission = find(db.missions, req.params.id), task = mission && find(mission.tasks, req.params.tid);
    if (!task) return bad(res, 'Tarefa não encontrada.', 404);
    const r = await startTaskRun(mission, task);
    if (!r.ok) return bad(res, r.reason);
    res.status(202).json(task);
  }));

  app.post('/api/execution/stop', asyncRoute(async (req, res) => {
    let r = await executor.stop();
    if (!r.stopped && verifier) { const v = await verifier.stop(); if (v.stopped) r = v; } // também interrompe uma verificação real em andamento
    store.log('system', `Interrupção solicitada: ${r.detail}`, { stopped: r.stopped });
    store.save();
    res.json(r);
  }));

  app.get('/api/execution', (req, res) => res.json({ busy: executor.isBusy(), current: executor.current() }));

  // SSE: o frontend recebe logs e mudanças de estado sem recarregar. Reconectar nunca inicia execução.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { busy: executor.isBusy(), current: executor.current() });
    const on = (event) => (d) => send(event, d);
    const h = { task: on('task'), log: on('log'), state: on('state'), cycle: on('cycle'), usage: on('usage') };
    for (const [k, fn] of Object.entries(h)) bus.on(k, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); for (const [k, fn] of Object.entries(h)) bus.off(k, fn); });
  });

  return { startTaskRun };
}
