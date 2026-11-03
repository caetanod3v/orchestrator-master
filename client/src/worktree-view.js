// Worktrees isolados na interface (Marco C): funções PURAS (sem React, sem rede) testadas a partir de server/test/worktrees.test.mjs.
// Só apresenta o que o servidor gravou em /api/state.worktrees; nunca decide integração, conflito nem limpeza por conta própria (o servidor revalida tudo).

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const txt = (v, n = 300) => String(v ?? '').slice(0, n);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : '—');

// Estado do ambiente -> estado já estilizado (classe s-<chave>) + rótulo.
export const STATE = {
  creating: ['running', 'criando'], ready: ['idle', 'pronto, ainda sem execução'], in_use: ['running', 'em uso (executando)'], finished: ['unverified', 'execução terminada, trabalho ainda não integrado'],
  integrated: ['completed', 'integrado à branch de destino'], failed: ['failed', 'falhou ao ser criado'], inconsistent: ['blocked', 'inconsistente (nada foi removido)'], removed: ['idle', 'removido'],
};
export const RESULT = { mergeable: 'pode ser integrado', conflict: 'conflito real', invalid: 'não integrável agora' };
export const OUTCOME = { integrated: 'integrada', refused: 'recusada', started: 'em andamento', failed_unchanged: 'falhou — a branch de destino ficou como estava', interrupted_unchanged: 'interrompida — a branch de destino ficou como estava', inconsistent: 'INCONSISTENTE — inspecione o repositório' };
export const EVENT = {
  create_started: 'criação iniciada', created: 'criado', create_failed: 'criação falhou', create_failed_leftovers: 'criação falhou (restos mantidos)', reused: 'reaproveitado', linked: 'ligado ao ciclo', unlinked: 'desligado do ciclo',
  execution_started: 'execução iniciada', execution_finished: 'execução terminada', execution_interrupted_by_restart: 'execução interrompida por reinício', execution_released: 'execução encerrada sem resultado (ciclo parou)', snapshot: 'snapshot (commit no worktree)',
  integration_checked: 'integração checada', integration_started: 'integração iniciada', integrated: 'integrado', integration_refused: 'integração recusada', integration_failed_unchanged: 'integração falhou (destino intacto)', integration_inconsistent: 'integração inconsistente',
  cleanup_started: 'limpeza iniciada', cleanup_refused: 'limpeza recusada', removed: 'removido', inconsistent: 'marcado inconsistente',
};

/** Resultado de POST /api/worktrees/:id/revalidate em texto e tipo: recovered (recuperado) | blocked (continua bloqueado, com o motivo) | inconclusive (o Git não respondeu: NÃO é sucesso) | ok (nada a recuperar). */
export function revalidateOutcome(resp) {
  const r = isObj(resp) ? resp : {}, b = isObj(r.blocked) ? r.blocked : null, reason = b ? txt(b.reason, 300) : '';
  if (r.recovered === true) return { kind: 'recovered', ok: true, text: `Recuperado: o Git confirmou o ambiente${r.recoveredTo ? ` (agora "${txt(r.recoveredTo, 30)}")` : ''}.` };
  if (r.inconclusive === true || b?.inconclusive === true) return { kind: 'inconclusive', ok: false, text: `Não foi possível determinar o estado (o Git não respondeu)${reason ? `: ${reason}` : ''}. Nada foi alterado; tente de novo quando o Git voltar a responder.` };
  if (b) return { kind: 'blocked', ok: false, text: `Continua bloqueado${reason ? `: ${reason}` : ''}. Nada foi alterado.` };
  const probs = arr(r.problems).filter(isObj).map((p) => txt(p.code, 40));
  return probs.length ? { kind: 'blocked', ok: false, text: `Continua com problemas: ${probs.join(', ')}. Nada foi alterado.` } : { kind: 'ok', ok: true, text: 'Revalidado: o registro bate com o Git.' };
}

const attemptView = (a, i) => ({
  key: `${i}-${a.id ?? 'x'}`, kind: a.kind === 'integrate' ? 'integração' : 'checagem', result: a.result ?? null, resultLabel: RESULT[a.result] ?? txt(a.result, 30), concurrent: !!a.concurrent, fastForward: !!a.fastForward,
  conflicts: arr(a.conflicts).map((c) => txt(c, 200)).slice(0, 20), overlap: arr(a.overlap).map((c) => txt(c, 200)).slice(0, 20),
  problems: arr(a.problems).filter(isObj).map((p) => ({ code: txt(p.code, 40), message: txt(p.message, 240) })), outcomeLabel: a.outcome ? (OUTCOME[a.outcome] ?? txt(a.outcome, 40)) : null,
  evidenceLabel: isObj(a.evidence) && a.evidence.level ? `rodada ${a.evidence.round ?? '?'}: evidência ${txt(a.evidence.level, 20)}${a.evidence.match ? ' (confere com o conteúdo atual)' : ' (NÃO confere com o conteúdo atual)'}` : 'sem evidência registrada',
  digest: typeof a.digest === 'string' && /^[0-9a-f]{32}$/.test(a.digest) ? a.digest : null, targetHead: short(a.targetHead), wtHead: short(a.wtHead), at: a.at ?? null,
});

/** Ambientes prontos para exibir (opcionalmente de uma missão), na ordem do servidor. Malformados são ignorados. */
export function worktreeView(items, { missionId = null } = {}) {
  return arr(items).filter((w) => isObj(w) && typeof w.id === 'string' && STATE[w.state] && (!missionId || w.missionId === missionId)).map((w) => {
    const [status, stateLabel] = STATE[w.state];
    const attempts = arr(w.attempts).filter(isObj).map(attemptView), lastCheck = [...attempts].reverse().find((a) => a.kind === 'checagem');
    const idle = ['ready', 'finished'].includes(w.state) && !w.op, last = attempts.at(-1);
    return {
      id: w.id, state: w.state, status, stateLabel, branch: txt(w.branch, 80), baseLabel: `${txt(w.baseBranch, 60)} @ ${short(w.baseCommit)}`, headLabel: short(w.headCommit), path: txt(w.path, 300), cycleId: w.cycleId ?? null,
      op: isObj(w.op) ? txt(w.op.kind, 20) : null, running: isObj(w.current) ? `rodada ${w.current.round ?? '?'}` : null, baseDirty: !!w.baseDirty, integratedCommit: w.integratedCommit ? short(w.integratedCommit) : null,
      attempts, history: arr(w.history).filter(isObj).slice(-6).map((h, i) => ({ key: `${i}-${h.at}`, at: h.at ?? null, label: EVENT[h.event] ?? txt(h.event, 40), reason: h.reason ? txt(h.reason, 200) : null })),
      // O que a interface OFERECE; o servidor revalida cada ação (estado, evidência, autorização).
      canCheck: idle, canSnapshot: idle && !!lastCheck?.problems.some((p) => p.code === 'uncommitted_changes'),
      // Só oferece integrar com o digest da ÚLTIMA tentativa, se ela foi uma checagem que deu "pode integrar". O servidor recusa se algo mudou depois.
      authorization: idle && last && last.kind === 'checagem' && last.result === 'mergeable' && last.digest ? { digest: last.digest, summary: `${short(last.wtHead)} → ${txt(w.baseBranch, 60)} (${short(last.targetHead)})${last.fastForward ? ', avanço direto' : ', commit de integração'}${last.concurrent ? ', com alterações concorrentes combináveis' : ''}` } : null,
      canCleanup: idle || w.state === 'integrated',
      // Só leitura + revalidar: oferecido a quem está inconsistente ou tem diagnóstico (o Git não pôde conferir). O servidor decide o resultado.
      diagnostic: isObj(w.diagnostic) ? `${w.diagnostic.code ? `${txt(w.diagnostic.code, 40)}: ` : ''}${txt(w.diagnostic.reason, 300)}` : null,
      canRevalidate: w.state === 'inconsistent' || (isObj(w.diagnostic) && w.state !== 'removed'),
      note: w.state === 'inconsistent' ? 'O registro não bate mais com o Git. Nada é corrigido nem removido automaticamente; inspecione o repositório.' : w.state === 'finished' ? 'Nada é integrado sozinho: verifique, registre o snapshot e autorize.' : null,
    };
  });
}

// ---------- Configurações (painel "Worktrees isolados") ----------
const SOURCE = { env: 'definido pelo ambiente do servidor', settings: 'definido nas configurações', default: 'padrão (desligado)' };
/** Modelo do painel a partir de /api/state.worktrees. null se o servidor não informou. */
export function worktreeForm(wt, { activeCycle = false } = {}) {
  if (!isObj(wt) || !isObj(wt.isolation) || typeof wt.isolation.enabled !== 'boolean') return null;
  const source = ['env', 'settings', 'default'].includes(wt.isolation.source) ? wt.isolation.source : 'default', locked = source === 'env';
  const reason = locked ? 'Definido pela variável de ambiente ORCH_WORKTREE_ISOLATION: para mudar, altere o ambiente do servidor e reinicie.' : activeCycle ? 'Há um ciclo em andamento: aguarde terminar ou cancele para mudar.' : null;
  const pending = arr(wt.items).filter((w) => isObj(w) && ['finished', 'inconsistent'].includes(w.state)).length;
  return {
    enabled: wt.isolation.enabled, source, sourceLabel: SOURCE[source], locked, disabled: locked || activeCycle, reason, pending,
    unregistered: arr(wt.unregistered).filter(isObj).map((u) => txt(u.branch, 80)),
    notes: [
      'Com o isolamento ligado, cada ciclo roda em um worktree próprio (branch orch/…), nunca na branch nem no workspace principal. Se o ambiente não puder ser criado, o ciclo nem começa.',
      'Integrar é uma ação humana explícita: exige conclusão verificada do ciclo, evidência do mesmo conteúdo, destino limpo e a autorização da checagem. O orquestrador nunca faz push e nunca integra sozinho.',
      'Limpar um worktree é explícito e recusa qualquer trabalho não integrado ou alteração pendente. Não existe remoção forçada.',
    ],
  };
}
