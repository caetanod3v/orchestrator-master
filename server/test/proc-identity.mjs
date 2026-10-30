// Auxiliar dos TESTES (não é um teste: o `npm test` só executa *.test.mjs). Identidade de processos criados pelos testes.
//
// Por quê: `pidAlive(pid)` (process.kill(pid, 0)) só diz que EXISTE um processo com aquele número. O Windows reaproveita PIDs depressa (medido: um PID
// de processo morto volta a um processo novo depois de ~50 criações de processo, na casa de segundos), então "o PID está vivo" pode ser outro processo
// e, pior, encerrar "o PID registrado" no cleanup pode matar um processo ALHEIO (foi observado: um PID registrado pertencia ao Windows Update).
//
// Regra (a mesma primitiva da produção, orphans.js#processStartedAt): cada PID é registrado com o INSTANTE em que o teste o conheceu. O processo original
// nasceu ANTES desse instante; um processo que reaproveitou o PID só pode nascer DEPOIS que o original morreu, portanto depois do instante registrado.
//   gone   : nenhum processo com esse PID
//   active : existe e nasceu até BORN_AFTER_MS depois do instante registrado (folga de resolução do relógio) e no máximo BORN_BEFORE_MS antes: é o original
//   reused : existe, mas nasceu fora dessa janela: é OUTRO processo (o original já morreu)
//   unknown: existe, mas a hora de criação não pôde ser lida: identidade incerta (tratado como vivo ao checar e NUNCA encerrado no cleanup)
// A janela é assimétrica de propósito: a tolerância de 15 s da produção (START_TOLERANCE_MS, simétrica) aceitaria como "o mesmo" um PID reaproveitado
// segundos depois, que é justamente o caso a distinguir aqui.
import { execFileSync } from 'node:child_process';
import { processStartedAt, killTreeSync, START_TOLERANCE_MS } from '../orphans.js';
import { pidAlive } from '../instance-lock.js';

export const BORN_AFTER_MS = 250;
export const BORN_BEFORE_MS = START_TOLERANCE_MS;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const toMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null));
const stderr = (m) => process.stderr.write(`${m}\n`); // direto: console.error pode estar mockado (quiet()) e esconderia a evidência

/** Quem é o dono ATUAL do PID (diagnóstico; nunca lança). */
export function describeOwner(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { '{0} | pai {1} | criado {2:o} | {3}' -f $_.Name, $_.ParentProcessId, $_.CreationDate, $_.CommandLine }`],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return (out || 'nenhum processo com esse PID').slice(0, 240);
    }
    return execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 240) || 'nenhum processo com esse PID';
  } catch { return 'dono indisponível'; }
}

/** @returns {{state:'gone'|'active'|'reused'|'unknown', ownStartedAt?:number, deltaMs?:number}}  `ref`: { pid, startedAt (ms) } */
export function classifyProcess(ref, { alive = pidAlive, startedAtOf = processStartedAt, attempts = 3, pause = sleepSync } = {}) {
  if (!alive(ref.pid)) return { state: 'gone' };
  let own = null;
  for (let i = 0; i < attempts && own == null; i++) {
    if (i) pause(100);
    own = startedAtOf(ref.pid);
    if (own == null && !alive(ref.pid)) return { state: 'gone' }; // morreu enquanto se tentava ler
  }
  if (own == null) return { state: 'unknown' };
  const deltaMs = own - ref.startedAt;
  return { state: deltaMs > BORN_AFTER_MS || deltaMs < -BORN_BEFORE_MS ? 'reused' : 'active', ownStartedAt: own, deltaMs };
}

/**
 * Registro dos PIDs de um arquivo de teste. Tudo é injetável (`alive`, `startedAtOf`, `kill`, `describe`, `log`, `now`) para os testes determinísticos.
 * `add(pid, startedAt?)`: `startedAt` (ms ou ISO) é o instante em que o processo comprovadamente já existia; sem ele vale "agora". Passe-o sempre que o PID
 * for registrado DEPOIS de o processo poder ter morrido (por exemplo, lido de um registro/arquivo escrito por outro processo).
 */
export function createProcTracker({ alive = pidAlive, startedAtOf = processStartedAt, kill = killTreeSync, describe = describeOwner, log = stderr, now = Date.now, attempts = 3, pause = sleepSync } = {}) {
  const refs = new Map(), terminal = new Map(), reported = new Set();

  function add(pid, startedAt) {
    if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`PID inválido: ${String(pid)}`);
    refs.set(pid, { pid, startedAt: toMs(startedAt) ?? now() }); terminal.delete(pid); reported.delete(pid); // mesmo número, outro processo: recomeça
    return api;
  }

  function state(pid) {
    const ref = refs.get(pid);
    if (!ref) throw new Error(`PID ${pid} não foi registrado no rastreador de identidade (use add(pid, startedAt))`);
    if (terminal.has(pid)) return terminal.get(pid); // gone e reused são definitivos: o original não volta
    const r = classifyProcess(ref, { alive, startedAtOf, attempts, pause });
    if (r.state === 'gone' || r.state === 'reused') terminal.set(pid, r.state);
    if ((r.state === 'reused' || r.state === 'unknown') && !reported.has(`${pid}:${r.state}`)) {
      reported.add(`${pid}:${r.state}`);
      log(`[proc-identity] PID ${pid} ${r.state === 'reused' ? 'REAPROVEITADO por outro processo (o original já terminou)' : 'vivo, mas a identidade NÃO pôde ser confirmada'}; registrado em ${new Date(ref.startedAt).toISOString()}`
        + `${r.ownStartedAt != null ? `; dono atual nasceu em ${new Date(r.ownStartedAt).toISOString()} (${r.deltaMs} ms)` : ''}; dono: ${describe(pid)}; NÃO será encerrado.`);
    }
    return r.state;
  }

  /** O processo ORIGINAL ainda está vivo? PID reaproveitado conta como encerrado; identidade incerta conta como vivo (não esconde um órfão). */
  const isAlive = (pid) => { const s = state(pid); return s === 'active' || s === 'unknown'; };

  /** Encerra (árvore inteira) SOMENTE se o dono atual do PID for comprovadamente o original. Devolve o estado encontrado. */
  function killIfOriginal(pid) { const s = state(pid); if (s === 'active') kill(pid); return s; }

  /** `after()` do arquivo de teste: encerra o que sobrou do que o teste criou, sem tocar em processo alheio. */
  function cleanup() { const out = {}; for (const pid of refs.keys()) out[pid] = killIfOriginal(pid); return out; }

  /** Estado + dono atual, para mensagens de falha. */
  const explain = (pid) => `${state(pid)} (dono atual: ${describe(pid)})`;

  const api = { add, state, isAlive, kill: killIfOriginal, cleanup, explain, pids: () => [...refs.keys()] };
  return api;
}
