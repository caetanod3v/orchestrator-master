// Testes DETERMINÍSTICOS da identidade de processos usada pelos testes de M1/M2 (proc-identity.mjs): PID existente com identidade diferente, PID reaproveitado
// que o cleanup NÃO pode encerrar, `waitGone` que reconhece o desaparecimento do original e processo original ainda ativo. Quase tudo por injeção
// (alive/startedAtOf/kill/log), sem depender de o Windows reaproveitar um PID de verdade. Os dois testes com processo REAL só criam e encerram processos
// próprios (nunca nada por nome); o dono do ChildProcess é quem encerra o que sobrar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { classifyProcess, createProcTracker, describeOwner, BORN_AFTER_MS, BORN_BEFORE_MS } from './proc-identity.mjs';
import { waitGone } from '../orphans.js';
import { pidAlive } from '../instance-lock.js';

const T0 = 1_000_000_000_000;                                   // instante em que o teste "conheceu" o PID
const ref = { pid: 4242, startedAt: T0 };
const noPause = () => {};
const settle = (p, ms = 15_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('não terminou a tempo')), ms))]);
/** Ambiente simulado: `procs` = pid -> hora de criação do dono atual (ou null = vivo sem hora legível); pid ausente = nenhum processo. */
function world(procs) {
  const kills = [], logs = [], reads = [];
  return {
    kills, logs, reads, procs,
    alive: (pid) => pid in procs,
    startedAtOf: (pid) => { reads.push(pid); return procs[pid]; },
    kill: (pid) => { kills.push(pid); delete procs[pid]; },
    describe: (pid) => `simulado(${pid})`,
    log: (m) => logs.push(m),
  };
}
const tracker = (w, extra = {}) => createProcTracker({ alive: w.alive, startedAtOf: w.startedAtOf, kill: w.kill, describe: w.describe, log: w.log, pause: noPause, ...extra });

// ---- classifyProcess ------------------------------------------------------------------------------------------------------------
test('classifyProcess: sem processo => gone (nem consulta a hora de criação)', () => {
  const w = world({});
  assert.deepEqual(classifyProcess(ref, w), { state: 'gone' }); assert.deepEqual(w.reads, []);
});

test('classifyProcess: o processo original (nasceu antes do registro) está ativo, com a folga de relógio nos limites', () => {
  for (const born of [T0 - 40, T0 - 1, T0, T0 + BORN_AFTER_MS, T0 - BORN_BEFORE_MS]) {
    const r = classifyProcess(ref, world({ 4242: born })); assert.equal(r.state, 'active', `nasceu em T0${born - T0 >= 0 ? '+' : ''}${born - T0}`); assert.equal(r.deltaMs, born - T0);
  }
});

test('classifyProcess: PID existente com identidade DIFERENTE => reused (nasceu depois do registro, ou muito antes)', () => {
  for (const born of [T0 + BORN_AFTER_MS + 1, T0 + 5_000, T0 + 3_600_000, T0 - BORN_BEFORE_MS - 1, T0 - 86_400_000]) {
    assert.equal(classifyProcess(ref, world({ 4242: born })).state, 'reused', `nasceu em T0${born - T0 >= 0 ? '+' : ''}${born - T0}`);
  }
});

test('classifyProcess: vivo sem hora legível => unknown depois de tentar de novo; uma leitura que volta a funcionar resolve; morrer durante a leitura => gone', () => {
  const w = world({ 4242: null });
  assert.equal(classifyProcess(ref, { ...w, pause: noPause }).state, 'unknown'); assert.equal(w.reads.length, 3, 'tentou 3 vezes');
  const seq = [null, null, T0 - 10]; let i = 0;
  assert.equal(classifyProcess(ref, { alive: () => true, startedAtOf: () => seq[i++], pause: noPause }).state, 'active');
  const lives = [true, false]; let j = 0;
  assert.equal(classifyProcess(ref, { alive: () => lives[Math.min(j++, 1)], startedAtOf: () => null, pause: noPause }).state, 'gone');
});

// ---- createProcTracker ----------------------------------------------------------------------------------------------------------
test('rastreador: isAlive diferencia original ativo, encerrado, PID reaproveitado e identidade incerta (incerta conta como vivo: não esconde órfão)', () => {
  const w = world({ 1: T0 - 5, 3: T0 + 9_000, 4: null }); // 1 original; 2 inexistente; 3 reaproveitado; 4 incerto
  const t = tracker(w); for (const pid of [1, 2, 3, 4]) t.add(pid, T0);
  assert.deepEqual([1, 2, 3, 4].map((p) => t.state(p)), ['active', 'gone', 'reused', 'unknown']);
  assert.deepEqual([1, 2, 3, 4].map((p) => t.isAlive(p)), [true, false, false, true]);
});

test('rastreador: gone e reused são definitivos (o original não volta) e um novo add() do mesmo número recomeça', () => {
  const w = world({ 7: T0 + 9_000 }); let reads = 0;
  const t = tracker(w, { startedAtOf: (p) => { reads++; return w.procs[p]; } }); t.add(7, T0); t.add(8, T0);
  assert.equal(t.state(7), 'reused'); assert.equal(reads, 1);
  w.procs[7] = T0 - 5;                                                     // se o dono "voltasse a parecer" o original, o veredito definitivo não muda
  assert.equal(t.state(7), 'reused'); assert.equal(reads, 1, 'não consultou de novo');
  assert.equal(t.state(8), 'gone'); w.procs[8] = T0 + 1;                   // o PID morto é reaproveitado depois: continua "encerrado" e não é tocado
  assert.equal(t.state(8), 'gone'); assert.equal(t.kill(8), 'gone'); assert.deepEqual(w.kills, []);
  t.add(7, T0 + 9_000);                                                    // outro processo, mesmo número, agora registrado a tempo: recomeça
  assert.equal(t.state(7), 'active');
});

test('rastreador: PID não registrado e PID inválido são erro (nada de "adivinhar" a identidade)', () => {
  const t = tracker(world({}));
  assert.throws(() => t.state(5), /não foi registrado/); assert.throws(() => t.isAlive(5), /não foi registrado/);
  for (const bad of [0, -1, 1.5, '7', null, undefined]) assert.throws(() => t.add(bad), TypeError);
});

test('cleanup: SÓ encerra o original; PID reaproveitado, identidade incerta e PID inexistente não são tocados, e o motivo fica registrado', () => {
  const w = world({ 10: T0 - 20, 20: T0 + 30_000, 30: null }); // 10 original; 20 reaproveitado; 30 incerto; 40 inexistente
  const t = tracker(w); for (const pid of [10, 20, 30, 40]) t.add(pid, T0);
  const res = t.cleanup();
  assert.deepEqual(res, { 10: 'active', 20: 'reused', 30: 'unknown', 40: 'gone' });
  assert.deepEqual(w.kills, [10], 'só o original foi encerrado');
  assert.ok(w.logs.some((l) => /PID 20 REAPROVEITADO/.test(l) && /simulado\(20\)/.test(l) && /NÃO será encerrado/.test(l)), 'evidência do reaproveitado');
  assert.ok(w.logs.some((l) => /PID 30 vivo, mas a identidade NÃO pôde ser confirmada/.test(l)), 'evidência do incerto');
  assert.equal(w.logs.length, 2, 'nada é registrado para original e inexistente'); assert.ok('20' in w.procs && '30' in w.procs, 'os processos alheios continuam');
  assert.equal(t.cleanup()[10], 'gone', 'repetir é inofensivo');
});

test('kill(): processo já encerrado cujo PID foi reaproveitado NÃO é encerrado (o caso do cleanup cego antigo)', () => {
  const w = world({ 99: T0 + 2_000 });                                     // o original (registrado em T0) morreu; outro processo nasceu 2 s depois
  const t = tracker(w); t.add(99, T0);
  assert.equal(t.kill(99), 'reused'); assert.deepEqual(w.kills, [], 'nenhum kill'); assert.equal(t.isAlive(99), false);
});

// ---- waitGone com identidade -----------------------------------------------------------------------------------------------------
test('waitGone com predicado de identidade: reconhece que o ORIGINAL sumiu quando o PID foi reaproveitado; original ainda ativo continua sendo detectado', () => {
  const reused = tracker(world({ 4242: T0 + 60_000 })); reused.add(4242, T0);
  const t0 = Date.now();
  assert.equal(waitGone(4242, 1_500, reused.isAlive), true, 'o original sumiu (PID reaproveitado)'); assert.ok(Date.now() - t0 < 500, 'sem esperar o orçamento todo');
  assert.equal(waitGone(4242, 200, () => true), false, 'contrato antigo (só pidAlive): um PID reaproveitado parece "ainda vivo"');
  const orig = tracker(world({ 4242: T0 - 30 })); orig.add(4242, T0);
  assert.equal(waitGone(4242, 200, orig.isAlive), false, 'o original continua ativo => não "sumiu"');
  const gone = tracker(world({})); gone.add(4242, T0);
  assert.equal(waitGone(4242, 200, gone.isAlive), true);
});

// ---- processos REAIS (somente próprios) -------------------------------------------------------------------------------------------
const SLEEP = ['-e', 'setInterval(() => {}, 1000)'];
const own = () => { const c = spawn(process.execPath, SLEEP, { stdio: 'ignore', windowsHide: true }); return { c, exited: new Promise((r) => c.on('exit', r)) }; };

test('REAL: um processo vivo registrado com instante ANTERIOR ao seu nascimento (= PID reaproveitado) sobrevive ao cleanup; registrado corretamente, é o original e é encerrado', async () => {
  const { c, exited } = own(); const logs = [];
  try {
    const t = createProcTracker({ log: (m) => logs.push(m) });
    t.add(c.pid, Date.now() - 60_000);                                     // "o registro é de 1 min atrás": o dono atual é outro processo
    assert.equal(t.state(c.pid), 'reused'); assert.deepEqual(t.cleanup(), { [c.pid]: 'reused' });
    assert.equal(c.exitCode, null); assert.equal(pidAlive(c.pid), true, 'o processo alheio NÃO foi encerrado');
    assert.ok(logs.some((l) => l.includes(`PID ${c.pid} REAPROVEITADO`) && l.includes(String(c.pid))), 'evidência registrada');
    t.add(c.pid);                                                          // registro correto (agora): nasceu antes => é o original
    assert.equal(t.state(c.pid), 'active'); assert.equal(t.isAlive(c.pid), true);
    assert.deepEqual(t.cleanup(), { [c.pid]: 'active' }); await settle(exited);
    assert.equal(t.state(c.pid), 'gone'); assert.equal(t.isAlive(c.pid), false);
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill(); await settle(exited).catch(() => {}); }
});

test('REAL: processo próprio ativo é visto como ativo; depois de encerrado, como encerrado (kill() devolve o estado e é idempotente)', async () => {
  const { c, exited } = own();
  try {
    const t = createProcTracker(); t.add(c.pid);
    assert.equal(t.isAlive(c.pid), true); assert.equal(t.kill(c.pid), 'active'); await settle(exited);
    assert.equal(t.isAlive(c.pid), false); assert.equal(t.kill(c.pid), 'gone');
    assert.equal(typeof describeOwner(c.pid), 'string');                   // diagnóstico nunca lança, mesmo sem dono
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill(); await settle(exited).catch(() => {}); }
});
