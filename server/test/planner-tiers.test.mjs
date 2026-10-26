// Incremento A: argumentos EFETIVAMENTE recebidos pela CLI (CLI falsa que devolve o argv), camadas, roteamento desligado, Executor inalterado,
// lock, cancelamento e encerramento. Nenhum modelo é chamado; nenhum banco é usado.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ARGV = path.join(HERE, 'fake-argv-cli.mjs'); // devolve os argumentos recebidos
const FAKE_CLI = path.join(HERE, 'fake-cli.mjs');        // comportamento conforme "MODE:x" no prompt (sleep = fica vivo até ser interrompido)
const { PLANNER_ARGS, plannerArgs, createClaudePlanner } = await import('../planner.js');
const { createExecutor, CLAUDE_ARGS } = await import('../executor/index.js');

const viaArgv = { command: process.execPath, prefixArgs: [FAKE_ARGV] };
const viaFake = { command: process.execPath, prefixArgs: [FAKE_CLI] };
const received = async (planner, tier) => { const r = await planner.decide({ prompt: 'p', cwd: process.cwd(), ...(tier === undefined ? {} : { tier }) }); assert.equal(r.error, undefined, r.error); return JSON.parse(r.text); };
const LITE = plannerArgs({ model: 'claude-haiku-5-5', effort: 'low' });
const CFG = { model: 'claude-sonnet-5-5', effort: 'medium' };

test('roteamento DESLIGADO: a CLI recebe os argumentos de sempre, com ou sem configuração, e `tier` é ignorado', async () => {
  for (const cfg of [{}, CFG]) {
    const expected = plannerArgs(cfg);
    const p = createClaudePlanner({ ...cfg, routing: 'off', runnerOptions: viaArgv });
    for (const tier of [undefined, 'lite', 'standard', 'inexistente']) assert.deepEqual(await received(p, tier), expected, `tier=${tier} cfg=${JSON.stringify(cfg)}`);
    assert.deepEqual(p.args, expected); assert.equal(p.routing, 'off'); assert.equal(p.describeTier('lite'), null);
  }
  assert.deepEqual(await received(createClaudePlanner({ runnerOptions: viaArgv }), 'lite'), PLANNER_ARGS, 'sem nenhuma opção: exatamente PLANNER_ARGS');
});

test('roteamento LIGADO sem camada: argumentos de sempre (nada muda sem uma escolha explícita)', async () => {
  assert.deepEqual(await received(createClaudePlanner({ routing: 'on', runnerOptions: viaArgv })), PLANNER_ARGS);
  assert.deepEqual(await received(createClaudePlanner({ ...CFG, routing: 'on', runnerOptions: viaArgv })), plannerArgs(CFG));
});

test('camada lite: --model claude-haiku-5-5 --effort low antes de --tools "", o resto idêntico', async () => {
  const got = await received(createClaudePlanner({ routing: 'on', runnerOptions: viaArgv }), 'lite');
  assert.deepEqual(got, LITE);
  const i = got.indexOf('--model'); assert.deepEqual(got.slice(i, i + 4), ['--model', 'claude-haiku-5-5', '--effort', 'low']);
  assert.deepEqual(got.slice(-2), ['--tools', ''], 'o Planner continua SEM ferramentas');
  assert.deepEqual(got.filter((x) => !['--model', 'claude-haiku-5-5', '--effort', 'low'].includes(x)), PLANNER_ARGS);
  assert.deepEqual(await received(createClaudePlanner({ ...CFG, routing: 'on', runnerOptions: viaArgv }), 'lite'), LITE, 'lite ignora a configuração do ambiente (é fixa)');
});

test('camada standard: respeita a configuração existente (ORCH_PLANNER_MODEL/EFFORT) ou o padrão da CLI', async () => {
  assert.deepEqual(await received(createClaudePlanner({ routing: 'on', runnerOptions: viaArgv }), 'standard'), PLANNER_ARGS);
  assert.deepEqual(await received(createClaudePlanner({ ...CFG, routing: 'on', runnerOptions: viaArgv }), 'standard'), plannerArgs(CFG));
  assert.deepEqual(await received(createClaudePlanner({ effort: 'low', routing: 'on', runnerOptions: viaArgv }), 'standard'), plannerArgs({ effort: 'low' }));
});

test('a camada vale só para a chamada (não "gruda"): alternar lite, standard e sem camada', async () => {
  const p = createClaudePlanner({ ...CFG, routing: 'on', runnerOptions: viaArgv });
  assert.deepEqual(await received(p, 'lite'), LITE);
  assert.deepEqual(await received(p, 'standard'), plannerArgs(CFG));
  assert.deepEqual(await received(p, undefined), plannerArgs(CFG));
  assert.deepEqual(await received(p, 'lite'), LITE);
});

test('camada desconhecida: erro claro, nenhum processo é iniciado e o Planner continua livre', async () => {
  const p = createClaudePlanner({ routing: 'on', runnerOptions: viaArgv });
  for (const tier of ['deep', 'LITE', '', 'constructor', '__proto__', null]) {
    const r = await p.decide({ prompt: 'p', cwd: process.cwd(), tier });
    assert.match(r.error, /Camada do Planner desconhecida/, String(tier)); assert.equal(r.text, undefined); assert.equal(p.busy(), false);
  }
  assert.deepEqual(await received(p, 'lite'), LITE, 'continua funcionando depois');
});

test('describeTier: modelo/esforço SOLICITADOS (null = padrão da CLI); só com o roteamento ligado', () => {
  const on = createClaudePlanner({ ...CFG, routing: 'on' }), bare = createClaudePlanner({ routing: 'on' });
  assert.deepEqual(on.describeTier('lite'), { tier: 'lite', model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(on.describeTier('standard'), { tier: 'standard', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(bare.describeTier('standard'), { tier: 'standard', model: null, effort: null });
  assert.equal(on.describeTier('deep'), null); assert.equal(createClaudePlanner({ routing: 'off' }).describeTier('standard'), null);
});

test('o Executor continua inalterado: argumentos fixos, sem --model/--effort, e `args` por chamada só quando pedido', async () => {
  assert.deepEqual(CLAUDE_ARGS, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user', '--tools', 'Read,Edit,Write,Glob,Grep']);
  createClaudePlanner({ ...CFG, routing: 'on' }); // criar um Planner configurado não mexe nos argumentos do Executor
  assert.equal(CLAUDE_ARGS.includes('--model') || CLAUDE_ARGS.includes('--effort'), false);
  const configured = ['--so-para-teste', 'a'];
  const ex = createExecutor({ ...viaArgv, args: configured });
  const run = async (extra = {}) => { const h = ex.start({ missionId: 'm', taskId: 't', cwd: process.cwd(), prompt: 'p', onLine: () => {}, ...extra }); const r = await h.done; assert.equal(r.status, 'completed'); return JSON.parse(r.result.text); };
  assert.deepEqual(await run(), configured, 'sem `args`: os do runner');
  assert.deepEqual(await run({ args: ['--outro', 'b'] }), ['--outro', 'b'], '`args` vale nesta chamada');
  assert.deepEqual(await run(), configured, '...e não é guardado para a próxima');
  for (const bad of ['--x', [1], [null], {}, 0]) { assert.throws(() => ex.start({ missionId: 'm', taskId: 't', cwd: process.cwd(), prompt: 'p', onLine: () => {}, args: bad }), TypeError, JSON.stringify(bad)); assert.equal(ex.isBusy(), false, 'um `args` inválido não toma o lock'); }
});

test('args vazio ou com byte nulo é rejeitado ANTES do lock: o runner continua livre e as chamadas seguintes funcionam', async () => {
  const configured = ['--so-para-teste', 'a'];
  const ex = createExecutor({ ...viaArgv, args: configured });
  const call = (extra) => ex.start({ missionId: 'm', taskId: 't', cwd: process.cwd(), prompt: 'p', onLine: () => {}, ...extra });
  for (const bad of [[], ['a\u0000b'], ['\u0000'], ['ok', 'x\u0000'], ['ok', 'a\u0000b', 'c']]) {
    assert.throws(() => call({ args: bad }), TypeError, JSON.stringify(bad));
    assert.equal(ex.isBusy(), false, `runner livre depois de rejeitar ${JSON.stringify(bad)}`);
    assert.equal(ex.current(), null);
  }
  // o runner segue utilizável, com `args` válidos (inclusive texto vazio, como em "--tools ''") e sem `args`
  const run = async (extra) => { const r = await call(extra).done; assert.equal(r.status, 'completed'); return JSON.parse(r.result.text); };
  assert.deepEqual(await run({ args: ['--tools', ''] }), ['--tools', '']);
  assert.deepEqual(await run({}), configured);
  // pelo Planner (roteamento ligado): a camada continua gerando argumentos válidos e o runner volta a ficar livre
  const p = createClaudePlanner({ routing: 'on', runnerOptions: viaArgv });
  assert.deepEqual(await received(p, 'lite'), LITE); assert.equal(p.busy(), false);
});

test('lock: uma 2ª chamada com o Planner ocupado é recusada, em qualquer camada, sem iniciar outro processo', async () => {
  const p = createClaudePlanner({ routing: 'on', runnerOptions: viaFake });
  const first = p.decide({ prompt: 'MODE:sleep', cwd: process.cwd(), tier: 'lite' });
  for (let i = 0; i < 100 && !p.busy(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.busy(), true);
  for (const tier of ['lite', 'standard', undefined]) { const r = await p.decide({ prompt: 'MODE:ok', cwd: process.cwd(), ...(tier ? { tier } : {}) }); assert.match(r.error, /Outra execução está em andamento/, String(tier)); }
  assert.equal(p.busy(), true, 'a recusa não liberou nem derrubou a chamada em andamento');
  await p.cancel(); await first;
  assert.equal(p.busy(), false);
});

test('cancelamento: cancel() encerra a chamada com tier, resolve como interrompida e libera o Planner para uma nova chamada', async () => {
  const p = createClaudePlanner({ routing: 'on', runnerOptions: viaFake });
  const d = p.decide({ prompt: 'MODE:sleep', cwd: process.cwd(), tier: 'lite' });
  for (let i = 0; i < 100 && !p.busy(); i++) await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now(); const stopped = await p.cancel(); const r = await d;
  assert.equal(stopped.stopped, true, stopped.detail); assert.equal(r.interrupted, true); assert.ok(r.error); assert.ok(r.usage && 'metrics' in r.usage, 'o consumo parcial continua reportado');
  assert.equal(p.busy(), false); assert.ok(Date.now() - t0 < 8000, 'encerrou antes do limite de espera do stop()');
  const again = await p.decide({ prompt: 'MODE:ok', cwd: process.cwd(), tier: 'standard' });
  assert.equal(again.error, undefined); assert.match(again.text, /Relatório final do teste/);
  assert.equal((await p.cancel()).stopped, false, 'sem chamada ativa não há o que cancelar');
});

test('encerramento (killActiveSync) do runner continua valendo para uma chamada com camada', async () => {
  const runner = createExecutor({ ...viaFake, args: PLANNER_ARGS });
  const p = createClaudePlanner({ routing: 'on', runner });
  const d = p.decide({ prompt: 'MODE:sleep', cwd: process.cwd(), tier: 'lite' });
  for (let i = 0; i < 100 && !runner.isBusy(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isBusy(), true);
  runner.killActiveSync(); // o que o servidor faz ao sair
  const r = await Promise.race([d, new Promise((res) => setTimeout(() => res('preso'), 8000))]);
  assert.notEqual(r, 'preso', 'o processo filho foi encerrado e a chamada terminou');
  assert.equal(runner.isBusy(), false);
});
