// Ajudante de teste (não é um *.test.mjs): sobe o servidor REAL (server/index.js) num processo próprio com a CLI FALSA como Executor e um Planner SIMULADO e determinístico,
// pela costura de teste em processo (globalThis.__ORCH_TEST_DEPS__). Sempre com ORCH_DATA_DIR temporário e PORT próprios, definidos por quem o inicia. Nenhum modelo é chamado.
// Planner simulado: com o histórico vazio propõe um plano de 3 etapas (s1 conclui, s2 fica "dormindo" até ser interrompida, s3 depende de s2); depois disso responde "blocked".
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// No Windows o libuv põe os filhos NÃO destacados num job object que os encerra junto com o pai: um SIGKILL neste processo mataria também a CLI e o cenário "execução órfã viva"
// nunca existiria. Por isso, SÓ neste auxiliar de teste, o spawn é destacado (como o filho sobrevive à queda do pai em POSIX); o código de produção não muda. Vem ANTES dos imports do servidor.
const realSpawn = cp.spawn; cp.spawn = (cmd, args, opts) => realSpawn(cmd, args, { ...opts, detached: true }); syncBuiltinESMExports();
const { createExecutor } = await import('../executor/index.js');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const step = (id, deps, mode) => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} ${id}`, acceptance: ['out.txt existe com o conteúdo conferido'], expectedFiles: ['out.txt'], dependsOn: deps });
globalThis.__ORCH_TEST_DEPS__ = {
  executor: createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }),
  planner: {
    id: 'fake-planner', busy: () => false, cancel: async () => {}, describeTier: () => null,
    async decide({ prompt }) {
      const first = /nenhuma rodada executada ainda/.test(prompt) && !/PLANO ATUAL/.test(prompt);
      const out = first ? { decision: 'plan', rationale: 'dividir em três etapas', steps: [step('s1', [], 'check'), step('s2', ['s1'], 'sleep'), step('s3', ['s2'], 'check')] }
        : { decision: 'blocked', rationale: 'a etapa interrompida precisa de decisão humana', blockedReason: 'decidir o que fazer com a etapa s2' };
      return { text: JSON.stringify(out) };
    },
  },
};
await import('../index.js');
