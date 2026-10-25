// Persistência local em arquivo JSON (escrita atômica via arquivo temporário).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildDemoMissions } from './demo.js';

// ORCH_DATA_DIR só serve para os testes isolarem o banco; não afeta o que é executado.
const DATA_DIR = process.env.ORCH_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BAK_FILE = `${DB_FILE}.bak`;
export const dataDir = DATA_DIR; // usado pela trava de instância (instance-lock.js)

export const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

function initial() {
  return {
    version: 1,
    settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: true },
    workspaces: [],
    missions: buildDemoMissions(),
    activity: [],
  };
}

let db;
// Backup: db.json.bak guarda o ÚLTIMO ESTADO VÁLIDO anterior ao db.json atual. `lastGood` é o texto do último estado válido persistido (ou
// carregado); `bakContent` é o que sabemos estar em .bak. O backup só muda DEPOIS de o db.json novo estar gravado, só recebe um estado
// que passou em validateDb, e é trocado por rename atômico (nunca por escrita direta: não pode corromper a única cópia boa).
let lastGood = null;
let bakContent = null;
let backup = { ok: true, error: null, at: null };
/** Situação da última atualização do backup (melhor esforço: uma falha aqui NÃO impede o salvamento do banco). */
export const backupStatus = () => ({ ...backup });

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Estrutura MÍNIMA que o servidor usa logo no boot e nas rotas (initial(), setupExecution, recover, store.log): nada além disso é exigido,
 * para não rejeitar bancos antigos legítimos. Devolve o motivo da rejeição ou null.
 */
export function validateDb(d) {
  if (!isObj(d)) return 'a raiz não é um objeto';
  if (!isObj(d.settings)) return '"settings" ausente ou inválido';
  for (const k of ['workspaces', 'missions', 'activity']) if (!Array.isArray(d[k])) return `"${k}" ausente ou não é uma lista`;
  if (d.workspaces.some((w) => !isObj(w) || typeof w.id !== 'string' || typeof w.path !== 'string')) return 'há workspace sem id/path';
  for (const m of d.missions) {
    if (!isObj(m) || typeof m.id !== 'string' || !Array.isArray(m.tasks)) return 'há missão sem id ou sem lista de tarefas';
    if (m.tasks.some((t) => !isObj(t))) return `a missão ${m.id} tem tarefa inválida`;
    if (m.cycle != null && (!isObj(m.cycle) || !Array.isArray(m.cycle.rounds))) return `o ciclo da missão ${m.id} não tem a lista de rodadas`;
  }
  return null;
}

/** Lê e valida um arquivo do banco SEM alterá-lo. */
function readCandidate(file) {
  let raw;
  for (let i = 0; ; i++) {
    try { raw = fs.readFileSync(file, 'utf8'); break; } catch (e) {
      if (e.code === 'ENOENT') return { missing: true };
      if (TRANSIENT.includes(e.code) && i < 4) { sleepSync(15 * (i + 1)); continue; } // antivírus/indexador com o arquivo aberto
      return { unreadable: true, reason: `ilegível (${e.code || e.message})` }; // não é dado inválido: nada se conclui sobre o conteúdo
    }
  }
  if (!raw.trim()) return { reason: 'arquivo vazio' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { reason: `JSON inválido (${e.message})` }; }
  const why = validateDb(parsed);
  return why ? { reason: `estrutura inválida: ${why}` } : { db: parsed, raw };
}

/** Guarda uma cópia de diagnóstico de um arquivo inválido (nunca o apaga). Lança se não conseguir: melhor falhar alto do que perdê-lo. */
function preserve(file, label) {
  const dest = `${file}.corrupt-${Date.now()}`;
  fs.copyFileSync(file, dest);
  console.error(`[store] ${label} inválido; cópia preservada em ${dest}`);
  return dest;
}

/**
 * Carrega o banco. Ordem: db.json -> db.json.tmp -> db.json.bak (a 1ª cópia VÁLIDA vence). Um arquivo inválido é preservado
 * (db.json.corrupt-*) e só é substituído depois de a alternativa ter sido lida e validada. Sem nenhuma cópia válida o servidor sobe
 * em modo degradado, com um registro explícito na atividade (nunca um reset silencioso). Arquivo ausente sem cópias = primeira execução.
 */
export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const main = readCandidate(DB_FILE);
  if (main.db) { db = main.db; lastGood = main.raw; return db; }
  // Falha de LEITURA (não de conteúdo) do db.json: nunca trocar um arquivo possivelmente bom por uma cópia mais antiga. Falha alto, sem tocar em nada.
  if (main.unreadable) throw new Error(`[store] db.json ${main.reason}; nada foi alterado. Resolva o acesso ao arquivo e inicie novamente.`);

  const alts = [`${DB_FILE}.tmp`, `${DB_FILE}.bak`].map((file) => ({ file, ...readCandidate(file) }));
  const good = alts.find((x) => x.db);
  const problems = [!main.missing && `db.json: ${main.reason}`, ...alts.filter((x) => x.reason).map((x) => `${path.basename(x.file)}: ${x.reason}`)].filter(Boolean);

  if (good) {
    // 1) a cópia boa já foi lida e validada; 2) preserva o db.json inválido; 3) só então troca o db.json (copia para um nome auxiliar e renomeia)
    const kept = main.missing ? null : preserve(DB_FILE, 'db.json');
    const staged = `${DB_FILE}.restore`;
    fs.copyFileSync(good.file, staged);
    try { fs.renameSync(staged, DB_FILE); } catch (e) { console.error('[store] não foi possível substituir db.json agora; o próximo save() tentará de novo:', e.code, e.message); }
    db = good.db; lastGood = good.raw; bakContent = good.file.endsWith('.bak') ? good.raw : null;
    log('system', `Banco recuperado de ${path.basename(good.file)}: ${main.missing ? 'db.json não existia' : `db.json estava inválido (${main.reason}); cópia em ${path.basename(kept)}`}.`, { recovery: 'restored', source: path.basename(good.file) });
    console.error(`[store] banco recuperado de ${path.basename(good.file)}`);
    save();
    return db;
  }

  if (!problems.length) { db = initial(); save(); return db; } // primeira execução: nada existia

  // Sem cópia válida: preserva o que existia (db.json é movido, os demais copiados) e sobe em modo DEGRADADO, deixando isso explícito.
  const kept = [];
  if (!main.missing) { kept.push(preserve(DB_FILE, 'db.json')); fs.rmSync(DB_FILE, { force: true }); }
  for (const x of alts) if (x.reason) kept.push(preserve(x.file, path.basename(x.file)));
  db = initial();
  log('system', `RECUPERAÇÃO DEGRADADA: nenhuma cópia válida do banco (${problems.join('; ')}). Foi iniciado um banco novo (com missões de demonstração); os arquivos originais foram preservados: ${kept.map((f) => path.basename(f)).join(', ')}.`, { recovery: 'degraded' });
  console.error('[store] RECUPERAÇÃO DEGRADADA: banco novo iniciado; veja os arquivos .corrupt-*');
  save();
  return db;
}

let saveTimer = null;
// Salva em lote (logs de execução chegam em rajadas); o estado importante usa save() direto.
export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 500);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES', 'ENOENT'];

/** Persiste o banco. true = db.json gravado (o backup é atualizado depois, em melhor esforço; ver backupStatus()). */
export function save() {
  const json = JSON.stringify(db, null, 2);
  const ok = writeMain(json);
  if (ok) afterMainSaved(json);
  return ok;
}

/** Depois que o db.json novo está gravado: o estado válido ANTERIOR vira o .bak (se mudou) e o novo passa a ser o "último válido". */
function afterMainSaved(json) {
  const prev = lastGood;
  if (prev && json !== prev && prev !== bakContent) refreshBackup(prev);
  if (validateDb(db) === null) lastGood = json;
  else console.error('[store] o estado em memória não passa na validação; o backup anterior foi mantido como último estado válido');
}

function refreshBackup(content) {
  const tmp = `${BAK_FILE}.tmp`;
  let last;
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(tmp, content); fs.renameSync(tmp, BAK_FILE); bakContent = content; backup = { ok: true, error: null, at: now() }; return; } catch (e) {
      last = e;
      if (!TRANSIENT.includes(e.code)) break;
      sleepSync(15 * (i + 1));
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* resíduo inofensivo */ }
  backup = { ok: false, error: last?.code || last?.message || 'erro desconhecido', at: now() };
  console.error('[store] backup não atualizado (o .bak anterior foi mantido):', backup.error);
}

// No Windows, renomear por cima do db.json falha de forma transitória (EPERM/EBUSY) quando antivírus ou
// indexador estão com o arquivo aberto. Tenta de novo; por fim grava direto; nunca derruba o chamador por isso.
function writeMain(json) {
  const tmp = `${DB_FILE}.tmp`;
  for (let i = 0; i < 8; i++) {
    try { fs.writeFileSync(tmp, json); fs.renameSync(tmp, DB_FILE); return true; } catch (e) {
      if (!TRANSIENT.includes(e.code)) throw e; // erro de verdade (disco cheio, I/O…) continua visível
      sleepSync(15 * (i + 1));
    }
  }
  try { fs.writeFileSync(DB_FILE, json); return true; } catch (e) {
    console.error('[store] não foi possível salvar o banco:', e.code, e.message);
    return false; // o estado segue em memória e o próximo save() tenta de novo
  }
}

export const get = () => db;

export function log(type, message, extra = {}) {
  db.activity.unshift({ id: uid('act'), at: now(), type, message, ...extra });
  db.activity = db.activity.slice(0, 500);
}
