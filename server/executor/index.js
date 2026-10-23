// Executor real: roda UMA tarefa por vez com o Claude Code, como processo filho controlado.
//
// Segurança (fixa no código, nada vem do cliente):
//  - binário fixo `claude`, sem shell, argumentos montados aqui, cwd = workspace validado;
//  - NUNCA usa --dangerously-skip-permissions nem bypassPermissions;
//  - --permission-prompts none: qualquer pedido de permissão é negado automaticamente;
//  - --tools restringe a leitura/edição de arquivos (sem Bash, sem rede);
//  - --setting-sources user: hooks e permissões do projeto alvo não afrouxam a execução;
//  - o prompt vai por stdin (sem limite/escape de linha de comando).
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseLine } from './stream.js';

export const bus = new EventEmitter(); // 'task' | 'log' | 'state' -> consumido pelo SSE
bus.setMaxListeners(50);

export const CLAUDE_ARGS = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user',
  '--tools', 'Read,Edit,Write,Glob,Grep',
];

function killTree(child) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já encerrado */ } resolve(); }, 3000).unref();
    }
  });
}

/**
 * `command`/`prefixArgs` só existem para os testes injetarem uma CLI falsa; o servidor
 * usa sempre o padrão e nenhum valor vem de requisições.
 */
export function createExecutor({ command = 'claude', prefixArgs = [], args = CLAUDE_ARGS, timeoutMs = 15 * 60 * 1000 } = {}) {
  let active = null;
  let probeCache = { at: 0, value: null };

  function probe() {
    if (Date.now() - probeCache.at < 15000 && probeCache.value) return Promise.resolve(probeCache.value);
    return new Promise((resolve) => {
      execFile(command, [...prefixArgs, '--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        const value = err
          ? { available: false, detail: 'Claude Code não encontrado no PATH' }
          : { available: true, version: stdout.trim(), detail: 'Claude Code detectado e pronto para executar tarefas autorizadas' };
        probeCache = { at: Date.now(), value };
        resolve(value);
      });
    });
  }

  /**
   * Inicia a execução (síncrono: o lock é tomado aqui). Lança se já houver execução ativa.
   * @returns {{pid:number, done:Promise<{status:'completed'|'failed'|'interrupted', exitCode:number|null, error:string|null, result:object|null, spawnFailed:boolean}>}}
   */
  function start({ missionId, taskId, cwd, prompt, onLine }) {
    if (active) { const e = new Error('Outra execução está em andamento.'); e.code = 'BUSY'; throw e; }
    const run = { missionId, taskId, startedAt: new Date().toISOString(), stopping: false, timedOut: false, child: null, finished: null };
    active = run;
    let result = null, error = null, spawnFailed = false, settled = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    run.finished = done;

    const child = spawn(command, [...prefixArgs, ...args], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    run.child = child;
    const timer = setTimeout(() => { run.timedOut = true; killTree(child); }, timeoutMs);

    const buffers = { out: '', err: '' };
    const feed = (kind, chunk) => {
      buffers[kind] += chunk.toString('utf8');
      const parts = buffers[kind].split(/\r?\n/);
      buffers[kind] = parts.pop();
      for (const p of parts) emit(kind, p);
    };
    const emit = (kind, raw) => {
      if (kind === 'err') { if (raw.trim()) onLine(`[stderr] ${raw.slice(0, 2000)}`); return; }
      const parsed = parseLine(raw);
      if (parsed.result) result = parsed.result;
      parsed.lines.forEach(onLine);
    };
    child.stdout.on('data', (c) => feed('out', c));
    child.stderr.on('data', (c) => feed('err', c));
    child.stdin.on('error', () => { /* processo pode fechar stdin antes */ });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffers.out.trim()) emit('out', buffers.out);
      if (buffers.err.trim()) emit('err', buffers.err);
      child.removeAllListeners(); child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.stdin.removeAllListeners(); child.on('error', () => {});
      let status;
      if (run.stopping) status = 'interrupted';
      else if (run.timedOut) { status = 'failed'; error = `Tempo máximo excedido (${Math.round(timeoutMs / 60000)} min)`; }
      else if (spawnFailed) status = 'failed';
      else if (exitCode === 0 && !(result && result.isError)) status = 'completed';
      else {
        status = 'failed';
        error = error || (result?.isError ? `A CLI reportou erro: ${result.text || 'sem detalhes'}` : `Processo terminou com código ${exitCode}`);
      }
      active = null;
      resolveDone({ status, exitCode, error, result, spawnFailed });
    };
    child.on('error', (err) => { spawnFailed = true; error = `Falha ao iniciar a CLI: ${err.message}`; finish(null); });
    child.on('close', (code) => finish(code));

    try { child.stdin.end(prompt); } catch { /* tratado pelo handler de erro */ }
    return { pid: child.pid, done };
  }

  /** Interrompe a execução ativa e só resolve depois que o processo terminou de fato. */
  async function stop() {
    if (!active) return { stopped: false, detail: 'Nenhuma execução ativa.' };
    const run = active;
    run.stopping = true;
    await killTree(run.child);
    await Promise.race([run.finished, new Promise((r) => setTimeout(r, 8000))]);
    const gone = active !== run;
    return gone
      ? { stopped: true, detail: 'Execução interrompida; o processo foi encerrado.' }
      : { stopped: false, detail: 'O processo não confirmou o encerramento em 8 s.' };
  }

  return {
    id: 'claude-code',
    probe,
    cachedAvailability: () => (probeCache.value ? probeCache.value.available : null),
    isBusy: () => !!active,
    current: () => (active ? { missionId: active.missionId, taskId: active.taskId, startedAt: active.startedAt } : null),
    start,
    stop,
  };
}

export const claudeCodeExecutor = createExecutor();
