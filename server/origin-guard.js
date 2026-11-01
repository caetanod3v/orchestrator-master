// Proteção de rede da API local (somente 127.0.0.1): validação de Host em toda a /api e de Origin nas rotas de DECISÃO humana.
// Limite honesto: protege contra páginas de navegador (CSRF), DNS rebinding e chamadas locais ingênuas ou acidentais sem Origin. NÃO é autenticação:
// um processo local hostil pode forjar cabeçalhos (e quem roda como o mesmo usuário já consegue editar o banco em disco).

const HOSTS = new Set(['localhost', '127.0.0.1']);
const HOST_RE = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i;

// Rotas de decisão: aprovação/rejeição/autorização humanas e aceitação de conclusão. Sem `Origin` (o navegador sempre o envia em POST), nada disso passa.
// Insensível a maiúsculas e com barra final opcional, como o roteamento do Express (senão `/API/CHAT/APPROVE` escaparia da regra).
const DECISION_ROUTES = [
  /^\/api\/missions\/[^/]+\/cycle\/approvals\/[^/]+\/?$/i,
  /^\/api\/missions\/[^/]+\/cycle\/accept-unverified\/?$/i,
  /^\/api\/missions\/[^/]+\/tasks\/[^/]+\/(?:approve|reject|authorize)\/?$/i,
  /^\/api\/chat\/approve\/?$/i,
];

/** `Host` de uma requisição: só localhost ou 127.0.0.1, com porta 1-65535 canônica (sem zeros à esquerda) quando presente. */
export function isAllowedHost(host) {
  if (typeof host !== 'string') return false;
  const m = HOST_RE.exec(host);
  if (!m) return false;
  if (m[2] === undefined) return true;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 && String(port) === m[2];
}

/** `Origin` por parsing de URL: http/https, host localhost/127.0.0.1, sem credenciais, caminho, consulta ou forma não canônica (ex.: `127.1`, `localhost:80`). */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (!HOSTS.has(u.hostname)) return false;
  return u.origin === origin.toLowerCase(); // compara a forma canônica: rejeita caminho, barra final, porta padrão explícita e hosts normalizados
}

export function isDecisionRoute(url) {
  const p = String(url ?? '').split('?')[0];
  return DECISION_ROUTES.some((re) => re.test(p));
}

/** Middleware de `/api`: Host válido sempre; Origin, se enviado, tem de ser permitido; nas rotas de decisão o Origin é OBRIGATÓRIO. */
export function apiGuard(req, res, next) {
  if (!isAllowedHost(req.get('host'))) return res.status(403).json({ error: 'Host não permitido.' });
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Origem não permitida.' });
  } else if (isDecisionRoute(`${req.baseUrl ?? ''}${req.path ?? ''}`)) { // o caminho que o Express usa para rotear (não `originalUrl`, que na forma absoluta traz o host)
    return res.status(403).json({ error: 'Esta decisão só é aceita a partir da interface (origem do navegador ausente).' });
  }
  return next();
}
