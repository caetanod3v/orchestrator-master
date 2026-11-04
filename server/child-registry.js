// Registro PERSISTIDO dos processos filhos do Planner e do verificador (db.childProcesses). O Executor já guarda o PID na tarefa (execution.js);
// estes dois não tinham nada: se o servidor morresse no meio de uma chamada ao Planner ou de um `npm run test|build`, o filho (no Windows os
// filhos NÃO morrem com o pai) seguia vivo sem ninguém saber, e uma nova rodada podia começar por cima dele.
//
// Mesma regra de segurança do Executor (orphans.js): um PID gravado nunca é encerrado só por estar no banco. O processo só é encerrado se a hora
// de criação dele bate com a hora do registro; identidade incerta => nada é encerrado e o EXECUTOR fica ocupado (novas execuções, manuais ou de ciclo,
// e a retomada de ciclos ficam bloqueadas até o processo terminar ou ser encerrado por "Interromper", que reconfere a identidade).
import * as realStore from './store.js';
import { reclaimOrphans, ORPHAN_NOTE } from './orphans.js';
import { pidAlive } from './instance-lock.js';

export const CHILD_KEY = 'childProcesses';
export const CHILD_KINDS = Object.freeze(['planner', 'verifier', 'preparer', 'terminal']);
const LABEL = { planner: 'Planner', verifier: 'verificação real', preparer: 'preparação de ambiente', terminal: 'terminal do Claude Code' };

const NOOP = Object.freeze({ pid: null, release() {} });

/** `store` e `orphanTools` só são injetados nos testes; o servidor usa os padrões. */
export function createChildRegistry({ store = realStore, orphanTools = {} } = {}) {
  let reclaimedOnce = false; // o boot já conferiu os registros deixados por um servidor anterior?
  const lastOutcome = new Map(); // worktreeId -> resultado do reclaim do boot (gone | killed | reused | unverified | kill_failed)
  /** Lista viva do banco carregado (cria o campo em bancos antigos). Sem banco carregado => null. */
  const list = () => {
    const db = store.get();
    if (!db) return null;
    if (!Array.isArray(db[CHILD_KEY])) db[CHILD_KEY] = [];
    return db[CHILD_KEY];
  };
  const drop = (rec) => { const l = list(); const i = l ? l.indexOf(rec) : -1; if (i >= 0) l.splice(i, 1); };

  /**
   * Registra, SÍNCRONO e logo depois do spawn, o filho `pid` e grava o banco. Lança se a gravação lançar: quem chama NÃO pode deixar o
   * filho rodando sem registro (deve encerrá-lo). Sem PID (spawn que falhou) não há o que registrar.
   * @returns {{pid:number|null, release:()=>void}}  `release()` só depois de o processo ter terminado de fato (idempotente; nunca lança).
   */
  function track(kind, pid, extra = {}) {
    if (!CHILD_KINDS.includes(kind)) throw new TypeError(`Tipo de processo desconhecido: ${String(kind).slice(0, 40)}`);
    if (!Number.isInteger(pid) || pid <= 0) return NOOP;
    const l = list();
    if (!l) return NOOP;
    for (const old of l.filter((r) => !pidAlive(r.pid))) drop(old); // registros de processos que já terminaram (por exemplo, órfãos encerrados por "Interromper")
    const rec = { id: store.uid('proc'), kind, pid, startedAt: store.now(), ...extra };
    l.push(rec);
    // Gravação CONFIRMADA: save() que devolve false (falha de escrita) também conta como falha. Sem o PID no disco o filho não seria reclamável depois de uma queda.
    try {
      if (store.save() === false) throw Object.assign(new Error('o banco não pôde ser gravado em disco'), { code: store.persistenceStatus?.().error || 'PERSISTENCE', persistence: true });
    } catch (e) { drop(rec); throw e; }
    let released = false;
    return {
      pid,
      release() {
        if (released) return; released = true;
        try { drop(rec); store.saveSoon(); } catch { /* o registro restante é inofensivo: no próximo boot o PID não existe mais (ou é reconhecido como outro processo) */ }
      },
    };
  }

  /**
   * No boot (depois de setupExecution): confere os registros deixados por um servidor anterior. Encerra o que comprovadamente é o filho
   * abandonado; o que continua vivo (identidade não confirmada ou encerramento que falhou) fica registrado e BLOQUEIA o executor.
   * Nunca lança por causa de um registro malformado.
   */
  function reclaim({ executor } = {}) {
    reclaimedOnce = true;
    const l = list();
    if (!l || !l.length) return [];
    const recs = l.filter((r) => r && typeof r === 'object');
    const results = reclaimOrphans(recs.map((r) => ({ pid: r.pid, startedAt: r.startedAt })), orphanTools);
    const keep = [];
    results.forEach((res, i) => {
      const rec = recs[i], what = LABEL[rec.kind] ?? 'processo filho';
      // identidade da operação preservada no resultado (quem chamou sabe a qual missão/worktree/registro ele se refere)
      Object.assign(res, { kind: rec.kind, recordId: rec.id ?? null, missionId: rec.missionId ?? null, worktreeId: rec.worktreeId ?? null });
      if (rec.worktreeId) lastOutcome.set(rec.worktreeId, res.outcome);
      store.log('execution', `Processo órfão (${what}, PID ${res.pid}) — ${res.outcome}: ${ORPHAN_NOTE[res.outcome]}${res.detail ? ` (${res.detail})` : ''}`, {
        orphan: res.outcome, process: rec.kind, ...(rec.missionId ? { missionId: rec.missionId } : {}), agent: rec.kind === 'planner' ? 'planner' : 'executor',
      });
      if (res.outcome === 'kill_failed' || res.outcome === 'unverified') {
        executor?.adoptOrphan?.(res.pid, res.processStart ?? res.expectedStart ?? null); // vivo e possivelmente ativo: ocupa o executor; o registro fica para o próximo boot
        keep.push(rec);
      }
    });
    store.get()[CHILD_KEY] = keep;
    store.save();
    return results;
  }

  /** Registros `preparer` ainda existentes de um worktree (depois do reclaim do boot só sobram os vivos ou de identidade não confirmada). */
  const byWorktree = (worktreeId) => (list() ?? []).filter((r) => r && r.kind === 'preparer' && r.worktreeId === worktreeId);

  /**
   * Reconfere os registros `preparer` de um worktree SEM encerrar nada: gone/reused => o registro sai (não há processo preparador ativo); qualquer outro
   * resultado (vivo com identidade confirmada, unverified, kill_failed) => BLOQUEIA. A identidade é a de sempre (orphans.js): mesmo PID com hora de criação
   * próxima da registrada; não prova que o processo é o npm correto.
   */
  function check(worktreeId) {
    const mine = byWorktree(worktreeId);
    if (!mine.length) return { blocking: [], released: [] };
    const results = reclaimOrphans(mine.map((r) => ({ pid: r.pid, startedAt: r.startedAt })), { ...orphanTools, kill: () => {}, wait: () => false });
    const blocking = [], released = [];
    results.forEach((res, i) => {
      if (res.outcome === 'gone' || res.outcome === 'reused') { released.push({ ...res, recordId: mine[i].id }); drop(mine[i]); } else blocking.push({ ...res, recordId: mine[i].id });
    });
    if (released.length) { try { store.save(); } catch { /* o registro restante é inofensivo */ } }
    return { blocking, released };
  }

  return { track, reclaim, byWorktree, check, reclaimed: () => reclaimedOnce, lastOutcome: (worktreeId) => lastOutcome.get(worktreeId) ?? null, pending: () => [...(list() ?? [])] };
}
