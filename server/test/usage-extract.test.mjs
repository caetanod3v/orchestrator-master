// Token Monitor, fase 1: extração e normalização das métricas de uso do stream-json (fixtures SINTÉTICAS na estrutura da captura real; sem textos, ids reais nem dados privados).
// Só a CLI FALSA (fake-cli.mjs) em diretório TEMPORÁRIO; nenhum banco, workspace real ou CLI real é tocado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractUsage, createUsageTracker, formatEvent, parseLine } from '../executor/stream.js';
import { createExecutor } from '../executor/index.js';
import { createClaudePlanner } from '../planner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const mkExec = () => createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
const run = (ex, mode) => ex.start({ missionId: 'm', taskId: 't', cwd, prompt: `MODE:${mode}\ntarefa`, onLine() {} }).done;

// Mesma estrutura da captura real (valores inventados).
const assistant = (id, u, extra = {}) => ({ type: 'assistant', message: { id, content: [], usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 15, cache_read_input_tokens: 14, cache_creation: { ephemeral_5m_input_tokens: 0 }, service_tier: 'standard', ...u } }, ...extra });
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.06, num_turns: 1,
  usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 15, cache_read_input_tokens: 14, iterations: [], fallback_credit: null },
  modelUsage: {
    'modelo-a': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 14, cacheCreationInputTokens: 15, webSearchRequests: 0, costUSD: 0.05, contextWindow: 1000000, maxOutputTokens: 128000, thinkingTokens: 0 },
    'modelo-b': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
  },
};

test('result: totais finais, custo e modelUsage por modelo; 0 reportado é preservado e campo ausente é null', () => {
  const u = extractUsage(RESULT);
  assert.equal(u.kind, 'final');
  assert.deepEqual(u.tokens, { input: 2, output: 4, cacheCreation: 15, cacheRead: 14 });
  assert.equal(u.costUsd, 0.06);
  assert.deepEqual(Object.keys(u.models), ['modelo-a', 'modelo-b']);
  assert.deepEqual(u.models['modelo-a'], { input: 2, output: 4, cacheCreation: 15, cacheRead: 14, thinking: 0, webSearchRequests: 0, costUsd: 0.05, contextWindow: 1000000, maxOutput: 128000 });
  assert.equal(u.models['modelo-b'].thinking, null, 'ausente != 0');
  assert.equal(u.models['modelo-b'].contextWindow, null);
  assert.equal(u.models['modelo-b'].cacheRead, 0, 'zero reportado continua 0');
  assert.deepEqual(u.tokensAllModels, { input: 3, output: 5, cacheCreation: 15, cacheRead: 14 }, 'soma dos modelos (inclui subagentes)');
});

test('campos opcionais ausentes: nada vira 0; eventos sem métricas e entradas inválidas dão null', () => {
  const minimo = extractUsage({ type: 'result', subtype: 'success', result: 'x' });
  assert.equal(minimo, null, 'result sem usage, modelUsage nem custo não traz métricas');
  const soCusto = extractUsage({ type: 'result', total_cost_usd: 0.0123 });
  assert.deepEqual(soCusto, { kind: 'final', tokens: null, tokensAllModels: null, costUsd: 0.0123, models: null });
  const parcial = extractUsage({ type: 'result', usage: { output_tokens: 0 } });
  assert.deepEqual(parcial.tokens, { input: null, output: 0, cacheCreation: null, cacheRead: null });
  const stringNum = extractUsage({ type: 'result', usage: { input_tokens: '5' }, total_cost_usd: 'x', modelUsage: { m: 'não é objeto' } });
  assert.deepEqual(stringNum.tokens, { input: null, output: null, cacheCreation: null, cacheRead: null }, 'string não é número');
  assert.equal(stringNum.costUsd, null); assert.equal(stringNum.models, null);
  for (const ev of [null, undefined, 'texto', 7, [], {}, { type: 'user' }, { type: 'assistant', message: { content: [] } }, { type: 'rate_limit_event' }]) assert.equal(extractUsage(ev), null);
});

test('rate_limit_event: status, utilization e resetsAt só quando presentes (indicador de aviso, não saldo)', () => {
  assert.deepEqual(extractUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792922400, uuid: 'u' } }), { kind: 'rate_limit', status: 'allowed', utilization: null, resetsAt: 1792922400 });
  assert.deepEqual(extractUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9, resetsAt: 5 } }), { kind: 'rate_limit', status: 'allowed_warning', utilization: 0.9, resetsAt: 5 });
  assert.equal(extractUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'TEXTO LIVRE <x>' } }).status, null, 'status fora do formato de enumeração é descartado');
  assert.equal(extractUsage({ type: 'rate_limit_event', rate_limit_info: { utilization: 0 } }).utilization, 0);
});

test('assistant: usage provisório com id (e marca de subagente); não vira total final', () => {
  const m = extractUsage(assistant('msg_1', {}));
  assert.deepEqual(m, { kind: 'message', messageId: 'msg_1', subagent: false, provisional: true, tokens: { input: 2, output: 4, cacheCreation: 15, cacheRead: 14 } });
  assert.equal(extractUsage(assistant('msg_2', {}, { parent_tool_use_id: 'toolu_x' })).subagent, true);
  assert.equal(extractUsage(assistant(undefined, {})).messageId, null);
});

test('tracker: deduplica por message.id, ignora subagentes, não soma o result com as mensagens', () => {
  const t = createUsageTracker();
  assert.deepEqual(t.snapshot(), { final: null, live: null, rateLimit: null }, 'sem eventos: tudo null (não 0)');
  t.add(extractUsage(assistant('msg_1', { input_tokens: 2, output_tokens: 1 })));
  t.add(extractUsage(assistant('msg_1', { input_tokens: 2, output_tokens: 1 })));                       // mesma resposta repetida (várias mensagens por turno)
  t.add(extractUsage(assistant('msg_2', { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0 })));
  t.add(extractUsage(assistant('msg_s', { input_tokens: 999 }, { parent_tool_use_id: 'toolu_x' })));    // subagente
  t.add(extractUsage(assistant(undefined, { input_tokens: 777 })));                                      // sem id: não dá para deduplicar
  const mid = t.snapshot();
  assert.equal(mid.final, null); assert.equal(mid.live.provisional, true); assert.equal(mid.live.messages, 2); assert.equal(mid.live.unidentified, 1);
  assert.deepEqual(mid.live.tokens, { input: 5, output: 2, cacheCreation: 15, cacheRead: 28 });
  t.add(extractUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
  t.add(extractUsage(RESULT));
  const end = t.snapshot();
  assert.deepEqual(end.final.tokens, { input: 2, output: 4, cacheCreation: 15, cacheRead: 14 }, 'o total final é o do result, intacto');
  assert.equal(end.final.kind, undefined); assert.equal(end.rateLimit.status, 'allowed');
  assert.equal(end.live.messages, 2, 'o live continua só com as mensagens distintas');
});

test('stream: formatEvent/parseLine expõem `usage` sem mudar as linhas de log nem o `result` existente', () => {
  const r = parseLine(JSON.stringify(RESULT));
  assert.equal(r.usage.kind, 'final'); assert.equal(r.result.costUsd, 0.06); assert.ok(r.lines[0].startsWith('[fim] success'));
  assert.equal('usage' in formatEvent({ type: 'result', subtype: 'success', result: 'ok' }), false, 'sem métricas: nenhuma chave nova');
  assert.equal('usage' in parseLine('texto solto'), false);
});

test('Executor: done.usage traz final/live/rateLimit (CLI falsa); sem métricas os campos são null', async () => {
  const r = await run(mkExec(), 'usage');
  assert.equal(r.status, 'completed');
  assert.equal(r.usage.live.messages, 2, 'msg_A repetida e subagente não contam');
  assert.deepEqual(r.usage.live.tokens, { input: 5, output: 2, cacheCreation: 100, cacheRead: 200 });
  assert.deepEqual(r.usage.final.tokens, { input: 5, output: 9, cacheCreation: 100, cacheRead: 200 });
  assert.equal(r.usage.final.costUsd, 0.05); assert.equal(r.usage.final.models['modelo-sintetico'].contextWindow, 1000000);
  assert.deepEqual(r.usage.rateLimit, { status: 'allowed', utilization: null, resetsAt: 1792922400 });
  assert.equal(r.result.costUsd, 0.05, 'o result existente continua igual');

  const ok = await run(mkExec(), 'ok');                                                                  // fluxo antigo: só custo/turnos
  assert.deepEqual(ok.usage, { final: { tokens: null, tokensAllModels: null, costUsd: 0.0123, models: null }, live: null, rateLimit: null });
  const fail = await run(mkExec(), 'fail');
  assert.equal(fail.status, 'failed'); assert.deepEqual(fail.usage, { final: null, live: null, rateLimit: null });
});

test('Planner: decide() inclui usage.metrics (aditivo) e mantém costUsd/turns', async () => {
  const planner = createClaudePlanner({ runner: mkExec() });
  const r = await planner.decide({ prompt: 'MODE:usage\nplano', cwd });
  assert.equal(r.text, 'Relatório de uso.');
  assert.equal(r.usage.costUsd, 0.05); assert.equal(r.usage.turns, 2);
  assert.deepEqual(r.usage.metrics.final.tokens, { input: 5, output: 9, cacheCreation: 100, cacheRead: 200 });
  const f = await planner.decide({ prompt: 'MODE:fail\nplano', cwd });
  assert.ok(f.error); assert.deepEqual(f.usage.metrics, { final: null, live: null, rateLimit: null });
});
