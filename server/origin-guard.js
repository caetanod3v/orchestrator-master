// Proteção de rede da API local (somente 127.0.0.1): validação de Host em toda a /api e de Origin em toda requisição mutável (POST/PUT/PATCH/DELETE).
// Limite honesto: protege contra páginas de navegador (CSRF), DNS rebinding e chamadas locais ingênuas ou acidentais sem Origin. NÃO é autenticação:
// um processo local hostil pode forjar cabeçalhos (e quem roda como o mesmo usuário já consegue editar o banco em disco).

const HOSTS = new Set(['localhost', '127.0.0.1']);
const HOST_RE = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i;

// Métodos que alteram estado: exigem `Origin` válido (o navegador sempre o envia em POST/PUT/PATCH/DELETE; GET, HEAD e OPTIONS não são afetados).
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

export function isMutatingMethod(method) {
  return MUTATING.has(String(method ?? '').toUpperCase());
}

/** Middleware de `/api`: Host válido sempre; Origin, se enviado, tem de ser permitido; em métodos mutáveis o Origin é OBRIGATÓRIO. */
export function apiGuard(req, res, next) {
  if (!isAllowedHost(req.get('host'))) return res.status(403).json({ error: 'Host não permitido.' });
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Origem não permitida.' });
  } else if (isMutatingMethod(req.method)) {
    return res.status(403).json({ error: 'Requisições que alteram estado só são aceitas com Origin válido (a partir da interface).' });
  }
  return next();
}
