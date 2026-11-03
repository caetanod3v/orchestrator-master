// Marco E (E4): interface da preparação controlada. Lógica pura (client/src/worktree-view.js) testada com planos e estados REAIS do servidor; a renderização do WorktreeView
// usa react-dom/server sobre o componente empacotado pelo esbuild do cliente. Sem rede externa, sem npm, sem processos de instalação: só servidores locais efêmeros em loopback.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..', '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prep4-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const W = await import('../worktrees.js');
const V = await import('../../client/src/worktree-view.js');
const { api } = await import('../../client/src/api.js');
const { default: express } = await import('express');
const requireClient = createRequire(path.join(ROOT, 'client', 'package.json'));
const esbuild = requireClient('esbuild');
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const MANIFEST = { name: 'x', version: '1.0.0', private: true, dependencies: { 'dep-a': '^1.0.0' }, devDependencies: { 'dep-b': '2.0.0' } };
const LOCK = { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: MANIFEST.dependencies, devDependencies: MANIFEST.devDependencies },
  'node_modules/dep-a': { version: '1.2.0', resolved: 'https://registry.npmjs.org/dep-a/-/dep-a-1.2.0.tgz' }, 'node_modules/dep-b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep-b/-/dep-b-2.0.0.tgz', dev: true } } };
const realPlan = () => { const dir = path.join(tmp, `d${Math.random().toString(16).slice(2)}`); fs.mkdirSync(dir); wr(dir, 'package.json', JSON.stringify(MANIFEST)); wr(dir, 'package-lock.json', JSON.stringify(LOCK)); wr(dir, '.npmrc', 'registry=https://registry.exemplo.com/npm/\n');
  const r = W.planPrepare({ id: 'wt_0000000a', path: dir, branch: 'orch/wt_0000000a', baseCommit: 'a'.repeat(40) }); assert.equal(r.ok, true, r.error); return JSON.parse(JSON.stringify({ plan: r.plan, digest: r.digest, notes: r.notes })); };
const wt = (over = {}) => ({ id: 'wt_0000000a', missionId: 'm', cycleId: 'cy', state: 'finished', branch: 'orch/wt_0000000a', baseBranch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), path: '/x', op: null, current: null, rounds: [], attempts: [], history: [], diagnostic: null, prepare: null, ...over });
const rowOf = (over) => V.worktreeView([wt(over)])[0];

test('E4 — prepareView: cada estado do SERVIDOR com seu rótulo; interrupted nunca parece ready; inconclusivo bloqueia; op=prepare é "em execução"', () => {
  assert.equal(rowOf().prepare.state, null);
  const st = (prepare, extra) => rowOf({ prepare, ...extra }).prepare;
  assert.deepEqual([st({ state: 'ready' }).state, st({ state: 'ready' }).value], ['ready', 'completed']);
  assert.deepEqual([st({ state: 'failed', reason: 'npm ci terminou com código 3', exitCode: 3 }).value, st({ state: 'failed', exitCode: 3 }).exitCode], ['failed', 3]);
  const i = st({ state: 'interrupted', reason: 'o servidor foi reiniciado' }); assert.deepEqual([i.state, i.value], ['interrupted', 'interrupted']); assert.match(i.label, /não é um ambiente pronto/i); assert.notEqual(i.value, 'completed');
  const r = st({ state: 'running' }, { op: { kind: 'prepare', at: 'T' } }); assert.deepEqual([r.state, r.running], ['running', true]);
  const c = st({ state: 'running' }, { op: { kind: 'prepare', at: 'T' }, diagnostic: { code: 'preparation_inconclusive', reason: 'sem registro', at: 'T' } }); assert.deepEqual([c.state, c.inconclusive, c.running, c.value], ['inconclusive', true, false, 'blocked']); assert.match(c.inconclusiveText, /continua bloqueado/); assert.equal(c.diagnostic, 'sem registro');
  assert.equal(st({ state: 'planned' }).state, null, 'planned/approved não vêm do servidor: só fases da tela'); assert.equal(st({ state: 'zzz' }).state, null);
});

test('E4 — "Preparar ambiente" só é oferecido a ambiente parado, sem dúvida pendente, que precisa de preparação ou falhou/foi interrompido; nunca durante operação ativa ou inconclusivo', () => {
  const need = 'wt_0000000a';
  assert.equal(V.canOfferPrepare(rowOf(), need), true); assert.equal(V.canOfferPrepare(rowOf(), null), false, 'sem verificação recusada por ambiente não se oferece');
  assert.equal(V.canOfferPrepare(rowOf({ prepare: { state: 'failed' } }), null), true); assert.equal(V.canOfferPrepare(rowOf({ prepare: { state: 'interrupted' } }), null), true); assert.equal(V.canOfferPrepare(rowOf({ prepare: { state: 'ready' } }), null), false);
  assert.equal(V.canOfferPrepare(rowOf({ op: { kind: 'prepare', at: 'T' }, state: 'ready' }), need), false, 'em execução'); assert.equal(V.canOfferPrepare(rowOf({ op: { kind: 'cleanup', at: 'T' } }), need), false);
  assert.equal(V.canOfferPrepare(rowOf({ diagnostic: { code: 'preparation_inconclusive', reason: 'x' }, prepare: { state: 'running' }, op: { kind: 'prepare', at: 'T' } }), need), false, 'inconclusivo');
  for (const state of ['inconsistent', 'integrated', 'in_use', 'failed', 'creating']) assert.equal(V.canOfferPrepare(rowOf({ state }), need), false, state);
  assert.equal(V.canOfferPrepare(null, need), false);
});

test('E4 — needsEnvironment usa o CÓDIGO gravado na verificação recusada (nunca o texto) e só do worktree do ciclo', () => {
  const mk = (v, worktreeId = 'wt_0000000a') => ({ cycle: { worktreeId, rounds: [{ report: { verifications: [v] } }] } });
  assert.equal(V.needsEnvironment(mk({ status: 'blocked', code: 'dependencies_not_prepared', reason: 'x' })), 'wt_0000000a'); assert.equal(V.needsEnvironment(mk({ status: 'blocked', code: 'dependencies_incomplete' })), 'wt_0000000a');
  assert.equal(V.needsEnvironment(mk({ status: 'blocked', reason: 'Ambiente do worktree não preparado: texto igual, sem código' })), null); assert.equal(V.needsEnvironment(mk({ status: 'pass', code: 'dependencies_not_prepared' })), null);
  assert.equal(V.needsEnvironment(mk({ status: 'blocked', code: 'package_invalid' })), null); assert.equal(V.needsEnvironment(mk({ status: 'blocked', code: 'dependencies_not_prepared' }, null)), null, 'ciclo sem worktree');
  assert.equal(V.needsEnvironment({}), null); assert.equal(V.needsEnvironment(null), null);
});

test('E4 — planView: comando, dependências, registry, hosts, avisos e digest do plano REAL do servidor; resposta inválida => null', () => {
  const resp = realPlan(), p = V.planView(resp);
  assert.equal(p.digest, resp.digest); assert.equal(p.command, 'npm ci --ignore-scripts --no-audit --no-fund'); assert.deepEqual(p.dependencies.map((d) => [d.name, d.section]), [['dep-a', 'prod'], ['dep-b', 'dev']]); assert.equal(p.dependencyCount, 2);
  assert.deepEqual(p.registry, { url: 'https://registry.exemplo.com/npm/', source: 'do .npmrc do projeto' }); assert.deepEqual(p.hosts, ['registry.npmjs.org']); assert.ok(p.warnings.some((x) => /rede/.test(x)) && p.warnings.some((x) => /ignore-scripts/.test(x)) && p.warnings.some((x) => /Registry diferente/.test(x)));
  assert.equal(p.lockfile.version, 3); assert.match(p.lockfile.sha256, /^[0-9a-f]{64}$/); assert.equal(p.npmrc, true);
  for (const bad of [null, {}, { plan: {} }, { plan: resp.plan, digest: 'curto' }, { plan: resp.plan }, { digest: resp.digest }]) assert.equal(V.planView(bad), null);
});

test('E4 — prepareErrorView: plano rejeitado exige NOVO plano; bloqueios e falha de comunicação são distinguidos; a mensagem do servidor nunca é escondida', () => {
  const s = V.prepareErrorView(Object.assign(new Error('A aprovação não corresponde ao plano atual.'), { status: 409, code: 'digest_mismatch' })); assert.equal(s.stale, true); assert.match(s.text, /desatualizado.*NOVO plano.*antes de aprovar/); assert.match(s.text, /não corresponde ao plano atual/);
  const b = V.prepareErrorView(Object.assign(new Error('Já há uma preparação em andamento'), { status: 409, code: 'preparation_in_progress' })); assert.deepEqual([b.blocked, b.stale], [true, false]); assert.match(b.text, /em andamento.*preparation_in_progress.*Nada foi executado/);
  const n = V.prepareErrorView(new Error('Failed to fetch')); assert.equal(n.network, true); assert.match(n.text, /não é possível afirmar.*Consultar estado/i); assert.doesNotMatch(n.text, /Nada foi executado/);
  assert.equal(V.prepareErrorView(null).message, 'erro desconhecido');
});

test('E4 — api.js: o erro de uma rota carrega status HTTP e o código do servidor (aditivo; a mensagem continua a mesma)', async () => {
  const app = express(); app.use(express.json());
  app.post('/e', (req, res) => res.status(409).json({ error: 'recusado', code: 'digest_mismatch' })); app.post('/n', (req, res) => res.status(500).json({ error: 'quebrou' })); app.post('/ok', (req, res) => res.json({ ok: 1 }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(() => api.post(`${base}/e`, {}), (e) => e.message === 'recusado' && e.status === 409 && e.code === 'digest_mismatch');
    await assert.rejects(() => api.post(`${base}/n`, {}), (e) => e.message === 'quebrou' && e.status === 500 && e.code === undefined); assert.deepEqual(await api.post(`${base}/ok`, {}), { ok: 1 });
  } finally { srv.close(); }
});

// ----- renderização do componente (react-dom/server sobre o WorktreePanel empacotado) -----
// um único bundle CJS com o componente, o React e o react-dom/server (uma só cópia do React: os hooks funcionam)
const entry = path.join(tmp, 'entry.jsx'), bundle = path.join(tmp, 'wtpanel.bundle.cjs'), COMP = path.join(ROOT, 'client', 'src', 'components', 'WorktreePanel.jsx').replace(/\\/g, '/');
fs.writeFileSync(entry, `import React from 'react';\nexport { React };\nexport { renderToStaticMarkup } from 'react-dom/server';\nexport { WorktreeView } from '${COMP}';\n`);
esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, loader: { '.jsx': 'jsx' }, logLevel: 'silent', nodePaths: [path.join(ROOT, 'client', 'node_modules')] });
const { WorktreeView, renderToStaticMarkup, React } = createRequire(import.meta.url)(bundle);
const html = (rows, props = {}) => renderToStaticMarkup(React.createElement(WorktreeView, { rows, ...props }));
const has = (h, id) => h.includes(`data-testid="${id}"`);

test('E4 — render: com verificação recusada por ambiente, o botão "Preparar ambiente" aparece; sem ela, não; e nunca durante execução ou inconclusivo', () => {
  const ready = V.worktreeView([wt()]); let h = html(ready, { needsPrepareId: 'wt_0000000a' });
  assert.match(h, />Preparar ambiente</); assert.ok(has(h, 'worktree-needs-env')); assert.match(h, /RECUSADA/); assert.doesNotMatch(html(ready, { needsPrepareId: null }), />Preparar ambiente</);
  const run = V.worktreeView([wt({ state: 'ready', op: { kind: 'prepare', at: 'T' }, prepare: { state: 'running' } })]); h = html(run, { needsPrepareId: 'wt_0000000a' }); assert.doesNotMatch(h, />Preparar ambiente</); assert.match(h, /npm ci em execução/); assert.match(h, />Consultar estado</);
  const inc = V.worktreeView([wt({ state: 'ready', op: { kind: 'prepare', at: 'T' }, prepare: { state: 'running' }, diagnostic: { code: 'preparation_inconclusive', reason: 'sem registro do processo' } })]);
  h = html(inc, { needsPrepareId: 'wt_0000000a' }); assert.doesNotMatch(h, />Preparar ambiente</); assert.ok(has(h, 'worktree-prepare-inconclusive')); assert.match(h, /permanece bloqueado/i); assert.match(h, /nenhuma nova preparação pode ser iniciada/); assert.match(h, /sem registro do processo/); assert.match(h, />Revalidar</);
  const intr = V.worktreeView([wt({ state: 'ready', prepare: { state: 'interrupted', reason: 'o servidor foi reiniciado durante a preparação' } })]); h = html(intr); assert.match(h, /INTERROMPIDA: não é um ambiente pronto/); assert.doesNotMatch(h, /Ambiente preparado e conferido/); assert.match(h, />Preparar ambiente</, 'nova tentativa explícita');
  for (const [state, text] of [['ready', /Ambiente preparado e conferido pelo sistema/], ['failed', /A preparação falhou/]]) assert.match(html(V.worktreeView([wt({ prepare: { state, exitCode: 1 } })])), text);
});

test('E4 — render: o plano mostra comando, dependências, registry, hosts, avisos e digest; aprovar exige a caixa de autorização e o botão começa desabilitado', () => {
  const resp = realPlan(), plan = V.planView(resp), rows = V.worktreeView([wt()]);
  const h = html(rows, { needsPrepareId: 'wt_0000000a', prep: { wt_0000000a: { phase: 'planned', plan } } });
  assert.ok(has(h, 'worktree-prepare-plan')); assert.match(h, /nada foi executado ainda/); assert.match(h, /npm ci --ignore-scripts --no-audit --no-fund/); assert.match(h, /dep-a/); assert.match(h, /dep-b/); assert.match(h, /registry\.exemplo\.com/); assert.match(h, /registry\.npmjs\.org/);
  assert.ok(has(h, 'worktree-prepare-warnings')); assert.match(h, /Usa a rede/); assert.ok(h.includes(resp.digest)); assert.match(h, /Autorizo executar o comando acima/);
  const approve = /<button[^>]*disabled[^>]*>Aprovar e iniciar a preparação<\/button>/; assert.match(h, approve, 'sem marcar a autorização o botão fica desabilitado'); assert.match(h, /type="checkbox"(?![^>]*disabled)/); assert.doesNotMatch(h, />Preparar ambiente</, 'com o plano na tela não se pede outro');
  const appr = html(rows, { prep: { wt_0000000a: { phase: 'approved', plan } } }); assert.match(appr, /Aprovado: aguardando o servidor/); assert.match(appr, /type="checkbox"[^>]*disabled/);
});

test('E4 — render: erro de plano rejeitado é mostrado (com a mensagem do servidor) e NÃO deixa plano na tela; falha de comunicação orienta a consultar o estado', () => {
  const rows = V.worktreeView([wt()]), stale = V.prepareErrorView(Object.assign(new Error('A aprovação não corresponde ao plano atual.'), { status: 409, code: 'digest_mismatch' }));
  let h = html(rows, { needsPrepareId: 'wt_0000000a', prep: { wt_0000000a: { phase: 'error', error: stale } } });
  assert.ok(has(h, 'worktree-prepare-error')); assert.match(h, /data-stale="1"/); assert.match(h, /não corresponde ao plano atual/); assert.match(h, /NOVO plano/); assert.ok(!has(h, 'worktree-prepare-plan')); assert.match(h, />Preparar ambiente</, 'permite gerar um novo plano; nunca aprova sozinho'); assert.doesNotMatch(h, />Aprovar e iniciar/);
  h = html(rows, { prep: { wt_0000000a: { phase: 'error', error: V.prepareErrorView(new Error('Failed to fetch')) } } }); assert.match(h, /não é possível afirmar se a preparação foi iniciada/i); assert.match(h, />Consultar estado</);
  assert.match(html(rows, { prep: { wt_0000000a: { phase: 'planning' } } }), /Gerando o plano \(nada será executado\)/);
});

test('E4 — render: preservados os botões e o comportamento existentes (checar, snapshot, limpar, integrar, revalidar) e nenhuma seção nova sem preparação', () => {
  const h = html(V.worktreeView([wt()])); assert.match(h, />Checar integração</); assert.match(h, />Limpar worktree</); assert.doesNotMatch(h, /Preparar ambiente|Consultar estado|worktree-prepare/);
  const inc = html(V.worktreeView([wt({ state: 'inconsistent' })])); assert.match(inc, />Revalidar</); assert.equal(html([]), '');
});
