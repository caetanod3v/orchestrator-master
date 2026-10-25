// Encerramento do servidor sem deixar para trás o processo filho do executor (no Windows os filhos NÃO morrem com o pai) e liberando a
// trava de instância. `proc`/`exit` são injetáveis para os testes; o servidor usa o `process` real.
export function installShutdown({ lock, executor, proc = process, exit = (code) => process.exit(code) }) {
  const stopChild = () => { try { executor?.killActiveSync?.(); } catch (e) { console.error('[shutdown] falha ao encerrar o processo filho:', e.message); } };
  // prepend: a trava (instance-lock) registra o próprio listener de exit antes; o filho tem que ser encerrado ANTES de ela ser liberada.
  proc.prependOnceListener('exit', stopChild); // cobre saída normal, process.exit e queda por exceção (o evento "exit" é síncrono)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    proc.on(sig, () => { stopChild(); lock?.release(); exit(sig === 'SIGINT' ? 130 : 143); });
  }
}
