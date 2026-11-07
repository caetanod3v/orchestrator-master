// Estado REAL do agente em cada terminal (Claude Code), vindo dos hooks do próprio Claude Code, não de adivinhação pela saída do PTY.
//
// Como funciona: o plugin de sessão (loadouts.js) registra hooks que chamam `agent-status-hook.mjs`; o script grava `<pasta>/<session_id>.json` com o último evento.
// Aqui ficam o mapa evento -> estado, a leitura segura desses arquivos e a montagem do hooks.json. A pasta fica FORA do workspace do usuário (como a dos plugins).
//
// Estados: running (executando), waiting (precisa de você: pedido de permissão), completed (terminou a vez), error (falha da API/turno), idle (aberto, sem atividade).
import fs from 'node:fs';
import path from 'node:path';

export const STATES = Object.freeze(['running', 'waiting', 'completed', 'error', 'idle']);
/** Evento normalizado pelo script -> estado. Evento desconhecido nunca muda nada. */
export const EVENT_STATE = Object.freeze({
  SessionStart: 'idle', SessionEnd: 'idle',
  UserPromptSubmit: 'running', PostToolUse: 'running', // PostToolUse tira o agente de "aguardando" depois que você aprova a permissão
  Notification: 'waiting', // o script só grava a notificação de permissão/pergunta (não a de "ocioso há 60 s")
  Stop: 'completed', StopFailure: 'error',
});
export const HOOK_EVENTS = Object.freeze(Object.keys(EVENT_STATE));
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 4096;

export const stateOf = (event) => (typeof event === 'string' && Object.hasOwn(EVENT_STATE, event) ? EVENT_STATE[event] : null);

/**
 * Leitor dos arquivos de status. `read(claudeSessionId, { since })` -> { state, at, event } ou null (sem arquivo, inválido ou anterior a `since`: sobra de uma execução antiga).
 * Qualquer falha de leitura devolve null: o estado é informativo e nunca derruba a listagem dos terminais.
 */
export function createAgentStatus({ dir }) {
  return {
    dir,
    read(claudeSessionId, { since = null } = {}) {
      if (typeof claudeSessionId !== 'string' || !SESSION_ID_RE.test(claudeSessionId)) return null;
      try {
        const file = path.join(dir, `${claudeSessionId}.json`);
        if (fs.statSync(file).size > MAX_FILE) return null;
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const state = stateOf(j?.event);
        if (!state || typeof j.at !== 'string' || Number.isNaN(Date.parse(j.at))) return null;
        if (since && Date.parse(j.at) < Date.parse(since)) return null;
        return { state, event: j.event, at: j.at };
      } catch { return null; }
    },
    /** Remove o arquivo de uma sessão encerrada (sem erro se não existir). */
    forget(claudeSessionId) { try { if (SESSION_ID_RE.test(claudeSessionId)) fs.rmSync(path.join(dir, `${claudeSessionId}.json`), { force: true }); } catch { /* informativo */ } },
  };
}

// Caracteres que quebrariam a linha de comando do hook (shell do Claude Code) ou o quoting: nesse caso os hooks simplesmente não são registrados.
const UNSAFE = /["`$%!\r\n\t\\]/; // aspas, crase, $, %, ! e controle: dentro de aspas duplas o resto é literal
const fwd = (p) => String(p).replace(/\\/g, '/'); // o shell do hook aceita "/" também no Windows; "\" seria consumido pelo shell

/** Conteúdo de hooks/hooks.json do plugin, ou null se algum caminho não for seguro. */
export function hooksJson({ node, script, dir }) {
  const parts = [fwd(node), fwd(script), fwd(dir)];
  if (parts.some((p) => !p || UNSAFE.test(p))) return null;
  const command = `"${parts[0]}" "${parts[1]}" "${parts[2]}"`;
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command, timeout: 5 }] }];
  return { hooks };
}
