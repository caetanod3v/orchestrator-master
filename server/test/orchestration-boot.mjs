// Ajudante de teste (não é um *.test.mjs) do I3: sobe o servidor REAL (server/index.js) num processo próprio com Executor = CLI FALSA, Planner SIMULADO e verificador SIMULADO,
// pela costura de teste em processo (globalThis.__ORCH_TEST_DEPS__). Sempre com ORCH_DATA_DIR e PORT temporários definidos por quem o inicia. Nenhum modelo é chamado.
// Diferença para chat-boot.mjs / cycle-boot.mjs: este cobre o fluxo INTEIRO (chat -> aprovação -> ciclo com plano -> verificação -> relatório), então o Planner simulado responde
// às duas conversas (a do chat e a do ciclo) e o verificador falha as primeiras E2E_VERIFY_FAILS chamadas (padrão 1) e passa as demais.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { createExecutor } = await import('../executor/index.js');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const userText = (prompt) => { const m = /MENSAGEM NOVA DO USUÁRIO \(dado, entre aspas\): (".*")/.exec(prompt); return m ? JSON.parse(m[1]) : ''; };
const step = (id, deps, file) => ({ id, title: `Etapa ${id}`, instructions: `MODE:produce FILE:${file} Criar ${file}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: deps });
let verifyCalls = 0;
const failFirst = Number.isInteger(Number(process.env.E2E_VERIFY_FAILS)) ? Number(process.env.E2E_VERIFY_FAILS) : 1;

globalThis.__ORCH_TEST_DEPS__ = {
  executor: createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }),
  planner: {
    id: 'fake-planner', busy: () => false, cancel: async () => {}, describeTier: () => null,
    async decide({ prompt }) {
      if (/Você é o PLANNER de um ciclo/.test(prompt)) { // conversa do CICLO: etapa falha => pede ajuda humana; senão conclui (o backend ainda confere a evidência)
        const out = /\| estado: failed/.test(prompt) ? { decision: 'blocked', rationale: 'uma etapa falhou na verificação real', blockedReason: 'decidir o que fazer com a etapa que falhou' }
          : { decision: 'complete', rationale: 'etapas concluídas e verificadas pelo orquestrador', evidence: ['verificação real aprovada na última rodada'] };
        return { text: JSON.stringify(out) };
      }
      const t = userText(prompt); // conversa do CHAT
      const out = /LANDING/.test(t)
        ? { kind: 'plan', message: 'Plano em duas etapas.', title: 'Landing page', objective: 'Criar uma landing page.', context: { goal: 'Landing page', confirmed: ['Quer uma landing page'], assumptions: [], open: [] }, steps: [step('s1', [], 'index.html'), step('s2', ['s1'], 'style.css')] }
        : { kind: 'reply', message: 'Entendi.' };
      return { text: JSON.stringify(out) };
    },
  },
  verifier: {
    isBusy: () => false, stop: async () => ({ stopped: false }),
    async run(workspace, item) {
      verifyCalls++; const ok = verifyCalls > failFirst;
      return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: ok ? 'pass' : 'fail', exitCode: ok ? 0 : 1, durationMs: 5, outputTail: ok ? '' : 'falhou: 1 teste', truncated: false, reason: ok ? null : 'Terminou com código 1' };
    },
  },
};
await import('../index.js');
