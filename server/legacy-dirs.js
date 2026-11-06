// Pastas de estado do MODO DEV (fora do repositório) mudaram de nome junto com o produto: `ai-dev-orchestrator` -> `forge`.
// Para não perder o histórico de conversas e os loadouts já gerados, a pasta antiga é COPIADA para a nova no boot.
// Regras: nunca move nem apaga a original; NUNCA sobrescreve nada que já exista no destino; links (symlink/junction) não são copiados;
// copia para uma pasta de preparo e só então renomeia (uma queda no meio não deixa o destino pela metade); resto de tentativa
// interrompida é guardado com outro nome. Se uma cópia falhar (antivírus, arquivo preso) e o servidor já tiver criado a pasta nova,
// o próximo boot COMPLETA a cópia sem sobrescrever: o marcador `<destino>.migrado` só é gravado depois de uma cópia concluída. Nunca lança.
import fs from 'node:fs';
import path from 'node:path';

/** @returns {{status:'none'|'present'|'migrated'|'error', skippedLinks?:string[], error?:string}} */
export function migrateLegacyDir(oldDir, newDir, { now = () => new Date(), copy = fs.cpSync } = {}) {
  try {
    if (!fs.existsSync(oldDir)) return { status: 'none' };
    const marker = `${newDir}.migrado`;
    if (fs.existsSync(marker)) return { status: 'present' };
    const src = fs.lstatSync(oldDir).isSymbolicLink() ? fs.realpathSync(oldDir) : oldDir; // pasta antiga movida e ligada por link: copia o conteúdo real
    const skippedLinks = [];
    const noLinks = (s) => { if (s === src) return true; try { if (fs.lstatSync(s).isSymbolicLink()) { skippedLinks.push(path.relative(src, s)); return false; } } catch { return false; } return true; };
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    if (fs.existsSync(newDir)) {
      // destino criado antes de a cópia terminar (ou por uma cópia que falhou): completa só o que falta, sem sobrescrever nada
      copy(src, newDir, { recursive: true, force: false, errorOnExist: false, filter: noLinks });
    } else {
      const staging = `${newDir}.migrating`;
      if (fs.existsSync(staging)) fs.renameSync(staging, `${staging}-sobra-${now().toISOString().replace(/[:.]/g, '-')}`);
      copy(src, staging, { recursive: true, filter: noLinks });
      fs.renameSync(staging, newDir);
    }
    try { fs.writeFileSync(marker, JSON.stringify({ from: oldDir, at: now().toISOString(), skippedLinks })); } catch { /* sem marcador, o próximo boot só repete uma cópia sem sobrescrita */ }
    return { status: 'migrated', skippedLinks };
  } catch (e) {
    return { status: 'error', error: e && e.message ? e.message : String(e) };
  }
}
