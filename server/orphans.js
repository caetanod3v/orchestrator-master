// Processos filhos ÓRFÃOS: se o servidor morre (queda, kill, energia) no meio de uma execução, o `claude` filho continua vivo (no Windows os
// filhos NÃO morrem com o pai) e segue editando o workspace sem ninguém acompanhando. No boot, os PIDs gravados nas tarefas "running" são
// conferidos e, se forem MESMO a execução abandonada, encerrados com toda a árvore.
//
// Segurança: nunca se encerra um PID só porque está no banco (PIDs são reaproveitados). O processo só é encerrado se a hora de criação dele
// bate com a hora de início da tarefa (o filho nasce milissegundos antes de `task.startedAt`). Sem como confirmar, nada é encerrado.
import { execFileSync } from 'node:child_process';
import { pidAlive } from './instance-lock.js';

export const START_TOLERANCE_MS = 15_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Hora de criação do processo (ms desde a época) ou null se não foi possível saber. */
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [int64]([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const ms = Number(out.trim());
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const secs = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isFinite(secs) ? Date.now() - secs * 1000 : null;
  } catch { return null; }
}

/** Encerra o processo e toda a árvore dele, de forma síncrona. Processo inexistente não é erro. */
export function killTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    else process.kill(pid, 'SIGKILL');
  } catch { /* já encerrado ou sem permissão: quem chama confere com pidAlive */ }
}

/** Espera (no máximo `ms`) o processo sumir. */
export function waitGone(pid, ms = 2000, alive = pidAlive) {
  for (let t = 0; t < ms; t += 100) { if (!alive(pid)) return true; sleepSync(100); }
  return !alive(pid);
}

/**
 * Confere e encerra execuções órfãs. `candidates`: [{ pid, startedAt (ISO ou ms) }].
 * Resultado por candidato: gone (já encerrado) | killed | reused (identidade comprovadamente DIFERENTE: intocado, não bloqueia)
 * | unverified (VIVO, mas a identidade não pôde ser confirmada: intocado, mas BLOQUEIA novas execuções) | kill_failed (era a execução abandonada
 * e continua viva: BLOQUEIA). unverified e kill_failed ficam registrados para serem reavaliados no próximo boot.
 */
export function reclaimOrphans(candidates, { alive = pidAlive, startedAtOf = processStartedAt, kill = killTreeSync, wait = waitGone, toleranceMs = START_TOLERANCE_MS } = {}) {
  return candidates.map((c) => {
    const base = { pid: c.pid, startedAt: c.startedAt };
    if (!Number.isInteger(c.pid) || c.pid <= 0) return { ...base, outcome: 'gone', detail: 'PID inválido: não há processo a acompanhar' };
    if (!alive(c.pid)) return { ...base, outcome: 'gone' };
    const taskStart = typeof c.startedAt === 'number' ? c.startedAt : Date.parse(c.startedAt);
    const procStart = Number.isFinite(taskStart) ? startedAtOf(c.pid) : null;
    if (!Number.isFinite(taskStart) || procStart == null) return { ...base, outcome: 'unverified', detail: 'não foi possível confirmar a identidade do processo', expectedStart: Number.isFinite(taskStart) ? taskStart : null }; // expectedStart: permite confirmar depois (Interromper) se a consulta voltar a funcionar
    if (Math.abs(procStart - taskStart) > toleranceMs) return { ...base, outcome: 'reused', detail: `o PID pertence a outro processo (criado ${Math.round((procStart - taskStart) / 1000)} s em relação à tarefa)`, processStart: procStart };
    kill(c.pid);
    return wait(c.pid, 2000, alive) ? { ...base, outcome: 'killed', processStart: procStart } : { ...base, outcome: 'kill_failed', processStart: procStart };
  });
}
