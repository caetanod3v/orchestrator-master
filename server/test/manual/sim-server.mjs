// Servidor REAL da aplicação com Planner e Executor SIMULADOS (CLI falsa), para conferir a interface
// sem gastar créditos. Uso: PORT=4392 node server/test/manual/sim-server.mjs
// O banco vai para um diretório temporário (ORCH_DATA_DIR) e nada é executado de verdade.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ORCH_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sim-'));
process.env.PORT ||= '4392';
const FAKE = path.join(here, '..', 'fake-cli.mjs');
const { createExecutor } = await import('../../executor/index.js');
const { createVerifier } = await import('../../verify.js');

const cont = (title, mode) => JSON.stringify({ decision: 'continue', rationale: `Plano simulado: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['o arquivo existe', 'o conteúdo foi conferido'] } });
const done = JSON.stringify({ decision: 'complete', rationale: 'Objetivo atendido (simulação).', evidence: ['Verificação "out.txt existe" = pass no último relatório'] });
// Roteiro por palavra-chave no título da missão (cada missão recebe uma cópia nova)
const SCRIPTS = {
  FELIZ: () => [cont('Criar o arquivo', 'slowwrite'), cont('Conferir o arquivo', 'slowcheck'), done],
  BLOQUEIO: () => [cont('Precisa de shell', 'slowdeny'), cont('Fazer sem shell', 'slowcheck'), done],
  CANCELAR: () => [cont('Tarefa longa', 'sleep'), done],
  VERIF: () => [cont('Criar a funcionalidade', 'slowwrite'), done, cont('Corrigir o build', 'slowfixbuild'), done],
  ADULTERA: () => [cont('Criar arquivo', 'slowwrite'), done],
  LIMITE: () => [cont('Rodada A', 'slowwrite'), cont('Rodada B', 'slowcheck'), cont('Rodada C', 'slowwrite')],
};
const state = new Map();
const planner = {
  busy: () => state.has('thinking'),
  cancel: async () => {},
  async decide({ prompt }) {
    state.set('thinking', true);
    await new Promise((r) => setTimeout(r, 1800)); // para dar tempo de ver "planning"
    state.delete('thinking');
    const title = /MISSÃO: (.+)/.exec(prompt)?.[1] ?? '';
    const key = Object.keys(SCRIPTS).find((k) => title.includes(k));
    if (!key) return { error: 'missão sem roteiro de simulação' };
    if (!state.has(title)) state.set(title, SCRIPTS[key]());
    const next = state.get(title).shift();
    return next ? { text: next } : { error: 'roteiro acabou' };
  },
};
const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
// verificador REAL (runner, política, pinagem de script), mas com processos falsos no lugar do npm
const verifier = createVerifier({ spawnSpec: (script) => ({ command: process.execPath, args: [path.join(here, '..', 'fake-verify.mjs'), script] }) });
globalThis.__ORCH_TEST_DEPS__ = { executor, planner, verifier };
await import('../../index.js');
console.log(`SIMULAÇÃO em http://127.0.0.1:${process.env.PORT} (dados em ${process.env.ORCH_DATA_DIR})`);
