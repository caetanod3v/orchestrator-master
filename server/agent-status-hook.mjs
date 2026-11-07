#!/usr/bin/env node
// Hook do Claude Code: grava o último evento do agente em <pasta>/<session_id>.json. Chamado pelo plugin de sessão (ver agent-status.js).
// Regras: nunca escreve na saída (ela voltaria para o Claude Code), nunca falha (sempre sai com 0) e só aceita session_id no formato de UUID.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'StopFailure']);

/** Evento a gravar, ou null para ignorar. A notificação de "ocioso há 60 s" ou de login NÃO é "aguardando": não pode sobrescrever o "concluído". */
export function normalize(input) {
  const ev = input?.hook_event_name;
  if (!EVENTS.has(ev)) return null;
  if (ev !== 'Notification') return ev;
  const type = typeof input.notification_type === 'string' ? input.notification_type : '';
  if (type) return type === 'permission_prompt' || type === 'elicitation_dialog' ? 'Notification' : null;
  return /permission|approve|allow/i.test(String(input.message ?? '')) ? 'Notification' : null; // versões antigas não trazem o tipo
}

export function record(dir, input, now = () => new Date().toISOString()) {
  const sid = input?.session_id, event = normalize(input);
  if (!event || typeof sid !== 'string' || !SESSION_ID_RE.test(sid) || typeof dir !== 'string' || !dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.json`), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ event, at: now() })}\n`);
  fs.renameSync(tmp, file);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { // executado pelo Claude Code (importado nos testes, só exporta)
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { if (raw.length < 1_000_000) raw += c; });
  process.stdin.on('end', () => { try { record(process.argv[2], JSON.parse(raw)); } catch { /* nunca atrapalha o agente */ } process.exit(0); });
  process.stdin.on('error', () => process.exit(0));
}
