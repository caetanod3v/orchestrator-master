// Status global do FORGE (um só componente), PURO: reorganiza as sessões reais de /api/terminals, o estado dos agentes e as tarefas do maestro. Nenhuma contagem é inventada;
// os números vêm das mesmas regras dos indicadores de terminal, aba e sidebar (paneState/tally), então nunca divergem delas.
import { paneState, pendingPanes, friendlyNames, providerSummary } from './env-view.js';
import { tally } from './workspace-nav.js';

const MAX_LIST = 8;

/**
 * @returns {{tone:'err'|'warn'|'work'|'done'|'idle', ativos:number, executando:number, aguardando:number, falhas:number, max:number|null, livres:number|null,
 *            groups:{working:Item[],waiting:Item[],failed:Item[]}, more:{working:number,waiting:number,failed:number}, providers:{id:string,label:string,available:boolean,total:number,active:number}[]}}
 * `ativos` = terminais com processo vivo (agentes ativos); `executando` = agentes trabalhando agora; `aguardando` = pedem a sua decisão; `falhas` = terminaram com erro ou reportaram falha.
 */
export function systemStatus({ sessions = [], workingIds = new Set(), tasks = [], workspaces = [], max = null } = {}) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const c = tally(list, workingIds, tasks);
  const pend = pendingPanes(tasks), names = friendlyNames(workspaces);
  const item = (s) => ({ id: s.id, title: String(s.title ?? s.id), role: s.roleLabel ?? s.role ?? '', workspaceId: s.workspaceId ?? null, workspace: names.get(s.workspaceId) ?? '' });
  const by = (k) => list.filter((s) => paneState(s, workingIds, pend) === k).map(item);
  const g = { working: by('working'), waiting: by('waiting'), failed: by('failed') };
  const cap = (a) => a.slice(0, MAX_LIST), more = (a) => Math.max(0, a.length - MAX_LIST);
  const tone = c.failed ? 'err' : c.waiting ? 'warn' : c.working ? 'work' : c.done ? 'done' : 'idle';
  const m = Number.isInteger(max) && max > 0 ? max : null;
  return {
    tone, ativos: c.running, executando: c.working, aguardando: c.waiting, falhas: c.failed, max: m, livres: m === null ? null : Math.max(0, m - c.running),
    groups: { working: cap(g.working), waiting: cap(g.waiting), failed: cap(g.failed) }, more: { working: more(g.working), waiting: more(g.waiting), failed: more(g.failed) },
    providers: providerSummary(list, workingIds).map((r) => ({ id: r.id, label: r.label, available: r.available, total: r.total, active: r.active })),
  };
}

/** Texto compacto: "4 ativos · 2 executando · 1 aguardando · 0 falhas". */
export function statusLine(s) {
  return `${s.ativos} ${s.ativos === 1 ? 'ativo' : 'ativos'} · ${s.executando} executando · ${s.aguardando} aguardando · ${s.falhas} ${s.falhas === 1 ? 'falha' : 'falhas'}`;
}
