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

// ---------- Preparação de ambiente (Marco E, E4) ----------
// Estados vindos do SERVIDOR (worktree.prepare.state + op + diagnostic). "planned" e "approved" são só fases da tela (plano mostrado / aprovação enviada), nunca gravadas.
const PREP = {
  planned: ['unverified', 'Plano gerado: aguardando a sua aprovação'], approved: ['running', 'Aprovado: aguardando o servidor iniciar'], running: ['running', 'Preparando o ambiente (npm ci em execução)'],
  ready: ['completed', 'Ambiente preparado e conferido pelo sistema'], failed: ['failed', 'A preparação falhou (a verificação continua bloqueada)'], interrupted: ['interrupted', 'Preparação INTERROMPIDA: não é um ambiente pronto'],
  inconclusive: ['blocked', 'Preparação INCONCLUSIVA: o worktree permanece BLOQUEADO'],
};
export const PREPARE_LABEL = Object.fromEntries(Object.entries(PREP).map(([k, v]) => [k, v[1]]));
/** Estado de preparação de um ambiente (do que o servidor gravou). state null = nunca houve preparação. Inconclusivo nunca é sucesso nem "em andamento". */
export function prepareView(w) {
  const p = isObj(w?.prepare) ? w.prepare : null, d = isObj(w?.diagnostic) ? w.diagnostic : null, opPrep = isObj(w?.op) && w.op.kind === 'prepare';
  const inconclusive = !!d && d.code === 'preparation_inconclusive';
  const state = inconclusive ? 'inconclusive' : opPrep ? 'running' : p && PREP[p.state] && p.state !== 'planned' && p.state !== 'approved' ? p.state : null;
  const [value, label] = state ? PREP[state] : [null, null];
  return {
    state, value, label, inconclusive, running: state === 'running', reason: p?.reason ? txt(p.reason, 400) : null, outputTail: p?.outputTail ? txt(p.outputTail, 1500) : null,
    exitCode: Number.isInteger(p?.exitCode) ? p.exitCode : null, durationMs: Number.isFinite(p?.durationMs) ? p.durationMs : null, dependencies: Number.isInteger(p?.dependencies) ? p.dependencies : null,
    approvedAt: p?.approval?.approvedAt ?? null, digest: typeof p?.approval?.digest === 'string' ? p.approval.digest : null, diagnostic: d ? txt(d.reason, 300) : null,
    inconclusiveText: inconclusive ? 'O servidor não conseguiu provar que a preparação anterior terminou (o processo pode ainda existir). O worktree continua bloqueado, nada foi liberado e nenhuma nova preparação pode ser iniciada. Resolva a situação (confira se o npm ainda está em execução) e use Revalidar.' : null,
  };
}
/** A verificação do ciclo foi recusada por ambiente frio? Devolve o id do worktree que precisa de preparação (ou null). Usa o CÓDIGO gravado, nunca o texto. */
export function needsEnvironment(mission) {
  const c = isObj(mission?.cycle) ? mission.cycle : null, last = arr(c?.rounds).at(-1);
  const hit = arr(last?.report?.verifications).some((v) => isObj(v) && v.status === 'blocked' && ['dependencies_not_prepared', 'dependencies_incomplete'].includes(v.code));
  return hit && typeof c.worktreeId === 'string' ? c.worktreeId : null;
}
/** "Preparar ambiente" só é oferecido a um ambiente parado e sem dúvida pendente que precisa de preparação (verificação recusada por ambiente) ou que falhou/foi interrompido (nova tentativa explícita). */
export const canOfferPrepare = (row, needsId) => !!row && row.canPrepare === true && (row.id === needsId || ['failed', 'interrupted'].includes(row.prepare?.state));
const short64 = (s) => (typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s : null);
/** Plano devolvido por POST .../prepare/plan, pronto para exibir. null se a resposta não é um plano válido (nada é inventado). */
export function planView(resp) {
  const p = isObj(resp?.plan) ? resp.plan : null, digest = short64(resp?.digest);
  if (!p || !digest) return null;
  const deps = arr(p.dependencies?.items).filter(isObj).map((d) => ({ name: txt(d.name, 120), spec: txt(d.spec, 120), section: d.section === 'devDependencies' ? 'dev' : 'prod' }));
  return {
    digest, command: txt(p.command, 200), manager: txt(p.manager, 20), worktree: { id: txt(p.worktree?.id, 40), path: txt(p.worktree?.path, 300), branch: txt(p.worktree?.branch, 80) },
    dependencies: deps.slice(0, 300), dependencyCount: Number.isInteger(p.dependencies?.count) ? p.dependencies.count : deps.length, truncated: deps.length > 300,
    registry: { url: txt(p.npmrc?.registry?.url, 200), source: p.npmrc?.registry?.source === '.npmrc' ? 'do .npmrc do projeto' : 'padrão do npm' },
    scoped: arr(p.npmrc?.scopedRegistries).filter(isObj).map((x) => ({ scope: txt(x.scope, 60), url: txt(x.url, 200) })), npmrc: !!p.npmrc?.present,
    hosts: arr(p.resolvedHosts).map((h) => txt(h, 120)).slice(0, 50), warnings: arr(p.warnings).filter((x) => typeof x === 'string').map((x) => txt(x, 500)), notes: arr(resp.notes).filter((x) => typeof x === 'string').map((x) => txt(x, 500)),
    lockfile: { version: p.lockfile?.version ?? null, packages: Number.isInteger(p.lockfile?.packages) ? p.lockfile.packages : null, sha256: short64(p.lockfile?.sha256) },
  };
}
const STALE = ['digest_mismatch'], BLOCKED = ['preparation_in_progress', 'preparation_inconclusive', 'worktree_not_preparable', 'cycle_active', 'worktree_invalid', 'environment_already_prepared'];
/** Erro das rotas de plano/preparação (Error com status/code, ver api.js). Nunca esconde a mensagem do servidor; plano rejeitado exige NOVO plano (nunca reaprova sozinho). */
export function prepareErrorView(e) {
  const code = typeof e?.code === 'string' ? e.code : null, status = Number.isInteger(e?.status) ? e.status : null, message = txt(e?.message || 'erro desconhecido', 400);
  const stale = STALE.includes(code), blocked = BLOCKED.includes(code), network = status === null && !code;
  const text = stale ? `O plano está desatualizado ou foi rejeitado pelo servidor: ${message} Nada foi executado. Gere um NOVO plano e confira-o antes de aprovar.`
    : network ? `Falha de comunicação com o servidor (${message}). Não é possível afirmar se a preparação foi iniciada: use "Consultar estado" antes de qualquer nova tentativa.`
      : `${message}${code ? ` (${code})` : ''} Nada foi executado.`;
  return { code, status, message, stale, blocked, network, text };
}

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
      prepare: prepareView(w), canPrepare: idle && !prepareView(w).inconclusive && !prepareView(w).running,
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
