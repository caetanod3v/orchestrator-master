// Classificação de "trabalhando" dos terminais. PURA (sem React nem rede): recebe as consultas de /api/terminals e devolve quais panes estão trabalhando de verdade.
//
// Por que não basta "a saída cresceu": o servidor soma em `bytes` TODA saída do PTY. Quando o Claude Code ativa o relatório de foco e de mouse do terminal, o xterm
// escreve no PTY (ESC[I / ESC[O ao focar e desfocar, relatórios de clique e movimento), o Claude Code redesenha a tela em resposta e `bytes` cresce: um pane OCIOSO
// parecia "trabalhando" por alguns instantes só porque você clicou nele. O mesmo vale para redimensionar e para o eco do que se digita.
//
// Regras (nada de heurística sobre o conteúdo da saída, que o servidor não separa):
//   1. Interação da interface (clique, foco, teclas, mouse, redimensionamento) silencia o pane por QUIET_MS: crescimento de saída nesse intervalo é resposta à interação, não tarefa.
//   2. Mesmo fora do silêncio, uma saída isolada (um redesenho) não basta: é preciso crescimento em MIN_STREAK consultas seguidas. Trabalho real (o spinner e a saída do
//      Claude Code enquanto executa) é contínuo; um redesenho é uma rajada única.
// Tarefas entregues pelo maestro NÃO passam por aqui: o servidor as escreve no PTY e nenhuma interação da interface acontece, então a saída que causam conta normalmente.
export const QUIET_MS = 1500, MIN_STREAK = 2;

export function createActivityTracker({ now = Date.now, quietMs = QUIET_MS, minStreak = MIN_STREAK } = {}) {
  const last = new Map();   // id -> bytes da consulta anterior
  const streak = new Map(); // id -> consultas seguidas com crescimento fora do silêncio
  const quiet = new Map();  // id -> instante até o qual o pane está silenciado

  return {
    /** Algo da interface mexeu no pane (clique, foco, tecla, mouse, redimensionamento). Nunca é, por si só, trabalho. */
    noteInteraction(id) { if (typeof id === 'string') { quiet.set(id, now() + quietMs); streak.set(id, 0); } },
    /** Aplica uma consulta. Devolve o conjunto de ids trabalhando. Panes que sumiram ou terminaram são esquecidos. */
    update(sessions = []) {
      const t = now(), working = new Set(), seen = new Set();
      for (const s of sessions) {
        if (!s || s.status !== 'running' || typeof s.id !== 'string') continue;
        seen.add(s.id);
        const prev = last.get(s.id), bytes = Number.isFinite(s.bytes) ? s.bytes : 0;
        last.set(s.id, bytes);
        if (prev === undefined) { streak.set(s.id, 0); continue; }                     // primeira vez que vemos o pane: não há o que comparar
        if (bytes > prev && t >= (quiet.get(s.id) ?? 0)) streak.set(s.id, (streak.get(s.id) ?? 0) + 1);
        else streak.set(s.id, 0);                                                      // sem crescimento, ou crescimento durante o silêncio de uma interação
        if ((streak.get(s.id) ?? 0) >= minStreak) working.add(s.id);
      }
      for (const m of [last, streak, quiet]) for (const id of [...m.keys()]) if (!seen.has(id)) m.delete(id);
      return working;
    },
  };
}
