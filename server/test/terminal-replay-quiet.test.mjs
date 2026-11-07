// O xterm não pode responder de novo às perguntas gravadas na saída quando a tela de um terminal JÁ EXISTENTE é reconstruída (recarregar a página, atualização a quente):
// as respostas chegariam ao Claude Code vivo como teclas (vários ESC abrem o seletor de mensagens: o cursor some e as letras são ignoradas). Verificado no navegador com um TUI falso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isOld, REPLAY_QUIET_MS } from '../../client/src/terminal-stream.js';

test('isOld: terminal com mais de 5 s de vida é "antigo" (replay mudo); recém-criado ou data inválida não', () => {
  const now = Date.parse('2026-01-01T10:00:30.000Z'), at = (ms) => new Date(now - ms).toISOString();
  assert.equal(isOld(at(REPLAY_QUIET_MS + 1), now), true);
  assert.equal(isOld(at(REPLAY_QUIET_MS - 1), now), false, 'recém-criado: o Claude Code ainda espera as respostas da partida');
  assert.equal(isOld(at(0), now), false);
  assert.equal(isOld(undefined, now), false); assert.equal(isOld('lixo', now), false); assert.equal(isOld(null, now), false);
});

test('o pane fica mudo durante o replay e volta a enviar teclas depois; teclas e respostas ao vivo não são afetadas', () => {
  const g = fs.readFileSync(new URL('../../client/src/components/TerminalGrid.jsx', import.meta.url), 'utf8');
  assert.match(g, /let muted = false;/);
  assert.match(g, /term\.onData\(\(d\) => \{ if \(muted\) return; noteInteraction\(id\); if \(runningRef\.current\) send\(d\); \}\)/);
  assert.match(g, /muted = isOld\(session\.startedAt\); term\.reset\(\);/);
  assert.match(g, /term\.write\(text, \(\) => \{ muted = false; \}\)/, 'volta a falar assim que o replay terminou de ser processado');
  assert.doesNotMatch(g, /onData: \(d\) => \{ muted/, 'a saída ao vivo nunca é silenciada');
  assert.doesNotMatch(g, /export const isOld/, 'a regra mora num módulo puro: exportar de arquivo de componente quebra o Fast Refresh');
});
