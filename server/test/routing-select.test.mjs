// Incremento B: seleção inicial determinística do tier do Planner e máquina de estados do escalonamento. Puro: sem processos, banco ou modelo.
import test from 'node:test';
import assert from 'node:assert/strict';

const { pickInitialTier, extractSignals, createRouter, LITE_LIMITS } = await import('../routing.js');

const OBJ = 'No arquivo config.json, alterar o valor de timeoutMs de 1000 para 5000, sem modificar nenhuma outra chave. Critério de aceitação: a verificação obrigatória npm test passa.';
const OBJ_T2 = 'Adicionar a função slugify(texto) em lib/text.js (minúsculas, sem acentos, qualquer sequência de caracteres não alfanuméricos vira um único hífen, sem hífens nas pontas) e usá-la em makeUrl de app.js para gerar o slug do título. Critérios: npm test passa e a função trim continua exportada por lib/text.js.';
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const ctx = (over = {}) => ({
  mission: { objective: OBJ, pastCycles: [], ...(over.mission || {}) },
  cycle: { maxIterations: 3, rounds: [], humanNotes: [], rejections: [], ...(over.cycle || {}) },
  workspace: { verifications: [{ id: 'test', script: 'test', required: true }], ...(over.workspace || {}) },
  listing: over.listing ?? ['config.json', 'package.json'],
});
const withObj = (objective) => ctx({ mission: { objective } });
const pick = (c) => pickInitialTier(c);
const failedOf = (c) => pick(c).signals.failed;

test('positivos: enunciados curtos, com 1 a 2 arquivos nomeados, critério explícito e verificação obrigatória => lite', () => {
  for (const c of [ctx(), withObj(OBJ_T2), withObj('Em stats.js, corrigir median para listas de tamanho par. Teste: npm test passa.')]) {
    const p = pick(c);
    assert.equal(p.tier, 'lite', p.reason); assert.deepEqual(p.signals.failed, []); assert.match(p.reason, /^lite: /);
  }
});

test('só UM sinal nunca basta: verificação obrigatória sozinha, ou enunciado curto sozinho, não provam simplicidade', () => {
  // verificação obrigatória + enunciado vago e sem alvo nem critério
  const vago = pick(withObj('Melhorar a configuração do serviço para ficar mais robusta e organizada.'));
  assert.equal(vago.tier, 'standard'); assert.ok(vago.signals.failed.includes('sem_arquivo_nomeado') && vago.signals.failed.includes('sem_criterio_aceitacao'));
  // enunciado simples e curto, sem verificação obrigatória
  assert.deepEqual(failedOf(ctx({ workspace: { verifications: [] } })), ['sem_verificacao_obrigatoria']);
  assert.deepEqual(failedOf(ctx({ workspace: { verifications: [{ id: 'test', script: 'test', required: false }] } })), ['sem_verificacao_obrigatoria']);
  assert.deepEqual(failedOf(ctx({ workspace: { verifications: undefined } })), ['sem_verificacao_obrigatoria']);
  // enunciado curto, verificação obrigatória, mas arquivo e critério ausentes
  assert.equal(pick(withObj('Ajustar o tempo limite para cinco segundos.')).tier, 'standard');
});

test('negativos: cada marcador de risco, sozinho, força standard e aparece nos sinais', () => {
  const cases = [
    ['Refatorar config.json para o novo formato. Critério: npm test passa.', 'ambiguidade'],
    ['Migrar config.json e app.js para o novo esquema. Critério: npm test passa.', 'ambiguidade'],
    ['Reescrever stats.js do zero. Critério: npm test passa.', 'ambiguidade'],
    ['Atualizar todos os arquivos em config.json. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar limits.json conforme o contrato vigente. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar limits.json de acordo com a especificação. Critério: npm test passa.', 'ambiguidade'],
    ['Investigar por que median falha em stats.js. Critério: npm test passa.', 'ambiguidade'],
    ['Descobrir a causa do erro em stats.js. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar config.json para 5000? Critério: npm test passa.', 'ambiguidade'],
    ['Alterar config.json talvez para 5000. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar config.json, por exemplo o timeout. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar config.json se possível. Critério: npm test passa.', 'ambiguidade'],
    ['Alterar config.json, app.js e stats.js. Critério: npm test passa.', 'muitos_arquivos'],
  ];
  for (const [objective, code] of cases) { const p = pick(withObj(objective)); assert.equal(p.tier, 'standard', objective); assert.ok(p.signals.failed.includes(code), `${objective} -> ${p.signals.failed}`); assert.match(p.reason, /^standard: /); }
});

test('contradição SINTÁTICA (a mesma expressão com dois valores) => standard; valores iguais ou expressões diferentes não contradizem', () => {
  const c1 = pick(withObj('Em calc.js, add(2, 2) retorna 4. Também add(2,2) retorna 5. Critério: npm test passa.'));
  assert.equal(c1.tier, 'standard'); assert.ok(c1.signals.failed.includes('contradicao')); assert.deepEqual(c1.signals.contradictions, ['add(2,2)']);
  assert.equal(pick(withObj('Em calc.js, timeoutMs deve ser 5000. Depois timeoutMs deve ser 3000. Critério: npm test passa.')).tier, 'standard');
  assert.equal(pick(withObj('Em calc.js, add(1, 2) retorna 3 e add(2, 2) retorna 4. Critério: npm test passa.')).tier, 'lite', 'expressões diferentes');
  assert.equal(pick(withObj('Em calc.js, add(2, 2) retorna 4. add(2, 2) retorna 4. Critério: npm test passa.')).tier, 'lite', 'mesmo valor repetido');
});

test('histórico: ciclos anteriores, orientação humana, rodadas ou rejeições => standard', () => {
  assert.deepEqual(failedOf(ctx({ mission: { pastCycles: [{ id: 'c0' }] } })), ['historico']);
  assert.deepEqual(failedOf(ctx({ cycle: { humanNotes: [{ text: 'x' }] } })), ['historico']);
  assert.deepEqual(failedOf(ctx({ cycle: { rounds: [{ n: 1 }] } })), ['historico']);
  assert.deepEqual(failedOf(ctx({ cycle: { rejections: [{ problem: 'x' }] } })), ['historico']);
});

test('limítrofes (limites incluídos): 400 caracteres, 3 frases, 2 arquivos, listagem de 60 e 5 rodadas ainda são lite; um a mais não', () => {
  const pad = (n) => `${OBJ} ${'a'.repeat(n - OBJ.length - 1)}`;
  assert.equal(pad(400).length, 400); assert.equal(pick(withObj(pad(400))).tier, 'lite');
  assert.deepEqual(failedOf(withObj(pad(401))), ['objetivo_longo']);
  assert.equal(pick(withObj(`${OBJ} Mais uma frase.`)).signals.sentences, 3); assert.equal(pick(withObj(`${OBJ} Mais uma frase.`)).tier, 'lite');
  assert.deepEqual(failedOf(withObj(`${OBJ} Outra frase. Mais uma.`)), ['muitas_frases']);
  assert.equal(pick(withObj('Em config.json e app.js, trocar timeoutMs por 5000. Critério: npm test passa.')).tier, 'lite');
  assert.deepEqual(failedOf(withObj('Em config.json, app.js e stats.js, trocar timeoutMs por 5000. Critério: npm test passa.')), ['muitos_arquivos']);
  assert.equal(pick(ctx({ listing: Array.from({ length: LITE_LIMITS.listing }, (_, i) => `f${i}`) })).tier, 'lite');
  assert.deepEqual(failedOf(ctx({ listing: Array.from({ length: LITE_LIMITS.listing + 1 }, (_, i) => `f${i}`) })), ['workspace_grande']);
  assert.equal(pick(ctx({ cycle: { maxIterations: 5 } })).tier, 'lite');
  assert.deepEqual(failedOf(ctx({ cycle: { maxIterations: 6 } })), ['limite_rodadas']);
  assert.deepEqual(failedOf(withObj('Editar a.json. Teste')), ['objetivo_curto'], 'pouca informação');
});

test('ausência de dados => standard (nunca lite por falta de informação)', () => {
  for (const c of [undefined, {}, { mission: {}, cycle: {}, workspace: {} }, { mission: { objective: '' } }, { mission: { objective: 42 } }, ctx({ mission: { objective: '   ' } })]) {
    const p = pick(c); assert.equal(p.tier, 'standard'); assert.ok(p.signals.failed.length > 0);
  }
});

test('determinismo e pureza: mesma entrada, mesma saída; entradas congeladas não são alteradas; sinais completos e serializáveis', () => {
  const c = deepFreeze(ctx());
  const a = pick(c), b = pick(c);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  const s = extractSignals(c);
  for (const k of ['objectiveChars', 'sentences', 'files', 'fileCount', 'acceptance', 'ambiguity', 'contradictions', 'requiredVerification', 'history', 'listing', 'maxIterations']) assert.ok(k in s, k);
  assert.deepEqual(s.files, ['config.json']); assert.equal(s.requiredVerification, true); assert.equal(s.acceptance, true);
});

test('máquina de estados: lite inicial; rejeição escalona UMA vez para standard e standard permanece; estado sobrevive à serialização', () => {
  const r = createRouter(), cycle = ctx().cycle, base = ctx();
  const first = r.pick({ ...base, cycle });
  assert.equal(first.tier, 'lite'); assert.deepEqual(first.state, { tier: 'lite', escalated: false, initial: { tier: 'lite', reason: first.reason, signals: first.signals } });
  cycle.routing = first.state;
  const keep = r.pick({ ...base, cycle });
  assert.equal(keep.tier, 'lite'); assert.match(keep.reason, /^mantido lite/); assert.equal(keep.state, cycle.routing);
  const esc = r.pick({ ...base, cycle, retryAfterRejection: true, rejection: 'formato inválido: x'.repeat(30), call: 2 });
  assert.equal(esc.tier, 'standard'); assert.match(esc.reason, /^escalonado de lite para standard/); assert.equal(esc.signals.from, 'lite'); assert.ok(esc.signals.rejection.length <= 160);
  assert.deepEqual({ ...esc.state, initial: undefined }, { tier: 'standard', escalated: true, escalatedAtCall: 2, initial: undefined });
  cycle.routing = JSON.parse(JSON.stringify(esc.state)); // persistência/retomada
  for (const retry of [false, true]) { const p = r.pick({ ...base, cycle, retryAfterRejection: retry, call: 3 }); assert.equal(p.tier, 'standard'); assert.match(p.reason, /^mantido standard: já escalonado/); assert.equal(p.state.escalatedAtCall, 2); }
});

test('começar em standard: a rejeição NÃO escalona (não há para onde)', () => {
  const r = createRouter(), complex = ctx({ mission: { objective: 'Refatorar todos os módulos conforme a especificação. Critério: npm test passa.' } }), cycle = complex.cycle;
  const first = r.pick({ ...complex, cycle }); assert.equal(first.tier, 'standard'); cycle.routing = first.state;
  const retry = r.pick({ ...complex, cycle, retryAfterRejection: true, rejection: 'x', call: 2 });
  assert.equal(retry.tier, 'standard'); assert.equal(retry.state.escalated, false); assert.match(retry.reason, /já era a camada inicial/); assert.ok(!('escalatedAtCall' in retry.state));
});

test('a seleção inicial só acontece sem estado; um estado já existente (inclusive restaurado do banco) não é reavaliado', () => {
  const r = createRouter(), good = ctx(), cycle = good.cycle;
  cycle.routing = { tier: 'standard', escalated: false, initial: { tier: 'standard', reason: 'x', signals: {} } };
  assert.equal(r.pick({ ...good, cycle }).tier, 'standard', 'mesmo com um enunciado que seria lite');
  cycle.routing = { tier: 'valor-corrompido' };
  assert.equal(r.pick({ ...good, cycle }).tier, 'lite', 'estado inválido é descartado e a seleção inicial recomeça');
});
