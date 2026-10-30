// M8: evidência independente (evidence.js) e critérios de aceitação (cycle-schema.js). Só diretórios TEMPORÁRIOS; nenhum processo, banco ou modelo.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const { categoryOf, safeRelPath, snapshotWorkspace, hashesOf, diffHashes, checkExpected, buildEvidence, criterionProblem, evidencePathProblem, MAX_SENSITIVE } = await import('../evidence.js');
const { validatePlanSteps, validateDecision } = await import('../cycle-schema.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evidence-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const ws = (files = {}) => { const d = path.join(tmp, `w${++n}`); fs.mkdirSync(d); for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); } return d; };
const put = (d, p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };

test('categoryOf: testes e configuração de validação são vigiados; código comum não', () => {
  for (const p of ['tests/a.js', 'test/a.js', 'src/__tests__/x.js', 'src/a.test.js', 'src/a.spec.ts', 'test_a.py', 'pkg/conftest.py', 'a_test.go', 'cypress/e2e/a.cy.js']) assert.equal(categoryOf(p), 'test', p);
  for (const p of ['package.json', 'jest.config.js', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.build.json', '.eslintrc.json', 'eslint.config.js', '.mocharc.yml', 'pytest.ini', 'pyproject.toml', 'Makefile', '.github/workflows/ci.yml', 'sub/package.json']) assert.equal(categoryOf(p), 'config', p);
  for (const p of ['src/index.js', 'index.html', 'style.css', 'README.md', 'latest.js', 'contest.txt']) assert.equal(categoryOf(p), null, p);
});

test('safeRelPath: aceita caminhos relativos; rejeita absoluto, "..", unidade, coringa, vazio e .git', () => {
  assert.equal(safeRelPath('src/a.js'), 'src/a.js'); assert.equal(safeRelPath('./a/./b.txt'), 'a/b.txt'); assert.equal(safeRelPath('a\\b.txt'), 'a/b.txt');
  for (const p of ['', '  ', '/etc/passwd', 'C:\\x', '../x', 'a/../../x', 'a/*.js', 'a?.js', '.git/config', 7, null, 'x'.repeat(300), 'a\u0000b']) assert.equal(safeRelPath(p), null, String(p));
});

test('snapshot + diff: criado, modificado e apagado são detectados por CONTEÚDO (inclusive arquivo que já "estava sujo"); código comum, node_modules e links não entram', () => {
  const d = ws({ 'tests/a.test.js': 'v1', 'jest.config.js': 'c1', 'src/app.js': 'x', 'node_modules/p/x.test.js': 'ignorado', 'package.json': '{"scripts":{"test":"node scripts/run-checks.js"}}', 'scripts/run-checks.js': 'r1' });
  const link = path.join(d, 'tests', 'link.test.js'); try { fs.symlinkSync(path.join(tmp, 'fora.txt'), link); } catch { /* sem permissão para link: o resto do teste vale igual */ }
  const cmds = ['node scripts/run-checks.js'], a = snapshotWorkspace(d, { commands: cmds });
  assert.equal(a.complete, true); assert.deepEqual(Object.keys(a.files).sort(), ['jest.config.js', 'package.json', 'scripts/run-checks.js', 'tests/a.test.js'], 'o arquivo referenciado pelo script aprovado entra; src/app.js e node_modules não');
  assert.equal(a.files['scripts/run-checks.js'].cat, 'referenced');
  put(d, 'tests/a.test.js', 'v2'); put(d, 'tests/new.test.js', 'n'); fs.rmSync(path.join(d, 'jest.config.js')); put(d, 'scripts/run-checks.js', 'r2'); put(d, 'src/app.js', 'mudou');
  const b = snapshotWorkspace(d, { commands: cmds });
  assert.deepEqual(diffHashes(hashesOf(a), hashesOf(b)).map((x) => `${x.path}:${x.change}`), ['jest.config.js:deleted', 'scripts/run-checks.js:modified', 'tests/a.test.js:modified', 'tests/new.test.js:created']);
  assert.deepEqual(diffHashes(hashesOf(b), hashesOf(snapshotWorkspace(d, { commands: cmds }))), [], 'sem mudança, sem diferença');
  put(d, 'tests/a.test.js', 'v2'); assert.deepEqual(diffHashes(hashesOf(b), hashesOf(snapshotWorkspace(d, { commands: cmds }))), [], 'reescrever o MESMO conteúdo não é mudança');
});

test('snapshot: limite de arquivos vigiados excedido => incompleto (a integridade nunca é afirmada sem ver tudo); diretório ilegível => incompleto', () => {
  const d = ws(); for (let i = 0; i <= MAX_SENSITIVE; i++) put(d, `tests/t${i}.test.js`, String(i));
  assert.equal(snapshotWorkspace(d).complete, false);
  assert.equal(snapshotWorkspace(path.join(tmp, 'não-existe')).complete, false);
});

test('arquivos esperados: precisam existir, não vazios, regulares e CRIADOS/ALTERADOS pela etapa; um arquivo que já existia e não mudou não comprova nada', () => {
  const d = ws({ 'old.txt': 'antigo', 'empty.txt': '' });
  const before = snapshotWorkspace(d, { expected: ['new.txt', 'old.txt', 'empty.txt', 'missing.txt', 'dir'] });
  put(d, 'new.txt', 'novo'); put(d, 'empty.txt', ''); fs.mkdirSync(path.join(d, 'dir'));
  const after = snapshotWorkspace(d, { expected: ['new.txt', 'old.txt', 'empty.txt', 'missing.txt', 'dir'] });
  const r = Object.fromEntries(checkExpected(['new.txt', 'old.txt', 'empty.txt', 'missing.txt', 'dir'], before, after).map((x) => [x.path, x]));
  assert.equal(r['new.txt'].ok, true); assert.equal(r['new.txt'].changed, true);
  assert.equal(r['old.txt'].ok, false); assert.match(r['old.txt'].reason, /já existia e não foi criado nem alterado/);
  assert.equal(r['empty.txt'].ok, false); assert.match(r['empty.txt'].reason, /vazio/);
  assert.equal(r['missing.txt'].ok, false); assert.match(r['missing.txt'].reason, /não existe/);
  assert.equal(r.dir.ok, false); assert.match(r.dir.reason, /não é um arquivo regular/);
  put(d, 'old.txt', 'agora diferente'); const after2 = snapshotWorkspace(d, { expected: ['old.txt'] });
  assert.equal(checkExpected(['old.txt'], before, after2)[0].ok, true, 'alterado depois do instantâneo anterior');
  assert.equal(checkExpected(['new.txt'], null, after, [{ path: 'new.txt', changed: true }])[0].ok, true, 're-verificação usa o resultado anterior'); assert.equal(checkExpected(['old.txt'], null, after2)[0].changed, null, 'sem referência, "alterado" é desconhecido e só a existência é conferida');
  if (process.platform !== 'win32') { fs.symlinkSync(path.join(tmp, 'x'), path.join(d, 'ln.txt')); assert.equal(checkExpected(['ln.txt'], null, snapshotWorkspace(d, { expected: ['ln.txt'] }))[0].ok, false, 'link não vale'); }
});

test('buildEvidence: o relato do Executor sozinho NUNCA verifica; verificação real aprovada, arquivos esperados e integridade limpa verificam; falha e inconclusivo trazem motivos objetivos', () => {
  const rep = (over = {}) => ({ status: 'success', checks: [{ name: 'x', result: 'pass' }], verifications: [], ...over });
  const okFiles = [{ path: 'a.txt', ok: true }], clean = { status: 'clean', pending: [] };
  const claimOnly = buildEvidence({ report: rep(), verification: 'none', expectedResults: null, integrity: clean });
  assert.equal(claimOnly.level, 'inconclusive'); assert.equal(claimOnly.basis, 'executor_claim_only'); assert.match(claimOnly.reasons.join(), /só há o relato do Executor, que não é prova/); assert.match(claimOnly.executorClaim.note, /não é prova/);
  const real = buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass', required: true }] }), verification: 'passed', integrity: clean });
  assert.equal(real.level, 'verified'); assert.equal(real.basis, 'real_verification'); assert.deepEqual(real.reasons, []);
  assert.equal(buildEvidence({ report: rep(), verification: 'none', expectedResults: okFiles, integrity: clean }).basis, 'expected_files');
  assert.equal(buildEvidence({ report: rep(), verification: 'none', expectedResults: okFiles, integrity: clean }).level, 'verified');
  assert.equal(buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass' }] }), verification: 'passed', expectedResults: okFiles, integrity: clean }).basis, 'real_verification+expected_files');
  const fail = buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'fail' }] }), verification: 'failed', integrity: clean });
  assert.equal(fail.level, 'failed'); assert.match(fail.reasons[0], /verificação real reprovada: test=fail/); assert.equal(fail.executorClaim.status, 'success', 'o relato continua registrado, separado do veredito');
  assert.equal(buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass' }] }), verification: 'passed', expectedResults: [{ path: 'a.txt', ok: false, reason: 'o arquivo não existe' }], integrity: clean }).level, 'failed');
  const skipped = buildEvidence({ report: rep({ verificationsSkipped: 'o verificador não está disponível' }), verification: 'skipped', configured: 1, integrity: clean });
  assert.equal(skipped.level, 'inconclusive'); assert.match(skipped.reasons[0], /não concluída: o verificador não está disponível/);
  const flagged = buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass' }] }), verification: 'passed', integrity: { status: 'flagged', pending: [{ path: 'tests/x.test.js', change: 'created' }] } });
  assert.equal(flagged.level, 'inconclusive'); assert.match(flagged.reasons[0], /tests\/x\.test\.js criado/); assert.match(flagged.reasons[0], /não prova a conclusão/);
  assert.equal(buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass' }] }), verification: 'passed', integrity: { status: 'reviewed' } }).level, 'verified', 'revisada por uma pessoa: vale');
  assert.equal(buildEvidence({ report: rep({ verifications: [{ script: 'test', status: 'pass' }] }), verification: 'passed', integrity: { status: 'unknown', reason: 'sem referência' } }).level, 'inconclusive');
  assert.equal(buildEvidence({ report: rep({ checks: [{ name: 'x', result: 'fail' }] }), verification: 'none', expectedResults: okFiles, integrity: clean }).level, 'failed', 'o Executor admitir uma falha própria não é ignorado');
  assert.equal(buildEvidence({ report: rep({ status: 'failed' }), verification: 'skipped', integrity: clean }).level, 'failed');
});

test('critérios de aceitação: vazios, curtos e genéricos são rejeitados; critérios concretos passam; o título repetido e duplicatas também', () => {
  for (const c of ['', '   ', 'ok', 'tudo ok', 'funciona', 'Funciona corretamente', 'O código funciona corretamente', 'Tarefa concluída', 'etapa concluída com sucesso', 'sem erros', 'conferir', 'Está pronto']) assert.ok(criterionProblem(c), `deveria rejeitar: "${c}"`);
  for (const c of ['index.html existe', 'A página mostra o nome da barbearia', 'O botão leva ao WhatsApp (11) 98765-4321', '`npm test` passa', 'style.css define a cor azul', 'src/app.js exporta a função main']) assert.equal(criterionProblem(c), null, c);
  const st = (acceptance, title = 'T') => ({ id: 'a', title, instructions: 'i', acceptance, dependsOn: [] });
  assert.equal(validatePlanSteps([st(['index.html existe'])], { strict: true }).ok, true);
  assert.match(validatePlanSteps([st(['index.html existe', 'tudo ok'])], { strict: true }).error, /acceptance: o critério "tudo ok" é genérico/);
  assert.match(validatePlanSteps([st(['index.html existe', 'Index.html existe'])], { strict: true }).error, /repete o critério/);
  assert.match(validatePlanSteps([st(['Criar a página inicial'], 'Criar a página inicial')], { strict: true }).error, /só repete o título/);
  assert.equal(validatePlanSteps([st(['conferir'])]).ok, true, 'sem strict (plano já gravado) a estrutura basta: planos antigos não são invalidados');
  assert.match(validateDecision(JSON.stringify({ decision: 'plan', rationale: 'r', steps: [st(['funciona'])] }), { plan: true }).error, /genérico/);
  assert.equal(validateDecision(JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 't', instructions: 'i', acceptance: ['conferir'] } })).ok, true, 'tarefa avulsa: contrato de sempre');
});

test('expectedFiles: lista de 1 a 8 caminhos relativos e seguros (normalizados e sem repetição); aceito em etapas e em tarefas avulsas', () => {
  const st = (expectedFiles) => ({ id: 'a', title: 'T', instructions: 'i', acceptance: ['index.html existe'], dependsOn: [], expectedFiles });
  assert.deepEqual(validatePlanSteps([st(['./src/a.js', 'src\\a.js', 'b.css'])]).steps[0].expectedFiles, ['src/a.js', 'b.css']);
  for (const bad of [[], 'a.js', ['../x'], ['/etc/x'], ['a/*.js'], Array.from({ length: 9 }, (_, i) => `f${i}.txt`), [7]]) assert.equal(validatePlanSteps([st(bad)]).ok, false, JSON.stringify(bad).slice(0, 50));
  assert.equal(validatePlanSteps([{ id: 'a', title: 'T', instructions: 'i', acceptance: ['index.html existe'], dependsOn: [] }]).steps[0].expectedFiles, undefined, 'opcional');
  const t = validateDecision(JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 't', instructions: 'i', acceptance: ['a'], expectedFiles: ['x.txt'] } })); assert.deepEqual(t.value.task.expectedFiles, ['x.txt']);
  assert.match(validateDecision(JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 't', instructions: 'i', acceptance: ['a'], expectedFiles: ['../x'] } })).error, /expectedFiles/);
});

test('caminho de evidência: sem verificações reais no workspace, toda etapa precisa de expectedFiles; com verificações, não', () => {
  const steps = [{ id: 'a', expectedFiles: ['a.txt'] }, { id: 'b' }];
  assert.match(evidencePathProblem(steps, { verifications: [] }), /"b".*não declaram "expectedFiles"/); assert.match(evidencePathProblem(steps, {}), /nada independente do Executor/);
  assert.equal(evidencePathProblem(steps, { verifications: [{ script: 'test' }] }), null); assert.equal(evidencePathProblem([{ id: 'a', expectedFiles: ['a.txt'] }], { verifications: [] }), null);
});
