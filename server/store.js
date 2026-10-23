// Persistência local em arquivo JSON (escrita atômica via arquivo temporário).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildDemoMissions } from './demo.js';

// ORCH_DATA_DIR só serve para os testes isolarem o banco; não afeta o que é executado.
const DATA_DIR = process.env.ORCH_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return db;
    } catch (err) {
      const bak = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(DB_FILE, bak);
      console.error(`db.json inválido; preservado em ${bak}`);
    }
  }
  db = initial();
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

// No Windows, renomear por cima do db.json falha de forma transitória (EPERM/EBUSY) quando antivírus ou
// indexador estão com o arquivo aberto. Tenta de novo; por fim grava direto; nunca derruba o chamador por isso.
export function save() {
  const json = JSON.stringify(db, null, 2);
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
