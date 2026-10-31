import { api } from './api.js';
import { useStore } from './store.jsx';

/**
 * Ações do ciclo autônomo de uma missão (rotas /api/missions/:id/cycle/*), num só lugar: usadas pelo painel Ciclo e pelo portão de aprovação do grafo.
 * Aprovar uma ação do ciclo registra a decisão e, em seguida, retoma o ciclo (como sempre); rejeitar só registra a decisão. O servidor revalida tudo (digest, política, estado).
 */
export function useCycleActions(mission) {
  const { act, notify } = useStore();
  const call = async (path, body, ok) => {
    const r = await act(async () => { await api.post(`/api/missions/${mission.id}/cycle/${path}`, body); return true; });
    if (r && ok) notify(ok);
    return !!r;
  };
  const approveAction = async (a) => { if (await call(`approvals/${a.id}`, { decision: 'approve', digest: a.digest })) await call('resume', {}, 'Ação aprovada; ciclo retomado.'); };
  const rejectAction = (a) => call(`approvals/${a.id}`, { decision: 'reject', digest: a.digest }, 'Ação rejeitada. Retome para o Planner escolher outro caminho.');
  return { call, approveAction, rejectAction };
}
