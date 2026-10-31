// Estrutura do grafo do Cockpit (funções puras): camadas por dependência e portões de aprovação. Sem React nem DOM.
import { cycleApprovalPending } from './op-state.js';

/**
 * Portões de aprovação: UM por pendência REAL, nunca por suposição.
 *  - tarefa em `awaiting_approval` (resultado esperando a decisão humana): o portão fica logo depois dela;
 *  - ação do ciclo com aprovação `pending` (o ciclo está bloqueado em `approval_required`): ainda não existe tarefa, só `approval.action`;
 *    o portão é a "ação proposta" e fica depois da última tarefa da missão (ou ligado à Intenção quando não há tarefa).
 * Sem pendência, a lista é vazia.
 */
export function approvalGates(mission) {
  if (!mission) return [];
  const tasks = mission.tasks || [], out = [];
  for (const t of tasks) if (t.status === 'awaiting_approval') out.push({ kind: 'task', id: `gate:${t.id}`, taskId: t.id, title: t.title, after: t.id });
  if (cycleApprovalPending(mission)) {
    const after = tasks.at(-1)?.id ?? null;
    for (const a of mission.cycle.approvals || []) if (a?.status === 'pending') out.push({ kind: 'cycle', id: `gate:${a.id}`, approval: a, title: a.action?.title ?? '', what: a.summary?.what ?? '', after });
  }
  return out;
}

/** Camadas: o nível de um nó é 1 + o maior nível dos nós de que depende (sem dependências = 0). `nodes[].deps` são ids de outros nós. */
export function layers(nodes) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map();
  const level = (n, seen = new Set()) => {
    if (memo.has(n.id)) return memo.get(n.id);
    if (seen.has(n.id)) return 0; // ciclo inesperado: não trava a tela
    seen.add(n.id);
    const ds = n.deps.map((d) => by.get(d)).filter(Boolean);
    const v = ds.length ? 1 + Math.max(...ds.map((d) => level(d, seen))) : 0;
    memo.set(n.id, v);
    return v;
  };
  const rows = [];
  nodes.forEach((n) => { (rows[level(n)] ||= []).push(n); });
  return rows.filter(Boolean);
}

/**
 * Nós do grafo: tarefas e portões. Um portão de tarefa fica ENTRE a tarefa e quem depende dela (os dependentes só podem começar depois da aprovação),
 * então, na ligação, o portão substitui a tarefa como origem. Os dados originais (tarefas, dependências) não são alterados.
 */
export function buildGraph(tasks, gates = []) {
  const ids = new Set(tasks.map((t) => t.id));
  const gateOf = new Map(gates.filter((g) => g.kind === 'task').map((g) => [g.taskId, g.id]));
  const nodes = tasks.map((t) => ({ id: t.id, kind: 'task', task: t, status: t.status, deps: (t.dependsOn || []).filter((d) => ids.has(d)).map((d) => gateOf.get(d) ?? d) }));
  for (const g of gates) nodes.push({ id: g.id, kind: 'gate', gate: g, status: 'awaiting_approval', deps: g.after && ids.has(g.after) ? [g.after] : [] });
  return { nodes, rows: layers(nodes) };
}
