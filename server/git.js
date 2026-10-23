// Informações somente-leitura do Git, com argumentos fixos (sem comandos arbitrários).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cwd, args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd, timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));

export async function gitInfo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { isRepo: false };
  try {
    const out = await run(dir, ['status', '--porcelain=v1', '-b']);
    const lines = out.split('\n').filter(Boolean);
    const branch = (lines[0] || '').replace(/^## /, '').split('...')[0];
    const changes = lines.slice(1).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
    return { isRepo: true, branch, dirty: changes.length > 0, changes: changes.slice(0, 50), changeCount: changes.length };
  } catch (e) {
    return { isRepo: true, error: 'Falha ao ler o status do Git' };
  }
}

// Alterações de arquivos (status + numstat), argumentos fixos e somente leitura.
export async function gitChanges(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { isRepo: false, files: [] };
  try {
    const [st, ns] = await Promise.all([run(dir, ['status', '--porcelain=v1', '-uall']), run(dir, ['diff', '--numstat']).catch(() => '')]);
    const stat = new Map(ns.split('\n').filter(Boolean).map((l) => { const [a, r, ...p] = l.split('\t'); return [p.join('\t'), { added: Number(a) || 0, removed: Number(r) || 0 }]; }));
    const files = st.split('\n').filter(Boolean).slice(0, 200).map((l) => {
      const p = l.slice(3).replace(/^"|"$/g, '');
      const n = stat.get(p);
      return { path: p, status: l.slice(0, 2).trim() || '?', added: n ? n.added : null, removed: n ? n.removed : null };
    });
    return { isRepo: true, files };
  } catch { return { isRepo: true, files: [], error: 'Falha ao ler alterações do Git' }; }
}
