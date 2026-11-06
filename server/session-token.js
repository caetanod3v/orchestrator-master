// Token de sessão por boot (M2): torna a aprovação humana real contra um agente com shell.
// Sem ele, qualquer processo local forja Host/Origin e aprova as próprias tarefas, liga o modo autônomo ou escreve na entrada de outro pane.
// O Electron gera o token, passa-o ao servidor por ORCH_API_TOKEN e o injeta SÓ nas requisições da própria janela. O servidor o consome do ambiente no boot
// e o REMOVE de process.env, para que nenhum filho (Executor, Planner, verificador, panes) o herde.
// Limite honesto: um processo do mesmo usuário ainda poderia ler a memória do servidor ou do Electron; isto barra o `curl` casual e a injeção por prompt, não um ataque dedicado.
// Sem token configurado (servidor puro aberto num navegador) nada muda: vale só a proteção de Host/Origin de origin-guard.js.
import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-orch-token';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
// Leituras que entregam a saída dos terminais em tempo real também exigem o token (as demais leituras seguem abertas, como antes).
const PROTECTED_READ = /^\/(?:terminals\/(?:stream|[^/]+\/stream)|workspaces\/[^/]+\/conversations(?:\/[^/]+)?)\/?$/i; // saída dos terminais e conversas copiadas

/** Lê ORCH_API_TOKEN, apaga do ambiente e devolve o token (ou null). Formato inválido impede o boot: nunca "protege" com um token fraco em silêncio. */
export function consumeApiTokenFromEnv(env = process.env) {
  const raw = env.ORCH_API_TOKEN;
  delete env.ORCH_API_TOKEN;
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) throw new Error('ORCH_API_TOKEN inválido: use 32 a 128 caracteres de [A-Za-z0-9_-].');
  return raw;
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** Middleware montado em `/api` (req.path relativo). Exige o token em métodos mutáveis e nos fluxos de terminal. */
export function createTokenGuard(token) {
  const want = digest(token);
  return function tokenGuard(req, res, next) {
    const method = String(req.method ?? '').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (!mutating && !PROTECTED_READ.test(req.path ?? '')) return next();
    const got = req.get(TOKEN_HEADER);
    if (typeof got === 'string' && got && timingSafeEqual(digest(got), want)) return next();
    return res.status(403).json({ error: 'Token de sessão ausente ou inválido: esta ação só é aceita a partir da interface do aplicativo.' });
  };
}
