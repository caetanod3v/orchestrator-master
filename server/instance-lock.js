// Trava de instância única do servidor. Duas instâncias sobre o MESMO diretório de dados se atropelam: a 2ª, ao subir, marcaria como
// "interrompidas" as execuções da 1ª e regravaria o banco antes de descobrir que a porta está ocupada. A trava é adquirida ANTES de
// qualquer operação do boot que possa tocar o banco (store.load, setupExecution, recover).
//
// Mecanismo: arquivo `server.lock` criado de forma EXCLUSIVA (flag "wx", atômica no Windows e no Linux) com { pid, startedAt, token }.
// No Windows o Node abre arquivos permitindo compartilhamento, então o SO não serve de trava; por isso a vivacidade vem do PID.
// Trava obsoleta (instância que caiu sem liberar): o dono não existe mais, ou ela é anterior ao boot do sistema (PID reaproveitado),
// ou é um arquivo ilegível antigo. A troca é feita por RENAME (só um processo consegue) e conferida pelo conteúdo: se o que foi movido não é
// a trava obsoleta examinada, ela é devolvida e a nova instância desiste (nunca "rouba" a trava de uma instância ativa).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LOCK_NAME = 'server.lock';
const GARBAGE_STALE_MS = 10_000; // arquivo ilegível só é obsoleto depois disso (pode estar sendo escrito agora)
const BOOT_MARGIN_MS = 5_000;

export const lockPathFor = (dir) => path.join(dir, LOCK_NAME);

/** Vivo = existe (EPERM também conta como existente). */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { unreadable: true, code: e.code }; }
  try {
    const info = JSON.parse(raw);
    if (info && Number.isInteger(info.pid) && info.pid > 0 && typeof info.token === 'string') return { raw, info };
  } catch { /* cai em "ilegível" */ }
  let ageMs = 0;
  try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { /* sumiu: tratado na próxima volta */ }
  return { raw, garbage: true, ageMs };
}

/**
 * @returns {{ok:true, lockPath:string, token:string, release:()=>void} | {ok:false, lockPath:string, holder?:object, message:string}}
 * Lança em erros de E/S inesperados (pasta sem permissão etc.): melhor falhar alto do que subir sem trava.
 * Opções (`isAlive`, `bootTime`, `pid`) existem para os testes; o servidor usa os padrões.
 */
export function acquireInstanceLock({ dir, pid = process.pid, isAlive = pidAlive, bootTime = Date.now() - os.uptime() * 1000, autoRelease = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = lockPathFor(dir);
  const token = randomUUID();
  const body = JSON.stringify({ pid, startedAt: new Date().toISOString(), token });

  const refusal = (holder, why) => ({
    ok: false, lockPath, holder,
    message: `${why} Diretório de dados: ${dir}. Encerre a outra instância antes de iniciar esta. Se tiver certeza de que ela não está em execução, apague ${lockPath}.`,
  });
  const release = () => {
    const cur = readLock(lockPath);
    if (cur.info?.token === token) { try { fs.unlinkSync(lockPath); } catch { /* já removido */ } } // só a própria trava
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      if (autoRelease) process.once('exit', release);
      return { ok: true, lockPath, token, release };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }

    const cur = readLock(lockPath);
    if (cur.missing) continue; // liberada entre as duas chamadas: tenta de novo
    if (cur.unreadable) return refusal(undefined, `Não foi possível ler a trava de instância (${cur.code}).`);

    let stale;
    if (cur.info) {
      const startedMs = Date.parse(cur.info.startedAt);
      const beforeBoot = Number.isFinite(startedMs) && startedMs < bootTime - BOOT_MARGIN_MS; // PID reaproveitado depois de reiniciar o sistema
      stale = !isAlive(cur.info.pid) || beforeBoot;
    } else stale = cur.ageMs > GARBAGE_STALE_MS;
    if (!stale) {
      return refusal(cur.info, cur.info
        ? `Já existe outra instância do servidor em execução (PID ${cur.info.pid}, iniciada em ${cur.info.startedAt}).`
        : 'A trava de instância está sendo criada por outro processo neste momento.');
    }

    // Troca de trava obsoleta: o rename só dá certo para UM processo; depois conferimos que movemos exatamente o que examinamos.
    const moved = `${lockPath}.stale-${pid}-${randomUUID().slice(0, 8)}`;
    try { fs.renameSync(lockPath, moved); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const after = readLock(moved);
    if (after.raw !== cur.raw) { // movemos a trava de uma instância que acabou de assumir: devolve e desiste
      try { fs.linkSync(moved, lockPath); fs.unlinkSync(moved); } catch { /* não deu para devolver: o arquivo movido fica para diagnóstico */ }
      return refusal(after.info, 'Outra instância assumiu a trava durante a inicialização.');
    }
    try { fs.unlinkSync(moved); } catch { /* resíduo inofensivo */ }
  }
  return refusal(undefined, 'Não foi possível adquirir a trava de instância (disputa persistente).');
}
