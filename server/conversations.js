// Histórico de conversas PRÓPRIO, organizado por workspace: <dados>/history/<workspaceId>/<ses_…>.json (resumo) + .log (uma mensagem por linha).
// Copia só o TEXTO das trocas (usuário e assistente) do transcript que o Claude Code grava; não copia saída de ferramentas, raciocínio nem anexos. Não depende de tópicos
// nem de haver um processo Claude Code vivo: depois da captura, a conversa continua legível mesmo que o Claude apague o transcript.
// Captura incremental (só o que foi acrescentado), idempotente e tolerante: o log só é aceito até `meta.bytes`, então uma queda entre as duas gravações nunca duplica mensagens.
// Apagar é DURÁVEL: grava uma marca (<ses_…>.del) com o ponto do transcript já existente; a captura nunca recopia o que veio antes dela.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_MSG_CHARS = 20_000;       // por mensagem (o excedente é cortado e marcado)
export const MAX_LOG_BYTES = 4 * 1024 * 1024; // por sessão: depois disso para de copiar e marca `truncated`
const MAX_READ = 8 * 1024 * 1024;           // por passada de leitura do transcript
const MAX_PAGE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REC_RE = /^ses_[0-9a-f]{8}$/;
const WS_RE = /^[A-Za-z0-9_-]{1,64}$/; // nome de pasta: nunca separador de caminho
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const snip = (s, n = 200) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Melhor esforço: tira do texto copiado o que parece credencial. Não é garantia (o transcript original do Claude Code continua com o texto). */
const OMIT = '[segredo omitido]';
const SECRETS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, OMIT], [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/g, OMIT], [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, OMIT], [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, OMIT],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, OMIT], [/\bAIza[0-9A-Za-z_-]{35}\b/g, OMIT], [/\bnpm_[A-Za-z0-9]{36}\b/g, OMIT], [/\bAKIA[0-9A-Z]{16}\b/g, OMIT],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, OMIT], [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, OMIT],
  [/(:\/\/[^\s:@/]+):[^\s@/]+@/g, `$1:${OMIT}@`], // usuário:senha@ em URL
  [/([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|senha)[A-Za-z0-9_-]*)(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi, `$1$2$3${OMIT}`], // NOME_DA_VARIAVEL = valor
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, OMIT],
];
export const redact = (s) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);

/** Texto visível de uma linha do transcript → { r: 'u'|'a', t, at } ou null (ferramentas, raciocínio, meta e comandos locais não entram). */
export function messageOf(o) {
  if (!isObj(o) || o.isSidechain === true || o.isMeta === true || (o.type !== 'user' && o.type !== 'assistant')) return null;
  const c = o.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
  text = text.trim();
  if (!text || /^<(local-command|command-name|command-message|system-reminder)/.test(text)) return null;
  const cut = text.length > MAX_MSG_CHARS;
  text = redact(text.slice(0, MAX_MSG_CHARS * 2)); // limita ANTES de redigir: texto gigante não custa CPU
  if (text.length > MAX_MSG_CHARS) text = text.slice(0, MAX_MSG_CHARS);
  return { r: o.type === 'user' ? 'u' : 'a', t: cut ? `${text}\n[…cortado]` : text, at: typeof o.timestamp === 'string' && o.timestamp.length <= 40 ? o.timestamp : null };
}

export function createConversationStore({ dir, configDir = claudeConfigDir(), now = () => new Date().toISOString() } = {}) {
  if (!dir) throw new Error('createConversationStore: dir é obrigatório');
  const wsDir = (ws) => path.join(dir, ws), metaPath = (ws, rec) => path.join(dir, ws, `${rec}.json`), logPath = (ws, rec) => path.join(dir, ws, `${rec}.log`), tombPath = (ws, rec) => path.join(dir, ws, `${rec}.del`);
  const projectsRoot = path.join(configDir, 'projects');
  const lastSig = new Map(); // `${ws}/${rec}` -> assinatura do último resumo gravado (sem nada novo, não regrava)

  const isFile = (f) => { try { return fs.lstatSync(f).isFile(); } catch { return false; } }; // lstat: symlink não conta
  function locate(claudeId) {
    if (!UUID_RE.test(String(claudeId))) return null;
    let dirs; try { dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return null; }
    for (const d of dirs) { if (!d.isDirectory()) continue; const f = path.join(projectsRoot, d.name, `${claudeId}.jsonl`); if (isFile(f)) return f; }
    return null;
  }
  /** Reaproveita o arquivo já conhecido (sem varrer todos os projetos), desde que continue sendo o transcript DESTA sessão. */
  function knownFile(m, claudeId) {
    const f = m?.srcFile; if (typeof f !== 'string') return null;
    const rel = path.relative(projectsRoot, f);
    return path.basename(f) === `${String(claudeId).toLowerCase()}.jsonl` && rel && !rel.startsWith('..') && !path.isAbsolute(rel) && isFile(f) ? f : null;
  }
  function readMeta(ws, rec) {
    try { const m = JSON.parse(fs.readFileSync(metaPath(ws, rec), 'utf8')); return isObj(m) && m.recordId === rec && m.workspaceId === ws ? m : null; } catch { return null; }
  }
  function readTomb(ws, rec) { try { const t = JSON.parse(fs.readFileSync(tombPath(ws, rec), 'utf8')); return isObj(t) && typeof t.srcFile === 'string' && Number.isSafeInteger(t.srcOffset) && t.srcOffset >= 0 ? t : null; } catch { return null; } }
  function writeAtomic(file, text) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

  /**
   * Copia o que há de novo no transcript da sessão. `rec` = registro de sessão (terminals.js): { id, workspaceId, claudeSessionId, title, role }.
   * Devolve { ok, added } ou { ok:false, reason }. Nunca lança.
   */
  function sync(rec) {
    try {
      if (!isObj(rec) || !REC_RE.test(String(rec.id)) || !WS_RE.test(String(rec.workspaceId))) return { ok: false, reason: 'registro_invalido' };
      const ws = rec.workspaceId, key = `${ws}/${rec.id}`;
      let m = readMeta(ws, rec.id);
      const file = knownFile(m, rec.claudeSessionId) ?? locate(rec.claudeSessionId); if (!file) return { ok: false, reason: 'sem_transcricao' };
      let size = 0; try { size = fs.statSync(file).size; } catch { return { ok: false, reason: 'sem_transcricao' }; }
      fs.mkdirSync(wsDir(ws), { recursive: true });
      const tomb = readTomb(ws, rec.id);
      const fresh = (createdAt = now()) => ({ v: 1, recordId: rec.id, workspaceId: ws, createdAt, updatedAt: null, lastAt: null, counts: { user: 0, assistant: 0 }, first: null, last: null, aiTitle: null, srcFile: file, srcOffset: tomb && tomb.srcFile === file && size >= tomb.srcOffset ? tomb.srcOffset : 0, bytes: 0, truncated: false });
      const lp = logPath(ws, rec.id);
      if (!m) { m = fresh(); fs.writeFileSync(lp, ''); lastSig.delete(key); }
      else if (m.srcFile !== file || size < m.srcOffset) { m = fresh(m.createdAt); fs.writeFileSync(lp, ''); lastSig.delete(key); } // arquivo diferente ou recomeçou: refaz a cópia do zero
      else { let cur = 0; try { cur = fs.statSync(lp).size; } catch { fs.writeFileSync(lp, ''); } if (cur > m.bytes) fs.truncateSync(lp, m.bytes); else if (cur < m.bytes) { m = fresh(m.createdAt); fs.writeFileSync(lp, ''); lastSig.delete(key); } }
      let added = 0;
      for (let pass = 0; pass < 8 && size > m.srcOffset; pass++) {
        if (m.truncated) { m.srcOffset = size; break; } // cópia já cheia: não relê nem reparseia o resto
        const len = Math.min(size - m.srcOffset, MAX_READ), buf = Buffer.alloc(len); let fd;
        try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, m.srcOffset); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* já fechado */ } }
        const nl = buf.lastIndexOf(0x0a); // em BYTES: nunca depende de como o texto decodifica
        if (nl < 0) { if (len === MAX_READ) { m.srcOffset += len; continue; } break; } // sem quebra de linha: ou é uma linha incompleta (espera a próxima captura) ou gigante demais (pula)
        let out = '', full = false;
        for (const ln of buf.subarray(0, nl).toString('utf8').split('\n')) {
          if (!ln) continue;
          let o; try { o = JSON.parse(ln); } catch { continue; }
          if (o?.type === 'ai-title' && typeof o.aiTitle === 'string') { m.aiTitle = snip(redact(o.aiTitle), 120); continue; }
          const msg = messageOf(o); if (!msg) continue;
          const row = `${JSON.stringify(msg)}\n`, b = Buffer.byteLength(row);
          if (m.bytes + b > MAX_LOG_BYTES) { m.truncated = true; full = true; break; }
          out += row; m.bytes += b; added++;
          if (msg.r === 'u') { m.counts.user++; if (m.first === null) m.first = snip(msg.t); } else m.counts.assistant++;
          m.last = snip(msg.t); if (msg.at) m.lastAt = msg.at;
        }
        if (out) fs.appendFileSync(lp, out);
        m.srcOffset = full ? size : m.srcOffset + nl + 1;
      }
      m.srcFile = file; m.title = typeof rec.title === 'string' ? snip(rec.title, 120) : null; m.role = typeof rec.role === 'string' ? rec.role : null;
      const sig = JSON.stringify({ ...m, updatedAt: null });
      if (lastSig.get(key) === sig && fs.existsSync(metaPath(ws, rec.id))) return { ok: true, added };
      m.updatedAt = now(); writeAtomic(metaPath(ws, rec.id), JSON.stringify(m)); lastSig.set(key, sig);
      return { ok: true, added };
    } catch (e) { return { ok: false, reason: 'erro', message: String(e?.code || e?.message || e).slice(0, 80) }; }
  }

  const summary = (m) => ({ id: m.recordId, workspaceId: m.workspaceId, title: m.title ?? null, aiTitle: m.aiTitle ?? null, role: m.role ?? null, first: m.first ?? null, last: m.last ?? null, user: num(m.counts?.user), assistant: num(m.counts?.assistant), lastAt: m.lastAt ?? null, updatedAt: m.updatedAt ?? null, truncated: m.truncated === true });
  /** Conversas de UM workspace, mais recentes primeiro. `q` filtra por título, primeira e última mensagem (não lê os logs). Sem nenhuma mensagem não aparece. */
  function list(ws, { q = '' } = {}) {
    if (!WS_RE.test(String(ws))) return [];
    let names; try { names = fs.readdirSync(wsDir(ws)); } catch { return []; }
    const needle = String(q ?? '').trim().toLowerCase().slice(0, 100);
    return names.filter((n) => n.endsWith('.json') && REC_RE.test(n.slice(0, -5))).map((n) => readMeta(ws, n.slice(0, -5))).filter(Boolean).map(summary)
      .filter((s) => s.user + s.assistant > 0)
      .filter((s) => !needle || [s.title, s.aiTitle, s.first, s.last].some((x) => typeof x === 'string' && x.toLowerCase().includes(needle)))
      .sort((a, b) => String(b.lastAt ?? b.updatedAt).localeCompare(String(a.lastAt ?? a.updatedAt)));
  }
  /** Mensagens de uma conversa, paginadas. */
  function read(ws, rec, { offset = 0, limit = 100 } = {}) {
    if (!WS_RE.test(String(ws)) || !REC_RE.test(String(rec))) return null;
    const m = readMeta(ws, rec); if (!m) return null;
    let lines = []; try { lines = fs.readFileSync(logPath(ws, rec)).subarray(0, m.bytes).toString('utf8').split('\n').filter(Boolean); } catch { /* sem log */ } // corta em BYTES: linha ainda não confirmada não aparece
    const off = Math.max(0, Math.floor(num(offset))), lim = Math.min(MAX_PAGE, Math.max(1, Math.floor(num(limit)) || 100));
    const messages = []; for (const l of lines.slice(off, off + lim)) { try { messages.push(JSON.parse(l)); } catch { /* linha ruim: ignora */ } }
    return { ...summary(m), total: lines.length, offset: off, messages };
  }
  /** Apaga a cópia e DEIXA UMA MARCA: o que já está no transcript não volta na próxima captura. Lança se a marca não puder ser gravada (nada é apagado). */
  function remove(ws, rec) {
    if (!WS_RE.test(String(ws)) || !REC_RE.test(String(rec))) return false;
    const m = readMeta(ws, rec); if (!m) return false;
    let off = num(m.srcOffset); try { off = fs.statSync(m.srcFile).size; } catch { /* sem transcript: vale o ponto já copiado */ }
    writeAtomic(tombPath(ws, rec), JSON.stringify({ srcFile: m.srcFile, srcOffset: off, deletedAt: now() }));
    for (const f of [metaPath(ws, rec), logPath(ws, rec)]) { try { fs.unlinkSync(f); } catch { /* já não existia */ } }
    lastSig.delete(`${ws}/${rec}`);
    return true;
  }
  /** Workspace removido do cadastro: leva junto a pasta das suas conversas. */
  function removeWorkspace(ws) {
    if (!WS_RE.test(String(ws))) return false;
    try { fs.rmSync(wsDir(ws), { recursive: true, force: true }); } catch { return false; }
    for (const k of [...lastSig.keys()]) if (k.startsWith(`${ws}/`)) lastSig.delete(k);
    return true;
  }
  return { sync, list, read, remove, removeWorkspace, locate };
}

/** Rotas: GET .../conversations (?q=), GET .../conversations/:rec (?offset=&limit=), DELETE .../conversations/:rec (409 se a sessão ainda está rodando). */
export function setupConversations(app, { db, conversations }) {
  const ws = (req, res) => { const w = db.workspaces.find((x) => x.id === req.params.id); if (!w) { res.status(404).json({ error: 'Workspace não encontrado.' }); return null; } return w; };
  app.get('/api/workspaces/:id/conversations', (req, res) => { const w = ws(req, res); if (!w) return; res.json({ conversations: conversations.list(w.id, { q: typeof req.query.q === 'string' ? req.query.q : '' }) }); });
  app.get('/api/workspaces/:id/conversations/:rec', (req, res) => {
    const w = ws(req, res); if (!w) return;
    const c = conversations.read(w.id, req.params.rec, { offset: Number(req.query.offset), limit: Number(req.query.limit) });
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada neste workspace.' });
    res.json(c);
  });
  app.delete('/api/workspaces/:id/conversations/:rec', (req, res) => {
    const w = ws(req, res); if (!w) return;
    const rec = (Array.isArray(db.terminalSessions) ? db.terminalSessions : []).find((r) => r && r.id === req.params.rec);
    if (rec?.state === 'running') return res.status(409).json({ error: 'A sessão ainda está aberta; feche o terminal antes de apagar a conversa.' });
    let ok; try { ok = conversations.remove(w.id, req.params.rec); } catch { return res.status(500).json({ error: 'Não foi possível apagar a conversa; nada foi alterado.' }); }
    if (!ok) return res.status(404).json({ error: 'Conversa não encontrada neste workspace.' });
    res.status(204).end();
  });
}

/** Captura periódica das sessões rodando + varredura única das demais (em fatias, sem travar o servidor). Só registros de workspaces cadastrados. Devolve { stop, sweep }. */
export function startConversationCapture({ db, conversations, everyMs = 5000, setTimer = setInterval, clearTimer = clearInterval }) {
  const known = (r) => (db.workspaces ?? []).some((w) => w.id === r.workspaceId);
  const recs = () => (Array.isArray(db.terminalSessions) ? db.terminalSessions : []).filter((r) => r && known(r));
  const live = setTimer(() => { for (const r of recs()) if (r.state === 'running') conversations.sync(r); }, everyMs); live?.unref?.();
  let stopped = false;
  function sweep() { const todo = recs().slice(); return new Promise((resolve) => { const step = () => { if (stopped || !todo.length) return resolve(); conversations.sync(todo.pop()); setImmediate(step); }; setImmediate(step); }); }
  return { sweep, stop: () => { stopped = true; clearTimer(live); } };
}
