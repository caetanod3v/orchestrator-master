// Encerramento do servidor: ordem fixa FILHO -> FLUSH -> TRAVA. Encerra o processo filho do executor (no Windows os filhos NÃO morrem com o pai),
// grava o que o saveSoon() deixou pendente (as últimas linhas de log) e só então libera a trava de instância. `proc`/`exit` são injetáveis para os
// testes; o servidor usa o `process` real. Nada aqui protege contra encerramento forçado (taskkill /F, TerminateProcess) nem queda de energia.
// `children`: outros donos de processos filhos (Planner, verificador), cada um com killActiveSync(); todos são encerrados antes do flush e da liberação da trava.
export function installShutdown({ lock, executor, store, children = [], proc = process, exit = (code) => process.exit(code) }) {
  const stopChild = () => {
    for (const owner of [executor, ...children]) {
      try { owner?.killActiveSync?.(); } catch (e) { console.error('[shutdown] falha ao encerrar o processo filho:', e.message); } // um que falha não impede os demais
    }
  };
  const flushLogs = () => { try { store?.flush?.(); } catch (e) { console.error('[shutdown] falha ao gravar o que estava pendente:', e.message); } };
  // prepend: a trava (instance-lock) registra o próprio listener de exit antes; o filho (e o flush) têm que vir ANTES de ela ser liberada.
  // No evento "exit" tudo é síncrono. O flush só ocorre em saída com código 0: numa queda (exceção não tratada, código != 0) o estado em memória
  // pode estar no meio de uma mutação, e gravá-lo persistiria um estado parcialmente atualizado.
  proc.prependOnceListener('exit', (code) => { stopChild(); if (code === 0 || code === undefined) flushLogs(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    // sinal: o handler roda entre ticks, com o estado coerente
    proc.on(sig, () => { stopChild(); flushLogs(); lock?.release(); exit(sig === 'SIGINT' ? 130 : 143); });
  }
}
