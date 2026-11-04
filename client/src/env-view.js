// Visão derivada dos terminais para a sidebar e para a grade do Cockpit. PURA (sem React, sem rede): só reorganiza dados REAIS do servidor
// (workspaces, sessões de /api/terminals e tarefas do maestro). Nada é inventado: cada workspace cadastrado é um ambiente, sempre visível; trocar de ambiente só muda qual está ativo.

const base = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p ?? '');
const parent = (p) => { const parts = String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/); return parts.length > 1 ? parts.at(-2) : ''; };

/** Nome amigável: o rótulo que o usuário deu (displayName), senão o nome do workspace (ou a pasta); se dois ambientes ficam com o mesmo nome, a pasta-mãe os distingue ("app (clientes)"). */
export function friendlyNames(workspaces) {
  const label = (w) => (String(w.displayName ?? '').trim() || String(w.name ?? '').trim() || base(w.path) || 'sem nome');
  const count = new Map();
  for (const w of workspaces) count.set(label(w).toLowerCase(), (count.get(label(w).toLowerCase()) ?? 0) + 1);
  return new Map(workspaces.map((w) => [w.id, count.get(label(w).toLowerCase()) > 1 && parent(w.path) ? `${label(w)} (${parent(w.path)})` : label(w)]));
}

const failedExit = (s) => s.status !== 'running' && Number.isInteger(s.exitCode) && s.exitCode !== 0;

/**
 * Ambientes da sidebar: TODOS os workspaces cadastrados, na ordem de cadastro dos workspaces (estável: a lista não "pula" enquanto os agentes trabalham).
 * @returns {{id:string, name:string, path:string, active:boolean, total:number, running:number, working:number, exited:number, failed:number, pendingTasks:number, attention:boolean}[]}
 */
export function environments({ workspaces = [], sessions = [], activeId = null, workingIds = new Set(), maestroTasks = [] } = {}) {
  const names = friendlyNames(workspaces);
  const byPane = new Map(sessions.map((s) => [s.id, s]));
  return workspaces
    .map((w) => {
      const mine = sessions.filter((s) => s.workspaceId === w.id);
      const running = mine.filter((s) => s.status === 'running');
      const pendingTasks = maestroTasks.filter((t) => t.status === 'pending' && byPane.get(t.to)?.workspaceId === w.id).length;
      const failed = mine.filter(failedExit).length;
      return {
        id: w.id, name: names.get(w.id), original: String(w.name ?? '').trim() || base(w.path), renamed: !!String(w.displayName ?? '').trim(), path: w.path, active: w.id === activeId, total: mine.length, running: running.length,
        working: running.filter((s) => workingIds.has(s.id)).length, exited: mine.length - running.length, failed, pendingTasks, attention: failed > 0 || pendingTasks > 0,
      };
    });
}

/** Estado visual de um pane, só a partir do que o servidor informa: encerrado (com ou sem falha), trabalhando (a saída cresceu) ou ocioso. */
export function paneState(session, workingIds = new Set()) {
  if (session.status !== 'running') return failedExit(session) ? 'failed' : 'exited';
  return workingIds.has(session.id) ? 'working' : 'idle';
}

// Providers (CLIs) conhecidos. Hoje só o Claude Code roda nos panes: as sessões não carregam o campo `provider`, então valem como Claude Code. O Codex ainda não tem integração.
export const PROVIDERS = [
  { id: 'claude', label: 'Claude Code CLI', available: true },
  { id: 'codex', label: 'Codex CLI', available: false },
];
export const providerOf = (s) => (typeof s?.provider === 'string' && s.provider ? s.provider : 'claude');

/**
 * Painel por provider, só das sessões reais registradas (todos os ambientes). Encerrado nunca conta como ativo: `active` = processos rodando.
 * @returns {{id:string,label:string,available:boolean,total:number,active:number,working:number,idle:number,failed:number,exited:number}[]}
 */
export function providerSummary(sessions = [], workingIds = new Set()) {
  const known = new Set(PROVIDERS.map((p) => p.id));
  const rows = PROVIDERS.map((p) => ({ ...p }));
  for (const s of sessions) if (!known.has(providerOf(s))) { known.add(providerOf(s)); rows.push({ id: providerOf(s), label: providerOf(s), available: true }); }
  return rows.map((r) => {
    const mine = sessions.filter((s) => providerOf(s) === r.id), st = mine.map((s) => paneState(s, workingIds));
    const n = (k) => st.filter((x) => x === k).length;
    return { ...r, total: mine.length, active: n('working') + n('idle'), working: n('working'), idle: n('idle'), failed: n('failed'), exited: n('exited') };
  });
}

/** Tarefas do maestro que esperam decisão, por pane de destino (`to`). Só `status === 'pending'` conta; some quando a tarefa é aprovada, recusada ou expira. Não interpreta a saída do terminal. */
export function pendingByPane(tasks = []) {
  const m = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) if (t && t.status === 'pending' && typeof t.to === 'string') m.set(t.to, [...(m.get(t.to) ?? []), t]);
  return m;
}

/** Nome do pane sem repetir o papel: o título já costuma começar pelo papel ("Construtor S1.1"). */
export function paneName(session, role) {
  const label = String(session?.roleLabel || role?.label || '').trim(), title = String(session?.title ?? '').trim();
  if (!label) return { role: '', name: title };
  return !title || title.toLowerCase().includes(label.toLowerCase()) ? { role: '', name: title || label } : { role: label, name: title };
}

/** Formato da grade: colunas, linhas e se o último pane ocupa a linha inteira (contagem ímpar em 2 colunas). */
export function gridShape(n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (count <= 1) return { cols: 1, rows: 1, spanLast: false };
  const cols = count <= 4 ? 2 : count <= 9 ? 3 : 4;
  return { cols, rows: Math.ceil(count / cols), spanLast: cols === 2 && count % 2 === 1 };
}

export const MIN_TRACK = 0.18; // fração mínima de uma trilha: nenhum pane some ao arrastar
/** Trilhas iguais (frações que somam o número de trilhas). */
export const evenTracks = (n) => Array.from({ length: Math.max(1, n) }, () => 1);

/** Move o divisor entre as trilhas `i` e `i+1` por `delta` (em frações). A soma se mantém e nenhuma trilha passa de MIN_TRACK. Devolve uma cópia. */
export function dragTracks(tracks, i, delta, min = MIN_TRACK) {
  const t = [...tracks];
  if (!Number.isInteger(i) || i < 0 || i >= t.length - 1 || !Number.isFinite(delta)) return t;
  const pair = t[i] + t[i + 1];
  const a = Math.min(pair - min, Math.max(min, t[i] + delta));
  t[i] = a; t[i + 1] = pair - a;
  return t;
}

/** Posição (0 a 100, em %) do divisor após a trilha `i`. */
export function dividerAt(tracks, i) {
  const total = tracks.reduce((s, x) => s + x, 0);
  return (tracks.slice(0, i + 1).reduce((s, x) => s + x, 0) / total) * 100;
}
