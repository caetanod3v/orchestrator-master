// Marco C — worktrees isolados, conflitos, integração controlada, limpeza e recuperação. Repositórios Git REAIS, mas TEMPORÁRIOS (nada fora do diretório temporário do teste);
// banco temporário; nenhum modelo, nenhuma missão real, nenhum acesso à rede (os repositórios não têm remoto).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const { default: express } = await import('express');
const store = await import('../store.js');
const W = await import('../worktrees.js');
const db = store.load(); db.missions = []; db.workspaces = []; store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- helpers ----------
const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const GX = (cwd, ...args) => { try { return G(cwd, ...args); } catch (e) { return `ERRO:${e.status}`; } };
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const LINES = Array.from({ length: 12 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n';
let n = 0;
/** Repositório novo com 1 commit, workspace cadastrado, missão com ciclo "concluído e verificado" e um gerenciador com raiz própria. */
function world({ cycle = { status: 'completed', assurance: 'verified' } } = {}) {
  const id = ++n, repo = path.join(tmp, `repo${id}`); fs.mkdirSync(repo);
  G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false'); wr(repo, 'a.txt', LINES); wr(repo, 'b.txt', 'b\n'); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
  const ws = { id: `ws${id}`, name: `ws${id}`, path: repo, verifications: [] }, m = { id: `m${id}`, workspaceId: ws.id, tasks: [], cycle: { id: `cyc${id}`, rounds: [], ...cycle } };
  db.workspaces.push(ws); db.missions.push(m);
  const mgr = W.createWorktreeManager({ db, root: path.join(tmp, `wts${id}`) });
  return { repo, ws, m, mgr, head: () => G(repo, 'rev-parse', 'HEAD'), refs: () => G(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), status: () => G(repo, 'status', '--porcelain', '-uall') };
}
/** Cria o worktree, liga ao ciclo e simula uma rodada que gravou `files` com a evidência `level`. */
async function ready(w, files = { 'a.txt': LINES.replace('linha 2', 'linha 2 (worktree)') }, level = 'verified') {
  const r = await w.mgr.create({ mission: w.m, workspace: w.ws }); assert.equal(r.ok, true, r.error); const rec = r.record;
  w.mgr.link(rec.id, w.m.cycle.id); w.m.cycle.worktreeId = rec.id;
  w.mgr.markInUse(rec.id, { round: 1, taskId: 't1' }); for (const [f, t] of Object.entries(files)) wr(rec.path, f, t);
  await w.mgr.noteRound(rec.id, { round: 1, status: 'succeeded', level });
  return rec;
}
const mergeable = async (w, id) => { const r = await w.mgr.check(id); assert.equal(r.ok, true); return r.attempt; };

test('configuração: ambiente > configurações > padrão DESLIGADO; ambiente inválido lança', () => {
  assert.deepEqual(W.resolveWorktreeIsolation({ env: {}, settings: {} }), { enabled: false, source: 'default' });
  assert.deepEqual(W.resolveWorktreeIsolation({ env: {}, settings: { worktreeIsolation: true } }), { enabled: true, source: 'settings' });
  assert.deepEqual(W.resolveWorktreeIsolation({ env: { ORCH_WORKTREE_ISOLATION: 'off' }, settings: { worktreeIsolation: true } }), { enabled: false, source: 'env' });
  assert.deepEqual(W.resolveWorktreeIsolation({ env: { ORCH_WORKTREE_ISOLATION: 'ON' }, settings: {} }), { enabled: true, source: 'env' });
  assert.deepEqual(W.resolveWorktreeIsolation({ env: {}, settings: { worktreeIsolation: 'sim' } }), { enabled: false, source: 'default' });
  assert.throws(() => W.resolveWorktreeIsolation({ env: { ORCH_WORKTREE_ISOLATION: 'talvez' } }), /ORCH_WORKTREE_ISOLATION/);
});

test('criação e ISOLAMENTO: o worktree tem branch e pasta próprias, registra tudo e a branch/workspace principais não mudam', async () => {
  const w = world(), headBefore = w.head(), refsBefore = w.refs();
  const r = await w.mgr.create({ mission: w.m, workspace: w.ws }); assert.equal(r.ok, true, r.error); const rec = r.record;
  assert.match(rec.id, /^wt_[0-9a-f]{8}$/); assert.equal(rec.branch, `orch/${rec.id}`); assert.equal(rec.state, 'ready'); assert.equal(rec.baseBranch, 'main'); assert.equal(rec.baseCommit, headBefore); assert.equal(rec.missionId, w.m.id); assert.equal(rec.op, null);
  assert.ok(path.resolve(rec.path).startsWith(path.join(tmp, `wts${n}`) + path.sep), 'dentro da raiz de worktrees'); assert.ok(!rec.path.startsWith(w.repo + path.sep), 'fora do workspace principal');
  assert.equal(G(rec.path, 'rev-parse', '--abbrev-ref', 'HEAD'), rec.branch); assert.equal(G(rec.path, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(w.head(), headBefore); assert.equal(G(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(w.status(), '');
  // escrever no worktree NÃO aparece no workspace principal
  wr(rec.path, 'novo.txt', 'só aqui\n'); wr(rec.path, 'a.txt', 'mudou\n');
  assert.equal(w.status(), '', 'o workspace principal segue limpo'); assert.equal(fs.existsSync(path.join(w.repo, 'novo.txt')), false); assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), LINES); assert.equal(w.head(), headBefore);
  assert.deepEqual(w.refs().split('\n').filter((l) => !l.includes(`refs/heads/${rec.branch}`)), refsBefore.split('\n'), 'nenhuma outra ref mudou');
  assert.equal(rec.history[0].event, 'create_started'); assert.ok(rec.history.some((h) => h.event === 'created'));
  const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).worktrees.find((x) => x.id === rec.id); assert.equal(disk.state, 'ready', 'registro persistido'); assert.equal(disk.branch, rec.branch);
});

test('validação do repositório ANTES de qualquer comando: não-repo, subpasta, HEAD destacado, sem commit, worktree vinculado => nada é criado', async () => {
  const w = world(), cases = [];
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain); cases.push([{ ...w.ws, path: plain }, /não é um repositório Git|raiz do repositório/]); // (se o temporário estiver dentro de outro repositório, a recusa é a da "raiz")
  fs.mkdirSync(path.join(w.repo, 'sub')); cases.push([{ ...w.ws, path: path.join(w.repo, 'sub') }, /raiz do repositório/]);
  cases.push([{ ...w.ws, path: path.join(tmp, 'nao-existe') }, /não existe/]);
  const empty = path.join(tmp, 'vazio'); fs.mkdirSync(empty); G(empty, 'init', '-q', '-b', 'main'); cases.push([{ ...w.ws, path: empty }, /nenhum commit/]);
  const det = world(); G(det.repo, 'checkout', '-q', '--detach'); cases.push([det.ws, /HEAD destacado/]);
  const linked = path.join(tmp, 'vinculado'); G(w.repo, 'worktree', 'add', '-q', '-b', 'outra', linked); cases.push([{ ...w.ws, path: linked }, /worktree vinculado/]);
  const before = db.worktrees.length;
  for (const [ws, re] of cases) { const r = await w.mgr.create({ mission: w.m, workspace: ws }); assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, re); }
  assert.equal(db.worktrees.length, before, 'nenhum registro criado'); assert.equal(GX(w.repo, 'branch', '--list', 'orch/*'), '');
  assert.equal((await w.mgr.create({ mission: null, workspace: w.ws })).status, 400);
});

test('DUAS execuções concorrentes em worktrees diferentes: isoladas entre si e do principal; ambas integram em sequência (a 2ª com alteração concorrente)', async () => {
  const w = world();
  const [a, b] = await Promise.all([w.mgr.create({ mission: w.m, workspace: w.ws }), w.mgr.create({ mission: w.m, workspace: w.ws })]);
  assert.equal(a.ok && b.ok, true); const A = a.record, B = b.record; assert.notEqual(A.id, B.id); assert.notEqual(A.path, B.path); assert.notEqual(A.branch, B.branch);
  // "execuções" em paralelo: cada processo escreve só no seu cwd
  await Promise.all([A, B].map(async (rec, i) => { for (let k = 0; k < 20; k++) { wr(rec.path, `f${i}.txt`, `${i}-${k}\n`); await new Promise((r) => setTimeout(r, 2)); } }));
  assert.equal(fs.existsSync(path.join(A.path, 'f1.txt')), false); assert.equal(fs.existsSync(path.join(B.path, 'f0.txt')), false); assert.equal(w.status(), '');
  // o ciclo (um só por missão, aqui compartilhado) liga ao primeiro; para o teste cada ambiente tem a sua evidência
  for (const rec of [A, B]) { w.mgr.link(rec.id, w.m.cycle.id); w.mgr.markInUse(rec.id, { round: 1, taskId: `t${rec.id}` }); await w.mgr.noteRound(rec.id, { round: 1, status: 'succeeded', level: 'verified' }); }
  for (const rec of [A, B]) assert.equal((await w.mgr.snapshot(rec.id, { message: 'trabalho' })).ok, true);
  // a evidência é do CONTEÚDO: o snapshot não a invalida (mesma árvore)
  const ca = await mergeable(w, A.id); assert.equal(ca.result, 'mergeable', JSON.stringify(ca.problems)); assert.equal(ca.concurrent, false); assert.equal(ca.fastForward, true);
  const ia = await w.mgr.integrate(A.id, { digest: ca.digest }); assert.equal(ia.ok, true, ia.error); assert.equal(w.head(), G(A.path, 'rev-parse', 'HEAD'), 'fast-forward');
  const cb = await mergeable(w, B.id); assert.equal(cb.result, 'mergeable', JSON.stringify(cb.problems)); assert.equal(cb.concurrent, true, 'a branch de destino andou desde a base'); assert.equal(cb.fastForward, false); assert.deepEqual(cb.overlap, []);
  const ib = await w.mgr.integrate(B.id, { digest: cb.digest }); assert.equal(ib.ok, true, ib.error);
  assert.equal(G(w.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'commit de integração com 2 pais'); assert.equal(fs.existsSync(path.join(w.repo, 'f0.txt')) && fs.existsSync(path.join(w.repo, 'f1.txt')), true); assert.equal(w.status(), '');
});

test('CONFLITO real: detectado sem modificar a branch de destino (nem refs, índice ou working tree); alteração concorrente SEM sobreposição e SOBREPOSTA mas combinável são distinguidas', async () => {
  const w = world(), rec = await ready(w, { 'a.txt': LINES.replace('linha 2', 'linha 2 do worktree') });
  assert.equal((await w.mgr.snapshot(rec.id)).ok, true);
  // alteração concorrente na MESMA linha => conflito real
  wr(w.repo, 'a.txt', LINES.replace('linha 2', 'linha 2 do principal')); G(w.repo, 'commit', '-q', '-am', 'concorrente');
  const head = w.head(), refs = w.refs(), idx = fs.readFileSync(path.join(w.repo, '.git', 'index'));
  const c = await mergeable(w, rec.id);
  assert.deepEqual([c.result, c.concurrent, c.conflicts, c.digest], ['conflict', true, ['a.txt'], null]); assert.deepEqual(c.overlap, ['a.txt']);
  assert.equal(w.head(), head); assert.equal(w.refs(), refs); assert.equal(w.status(), ''); assert.equal(fs.existsSync(path.join(w.repo, '.git', 'MERGE_HEAD')), false); assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), LINES.replace('linha 2', 'linha 2 do principal'));
  assert.ok(fs.readFileSync(path.join(w.repo, '.git', 'index')).equals(idx), 'índice intacto');
  const refused = await w.mgr.integrate(rec.id, { digest: 'a'.repeat(32) }); assert.equal(refused.ok, false); assert.match(refused.error, /conflitos \(a\.txt\)/); assert.equal(w.head(), head);
  // outra alteração concorrente, em OUTRA região do MESMO arquivo: sobreposta, mas combinável
  const w2 = world(), r2 = await ready(w2, { 'a.txt': LINES.replace('linha 2', 'linha 2 do worktree') }); await w2.mgr.snapshot(r2.id);
  wr(w2.repo, 'a.txt', LINES.replace('linha 11', 'linha 11 do principal')); G(w2.repo, 'commit', '-q', '-am', 'outra região');
  const c2 = await mergeable(w2, r2.id); assert.deepEqual([c2.result, c2.concurrent, c2.overlap, c2.conflicts], ['mergeable', true, ['a.txt'], []]);
  // concorrente em arquivo diferente: sem sobreposição
  const w3 = world(), r3 = await ready(w3); await w3.mgr.snapshot(r3.id); wr(w3.repo, 'b.txt', 'b mudou\n'); G(w3.repo, 'commit', '-q', '-am', 'outro arquivo');
  const c3 = await mergeable(w3, r3.id); assert.deepEqual([c3.result, c3.concurrent, c3.overlap], ['mergeable', true, []]);
});

test('AUTORIZAÇÃO: sem digest, digest errado ou velho => recusa registrada e a branch de destino intacta; com o digest da checagem integra e registra tudo', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); const head = w.head();
  assert.equal((await w.mgr.integrate(rec.id, {})).status, 400); assert.equal((await w.mgr.integrate(rec.id, { digest: 'xyz' })).status, 400); assert.equal((await w.mgr.integrate('wt_00000000', { digest: 'a'.repeat(32) })).status, 404);
  const noCheck = await w.mgr.integrate(rec.id, { digest: 'b'.repeat(32) }); assert.equal(noCheck.status, 409); assert.match(noCheck.error, /não corresponde ao estado atual/); assert.equal(w.head(), head);
  const c = await mergeable(w, rec.id); assert.equal(c.result, 'mergeable'); assert.match(c.digest, /^[0-9a-f]{32}$/);
  // o destino anda depois da checagem: o digest antigo deixa de valer
  wr(w.repo, 'b.txt', 'novo\n'); G(w.repo, 'commit', '-q', '-am', 'depois da checagem'); const head2 = w.head();
  const stale = await w.mgr.integrate(rec.id, { digest: c.digest }); assert.equal(stale.status, 409); assert.match(stale.error, /Refaça a checagem/); assert.equal(w.head(), head2);
  const att = rec.attempts.at(-1); assert.deepEqual([att.kind, att.outcome], ['integrate', 'refused']);
  const c2 = await mergeable(w, rec.id); assert.equal(c2.concurrent, true); const ok = await w.mgr.integrate(rec.id, { digest: c2.digest, authorizedBy: 'user' }); assert.equal(ok.ok, true, ok.error);
  assert.deepEqual([rec.state, ok.attempt.outcome, ok.attempt.authorizedBy], ['integrated', 'integrated', 'user']); assert.equal(rec.integratedCommit, w.head()); assert.equal(rec.op, null); assert.ok(rec.history.some((h) => h.event === 'integration_started') && rec.history.some((h) => h.event === 'integrated'));
  assert.equal(G(w.repo, 'remote'), '', 'nunca há push: o repositório nem tem remoto');
  const again = await w.mgr.integrate(rec.id, { digest: c2.digest }); assert.equal(again.status, 409, 'um digest não reintegra'); assert.match(again.error, /state_not_integrable|"integrated"/);
  const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).worktrees.find((x) => x.id === rec.id); assert.equal(disk.state, 'integrated'); assert.equal(disk.attempts.at(-1).outcome, 'refused');
});

test('EVIDÊNCIA e pré-condições: cada violação recusa a integração, com o motivo, sem alterar a branch de destino', async () => {
  const expectRefusal = async (w, rec, code, prep = async () => {}) => {
    await prep(); const head = w.head(), c = await w.mgr.check(rec.id); assert.equal(c.attempt.result === 'mergeable', false, code);
    assert.ok(c.attempt.problems.some((p) => p.code === code), `${code} em ${JSON.stringify(c.attempt.problems)}`);
    const i = await w.mgr.integrate(rec.id, { digest: 'c'.repeat(32) }); assert.equal(i.ok, false); assert.equal(w.head(), head, code); assert.equal(w.status() === '' || code === 'target_dirty', true);
  };
  { const w = world(); const rec = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; w.mgr.link(rec.id, w.m.cycle.id); wr(rec.path, 'x.txt', 'x\n'); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'evidence_missing'); }
  { const w = world(), rec = await ready(w, { 'x.txt': 'x\n' }, 'failed'); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'evidence_missing'); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'evidence_stale', async () => { wr(rec.path, 'a.txt', 'mudou depois da verificação\n'); await w.mgr.snapshot(rec.id); }); }
  { const w = world({ cycle: { status: 'blocked', assurance: null } }), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'cycle_not_verified'); }
  { const w = world({ cycle: { status: 'completed', assurance: 'self-declared' } }), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'cycle_not_verified'); }
  { const w = world(), rec = await ready(w); await expectRefusal(w, rec, 'uncommitted_changes'); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'target_dirty', async () => wr(w.repo, 'sujo.txt', 'alteração local\n')); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'target_branch_changed', async () => G(w.repo, 'checkout', '-q', '-b', 'outra')); }
  { const w = world(), rec = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; w.mgr.link(rec.id, w.m.cycle.id); w.mgr.markInUse(rec.id, { round: 1, taskId: 't' }); await w.mgr.noteRound(rec.id, { round: 1, status: 'succeeded', level: 'verified' }); await expectRefusal(w, rec, 'nothing_to_integrate'); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); w.m.cycle.id = 'outro-ciclo'; await expectRefusal(w, rec, 'cycle_missing'); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); w.mgr.markInUse(rec.id, { round: 2, taskId: 't2' }); await expectRefusal(w, rec, 'state_not_integrable'); }
  { const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); await expectRefusal(w, rec, 'branch_changed', async () => G(rec.path, 'checkout', '-q', '-b', 'fugiu')); }
});

test('FALHA durante a integração: a branch de destino fica EXATAMENTE como estava, o diário é fechado e uma nova tentativa funciona', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); const c = await mergeable(w, rec.id), head = w.head(), refs = w.refs();
  const lock = path.join(w.repo, '.git', 'index.lock'); fs.writeFileSync(lock, ''); // o Git não consegue atualizar o working tree
  let r; try { r = await w.mgr.integrate(rec.id, { digest: c.digest }); } finally { fs.rmSync(lock, { force: true }); }
  assert.equal(r.ok, false, 'deveria ter falhado'); assert.match(r.error, /ficou exatamente como estava/); assert.deepEqual([w.head(), w.refs(), w.status()], [head, refs, '']);
  assert.deepEqual([rec.state, rec.op, r.attempt.outcome], ['finished', null, 'failed_unchanged']); assert.ok(rec.history.some((h) => h.event === 'integration_failed_unchanged'));
  const c2 = await mergeable(w, rec.id); const ok = await w.mgr.integrate(rec.id, { digest: c2.digest }); assert.equal(ok.ok, true, ok.error);
});

test('falha de PERSISTÊNCIA: criação e início da integração não prosseguem sem o diário gravado, e nada fica alterado', async () => {
  const w = world(); fs.mkdirSync(`${DB_FILE}.tmp`); // o banco não consegue gravar
  const before = db.worktrees.length; let c;
  try { c = await w.mgr.create({ mission: w.m, workspace: w.ws }); } finally { fs.rmSync(`${DB_FILE}.tmp`, { recursive: true, force: true }); }
  assert.equal(c.ok, false); assert.equal(c.status, 503); assert.equal(db.worktrees.length, before, 'registro desfeito'); assert.equal(GX(w.repo, 'branch', '--list', 'orch/*'), ''); assert.equal(fs.existsSync(path.join(tmp, `wts${n}`)), false, 'nenhuma pasta criada'); store.saveOrThrow();
  const rec = await ready(w); await w.mgr.snapshot(rec.id); const att = await mergeable(w, rec.id), head = w.head(); fs.mkdirSync(`${DB_FILE}.tmp`); let r;
  try { r = await w.mgr.integrate(rec.id, { digest: att.digest }); } finally { fs.rmSync(`${DB_FILE}.tmp`, { recursive: true, force: true }); }
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.match(r.error, /NÃO foi iniciada/); assert.equal(w.head(), head); assert.equal(rec.op, null); assert.equal(rec.state, 'finished'); store.saveOrThrow();
});

test('falha na CRIAÇÃO: sem restos, estado "failed" auditado e nada apagado fora do que a própria operação criou', async () => {
  const w = world(); const blocker = path.join(tmp, 'arquivo-no-lugar-da-raiz'); fs.writeFileSync(blocker, 'x');
  const mgr = W.createWorktreeManager({ db, root: blocker }), r = await mgr.create({ mission: w.m, workspace: w.ws });
  assert.equal(r.ok, false); assert.match(r.error, /não foi possível criar a pasta de worktrees/); assert.equal(r.record.state, 'failed'); assert.equal(r.record.op, null); assert.ok(r.record.history.some((h) => h.event === 'create_failed'));
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x', 'o arquivo alheio ficou intacto'); assert.equal(w.status(), '');
});

test('REUSO só com identidade e estado validados: pronto, sem ciclo, mesma base e limpo; adulterado ou desatualizado => novo ambiente', async () => {
  const w = world(); const a = await w.mgr.ensureFor(w.m, w.ws); assert.equal(a.created, true);
  const b = await w.mgr.ensureFor(w.m, w.ws); assert.deepEqual([b.created, b.record.id], [false, a.record.id]); assert.ok(a.record.history.some((h) => h.event === 'reused'));
  G(a.record.path, 'checkout', '-q', '-b', 'adulterada'); const c = await w.mgr.ensureFor(w.m, w.ws); assert.equal(c.created, true, 'branch mudou: não reutiliza'); assert.notEqual(c.record.id, a.record.id);
  const v = await w.mgr.revalidate(a.record.id); assert.equal(a.record.state, 'inconsistent'); assert.ok(v.problems.some((p) => p.code === 'branch_changed')); assert.equal(fs.existsSync(a.record.path), true, 'nada foi removido');
  wr(w.repo, 'b.txt', 'andou\n'); G(w.repo, 'commit', '-q', '-am', 'base andou'); const d = await w.mgr.ensureFor(w.m, w.ws); assert.equal(d.created, true, 'base desatualizada: não reutiliza');
  w.mgr.link(d.record.id, 'cyc-x'); const e = await w.mgr.ensureFor(w.m, w.ws); assert.equal(e.created, true, 'já pertence a um ciclo: não reutiliza');
  const other = world(); assert.equal((await other.mgr.ensureFor(other.m, other.ws)).created, true);
});

test('workspaceFor: o ciclo usa o worktree; se ele ficar inutilizável o resultado é null (nunca o workspace principal)', async () => {
  const w = world(), rec = await ready(w);
  assert.equal(w.mgr.workspaceFor(w.m).path, rec.path); assert.equal(w.mgr.workspaceFor(w.m).id, w.ws.id); assert.equal(w.ws.path, w.repo, 'o cadastro não foi alterado');
  const plain = { id: 'mx', workspaceId: w.ws.id, cycle: { id: 'c' } }; assert.equal(w.mgr.workspaceFor(plain).path, w.repo, 'sem worktree no ciclo: workspace cadastrado');
  fs.renameSync(rec.path, `${rec.path}.fora`); assert.equal(w.mgr.workspaceFor(w.m), null); fs.renameSync(`${rec.path}.fora`, rec.path); assert.equal(w.mgr.workspaceFor(w.m).path, rec.path);
  rec.state = 'inconsistent'; assert.equal(w.mgr.workspaceFor(w.m), null); rec.state = 'removed'; assert.equal(w.mgr.workspaceFor(w.m), null); rec.state = 'finished';
  w.m.cycle.worktreeId = 'wt_ffffffff'; assert.equal(w.mgr.workspaceFor(w.m), null);
});

test('LIMPEZA: só explícita e nunca destrutiva — recusa alterações, commits não integrados e uso; remove depois de integrado', async () => {
  const w = world(), rec = await ready(w); const dir = rec.path;
  let r = await w.mgr.cleanup(rec.id); assert.equal(r.ok, false); assert.match(r.error, /não commitadas/); assert.equal(fs.existsSync(dir), true);
  await w.mgr.snapshot(rec.id); r = await w.mgr.cleanup(rec.id); assert.equal(r.ok, false); assert.match(r.error, /NÃO integrados/); assert.equal(fs.existsSync(dir), true); assert.equal(GX(w.repo, 'branch', '--list', rec.branch) !== '', true);
  wr(dir, 'solto.txt', 'não rastreado\n'); r = await w.mgr.cleanup(rec.id); assert.equal(r.ok, false); assert.match(r.error, /não commitadas/); fs.rmSync(path.join(dir, 'solto.txt'));
  w.mgr.markInUse(rec.id, { round: 2, taskId: 't' }); r = await w.mgr.cleanup(rec.id); assert.equal(r.status, 409); assert.match(r.error, /em uso/); await w.mgr.noteRound(rec.id, { round: 2, status: 'succeeded', level: 'verified' });
  assert.equal((await w.mgr.cleanup(rec.id)).ok, false, 'a evidência nova não importa: ainda há commits não integrados');
  const c = await mergeable(w, rec.id), i = await w.mgr.integrate(rec.id, { digest: c.digest }); assert.equal(i.ok, true, i.error);
  assert.equal(fs.existsSync(dir), true, 'integrar NÃO limpa sozinho'); assert.equal(rec.state, 'integrated');
  const ok = await w.mgr.cleanup(rec.id); assert.equal(ok.ok, true, ok.error); assert.equal(rec.state, 'removed'); assert.equal(fs.existsSync(dir), false); assert.equal(ok.branchDeleted, true); assert.equal(GX(w.repo, 'branch', '--list', rec.branch), '');
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8').includes('(worktree)'), true, 'o trabalho integrado continua no principal'); assert.equal((await w.mgr.cleanup(rec.id)).status, 409);
  // um worktree sem nenhum trabalho também pode ser limpo
  const e = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; assert.equal((await w.mgr.cleanup(e.id)).ok, true);
  // e um worktree fora do padrão/adulterado nunca é removido
  const t = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; G(t.path, 'checkout', '-q', '-b', 'outra-branch'); r = await w.mgr.cleanup(t.id); assert.equal(r.ok, false); assert.match(r.error, /branch_changed/); assert.equal(fs.existsSync(t.path), true);
});

test('RECUPERAÇÃO após interrupção: cada operação inacabada é conciliada com o Git real, nada é relançado nem removido, e repetir não muda nada', async () => {
  // (a) criação interrompida DEPOIS de o Git criar o worktree => passa a "ready"
  const a = world(); const ra = (await a.mgr.create({ mission: a.m, workspace: a.ws })).record; ra.state = 'creating'; ra.op = { kind: 'create', at: 'T' };
  // (b) criação interrompida ANTES de qualquer coisa => "failed"
  const b = world(); const rb = { ...JSON.parse(JSON.stringify(ra)), id: 'wt_b0000001', branch: 'orch/wt_b0000001', path: path.join(tmp, 'wts-b', 'wt_b0000001'), repoPath: b.repo, workspaceId: b.ws.id, missionId: b.m.id, baseCommit: b.head(), state: 'creating', op: { kind: 'create', at: 'T' }, history: [] }; db.worktrees.push(rb);
  // (c) criação interrompida deixando a branch sem a pasta => "inconsistent", sem apagar a branch
  const c = world(); G(c.repo, 'branch', 'orch/wt_c0000001'); const rc = { ...rb, id: 'wt_c0000001', branch: 'orch/wt_c0000001', path: path.join(tmp, 'wts-c', 'wt_c0000001'), repoPath: c.repo, workspaceId: c.ws.id, missionId: c.m.id, baseCommit: c.head(), history: [] }; db.worktrees.push(rc);
  // (d) integração concluída pelo Git, mas a queda veio antes de registrar => "integrated"
  const d = world(), rd = await ready(d); await d.mgr.snapshot(rd.id); const cd = await mergeable(d, rd.id); const oldHead = d.head(), newCommit = G(rd.path, 'rev-parse', 'HEAD');
  rd.op = { kind: 'integrate', at: 'T', oldHead, newCommit, branch: 'main', prevState: 'finished' }; rd.attempts.at(-1).newCommit = newCommit; rd.attempts.at(-1).outcome = 'started'; G(d.repo, 'merge', '--ff-only', newCommit);
  // (e) integração que NÃO chegou a avançar a branch => volta ao estado anterior
  const e = world(), re = await ready(e); await e.mgr.snapshot(re.id); re.op = { kind: 'integrate', at: 'T', oldHead: e.head(), newCommit: re.headCommit, branch: 'main', prevState: 'finished' };
  // (f) integração com HEAD desconhecido => "inconsistent"
  const f = world(), rf = await ready(f); await f.mgr.snapshot(rf.id); rf.op = { kind: 'integrate', at: 'T', oldHead: 'a'.repeat(40), newCommit: 'b'.repeat(40), branch: 'main', prevState: 'finished' };
  // (g) execução em andamento na queda => "finished" com a evidência INVALIDADA
  const g = world(), rg = await ready(g); await g.mgr.snapshot(rg.id); g.mgr.markInUse(rg.id, { round: 2, taskId: 't2' });
  // (h) pasta do worktree apagada por fora => "inconsistent"
  const h = world(), rh = await ready(h); fs.rmSync(rh.path, { recursive: true, force: true });
  // (i) limpeza interrompida com a pasta ainda presente => volta; (j) com a pasta já removida => "removed"
  const i = world(), ri = await ready(i); ri.op = { kind: 'cleanup', at: 'T', prevState: 'finished' };
  const j = world(), rj = await ready(j); await j.mgr.snapshot(rj.id); rj.state = 'integrated'; G(j.repo, 'merge', '--ff-only', rj.headCommit); await j.mgr.cleanup(rj.id); rj.state = 'finished'; rj.op = { kind: 'cleanup', at: 'T', prevState: 'finished' };
  // (k) um worktree do orquestrador que o Git conhece e o banco não
  const k = world(); G(k.repo, 'worktree', 'add', '-q', '-b', 'orch/wt_dddddddd', path.join(tmp, 'solto'));
  const reg = db.worktrees.find((x) => x.repoPath === k.repo); assert.equal(reg, undefined); db.worktrees.push({ id: 'wt_eeeeeeee', missionId: k.m.id, workspaceId: k.ws.id, repoPath: k.repo, path: path.join(tmp, 'nada'), branch: 'orch/wt_eeeeeeee', baseCommit: k.head(), baseBranch: 'main', state: 'removed', history: [], rounds: [], attempts: [] });
  const missionsBefore = JSON.stringify(db.missions), eHead = e.head(); const mgr = W.createWorktreeManager({ db }); const out = await mgr.recover();
  const st = (rec) => rec.state; assert.deepEqual([st(ra), st(rb), st(rc)], ['ready', 'failed', 'inconsistent']); assert.equal(GX(c.repo, 'branch', '--list', 'orch/wt_c0000001') !== '', true, 'a branch deixada pela criação interrompida NÃO foi apagada');
  assert.deepEqual([st(rd), rd.integratedCommit === newCommit, rd.attempts.at(-1).outcome, rd.op], ['integrated', true, 'integrated', null]);
  assert.deepEqual([st(re), re.op], ['finished', null]); assert.equal(e.head(), eHead, 'a branch não andou'); assert.deepEqual([st(rf), rf.op], ['inconsistent', null]);
  assert.equal(st(rg), 'finished'); assert.equal(rg.current, null); assert.equal(rg.rounds.at(-1).level, 'interrupted'); assert.ok(rg.history.some((x) => x.event === 'execution_interrupted_by_restart'));
  const cg = await mergeable(g, rg.id); assert.equal(cg.result === 'mergeable', false); assert.ok(cg.problems.some((p) => p.code === 'evidence_missing'), 'a rodada interrompida nunca vira evidência');
  assert.equal(st(rh), 'inconsistent'); assert.ok(rh.history.some((x) => x.reason?.includes('path_missing'))); assert.deepEqual([st(ri), ri.op, fs.existsSync(ri.path)], ['finished', null, true]); assert.equal(st(rj), 'removed');
  assert.deepEqual(out.unregistered.map((u) => u.branch), ['orch/wt_dddddddd'], 'informado, não alterado'); assert.equal(fs.existsSync(path.join(tmp, 'solto')), true);
  assert.equal(JSON.stringify(db.missions), missionsBefore, 'nenhuma missão foi criada, lançada ou alterada pela recuperação');
  const snap = JSON.stringify(db.worktrees); const again = await mgr.recover(); assert.equal(JSON.stringify(db.worktrees), snap, 'recuperar de novo não muda nada'); assert.deepEqual(again.settled, []);
});

test('API: listar, checar, snapshot, integrar (exige digest), limpar e revalidar — com erros claros e sem expor operações perigosas', async () => {
  const w = world(), rec = await ready(w), app = express(); app.use(express.json()); W.setupWorktrees(app, { db, manager: w.mgr });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  try {
    const list = await call(`/api/worktrees?missionId=${w.m.id}`); assert.equal(list.status, 200); assert.deepEqual(list.json.map((x) => x.id), [rec.id]); assert.equal((await call('/api/worktrees?missionId=nada')).json.length, 0);
    assert.equal((await call(`/api/worktrees/${rec.id}`)).json.branch, rec.branch); assert.equal((await call('/api/worktrees/wt_00000000')).status, 404); assert.equal((await call('/api/worktrees/wt_00000000/check', 'POST')).status, 404);
    const unc = await call(`/api/worktrees/${rec.id}/check`, 'POST'); assert.equal(unc.status, 200); assert.equal(unc.json.attempt.result, 'invalid'); assert.ok(unc.json.attempt.problems.some((p) => p.code === 'uncommitted_changes'));
    assert.equal((await call(`/api/worktrees/${rec.id}/snapshot`, 'POST', { message: 'via API' })).status, 200); assert.equal((await call(`/api/worktrees/${rec.id}/snapshot`, 'POST')).status, 409, 'nada novo para registrar');
    const chk = await call(`/api/worktrees/${rec.id}/check`, 'POST'); assert.equal(chk.json.attempt.result, 'mergeable');
    const head = w.head(); assert.equal((await call(`/api/worktrees/${rec.id}/integrate`, 'POST', {})).status, 400); assert.equal((await call(`/api/worktrees/${rec.id}/integrate`, 'POST', { digest: 'f'.repeat(32) })).status, 409); assert.equal(w.head(), head);
    assert.equal((await call(`/api/worktrees/${rec.id}/cleanup`, 'POST')).status, 409, 'não integrado: não limpa');
    const done = await call(`/api/worktrees/${rec.id}/integrate`, 'POST', { digest: chk.json.attempt.digest }); assert.equal(done.status, 200); assert.equal(done.json.worktree.state, 'integrated'); assert.notEqual(w.head(), head);
    assert.equal((await call(`/api/worktrees/${rec.id}/revalidate`, 'POST')).status, 200); const clean = await call(`/api/worktrees/${rec.id}/cleanup`, 'POST'); assert.equal(clean.status, 200); assert.equal(clean.json.worktree.state, 'removed');
    assert.equal((await call(`/api/worktrees/${rec.id}`, 'DELETE')).status, 404, 'não há rota de exclusão'); assert.equal((await call(`/api/worktrees/${rec.id}/force`, 'POST')).status, 404);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('bloqueio de remoção do workspace enquanto houver worktree não removido', async () => {
  const { workspaceRemovalBlocker } = await import('../workspaces.js');
  const w = world(), rec = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record;
  assert.match(workspaceRemovalBlocker(db, w.ws.id) ?? '', /worktrees isolados/); await w.mgr.cleanup(rec.id); assert.equal((workspaceRemovalBlocker(db, w.ws.id) ?? '').includes('worktrees'), false);
});

// ---------- interface (módulo puro) ----------
test('worktreeView: estado, tentativas, conflitos e ações oferecidas vêm do que o servidor gravou; só se oferece integrar com o digest da ÚLTIMA checagem "pode integrar"', async () => {
  const view = await import('../../client/src/worktree-view.js');
  const w = world(), rec = await ready(w); const d0 = w.mgr.describe(rec);
  let rows = view.worktreeView([d0], { missionId: w.m.id }); assert.equal(rows.length, 1); assert.deepEqual([rows[0].state, rows[0].status, rows[0].canCheck, rows[0].canSnapshot, rows[0].authorization, rows[0].canCleanup], ['finished', 'unverified', true, false, null, true]);
  await w.mgr.check(rec.id); rows = view.worktreeView([w.mgr.describe(rec)]); assert.equal(rows[0].canSnapshot, true, 'checagem apontou alterações não commitadas'); assert.equal(rows[0].authorization, null);
  assert.ok(rows[0].attempts.at(-1).problems.some((p) => p.code === 'uncommitted_changes')); await w.mgr.snapshot(rec.id);
  const att = await mergeable(w, rec.id); rows = view.worktreeView([w.mgr.describe(rec)]);
  assert.deepEqual([rows[0].authorization?.digest, rows[0].canSnapshot, rows[0].attempts.at(-1).resultLabel], [att.digest, false, 'pode ser integrado']); assert.match(rows[0].authorization.summary, /avanço direto/); assert.match(rows[0].attempts.at(-1).evidenceLabel, /evidência verified \(confere/);
  // conflito: nunca oferece integrar e lista os arquivos
  wr(w.repo, 'a.txt', LINES.replace('linha 2', 'linha 2 do principal')); G(w.repo, 'commit', '-q', '-am', 'concorrente'); await w.mgr.check(rec.id); rows = view.worktreeView([w.mgr.describe(rec)]);
  assert.deepEqual([rows[0].authorization, rows[0].attempts.at(-1).result, rows[0].attempts.at(-1).conflicts], [null, 'conflict', ['a.txt']]); assert.equal(rows[0].attempts.at(-1).resultLabel, 'conflito real');
  // em uso/inconsistente/removido: sem ações; filtro por missão; malformado ignorado
  rec.state = 'in_use'; assert.deepEqual(view.worktreeView([w.mgr.describe(rec)]).map((r) => [r.canCheck, r.canCleanup]), [[false, false]]); rec.state = 'inconsistent'; assert.match(view.worktreeView([w.mgr.describe(rec)])[0].note, /nada é corrigido nem removido/i);
  assert.equal(view.worktreeView([w.mgr.describe(rec)], { missionId: 'outra' }).length, 0); assert.deepEqual(view.worktreeView([null, 'x', { id: 'a', state: 'inventado' }, undefined]), []); assert.deepEqual(view.worktreeView(undefined), []); rec.state = 'finished';
  const f = view.worktreeForm({ isolation: { enabled: false, source: 'default' }, items: [d0, { state: 'inconsistent' }], unregistered: [{ branch: 'orch/wt_1' }] });
  assert.deepEqual([f.enabled, f.sourceLabel, f.disabled, f.pending, f.unregistered], [false, 'padrão (desligado)', false, 2, ['orch/wt_1']]); assert.match(f.notes.join(' '), /nunca faz push/);
  const env = view.worktreeForm({ isolation: { enabled: true, source: 'env' }, items: [] }); assert.deepEqual([env.locked, env.disabled], [true, true]); assert.match(env.reason, /ORCH_WORKTREE_ISOLATION/);
  assert.equal(view.worktreeForm({ isolation: { enabled: false, source: 'default' } }, { activeCycle: true }).disabled, true); for (const bad of [undefined, null, {}, { isolation: { enabled: 'sim' } }]) assert.equal(view.worktreeForm(bad), null);
});

test('release(): só age em "in_use", nunca em outros estados, e a rodada interrompida invalida a evidência anterior', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id);
  assert.equal(w.mgr.release(rec.id), false, 'finished: nada a liberar'); assert.equal(w.mgr.release('wt_00000000'), false);
  w.mgr.markInUse(rec.id, { round: 2, taskId: 't2' }); assert.equal(w.mgr.release(rec.id, 'teste'), true); assert.equal(rec.state, 'finished'); assert.equal(w.mgr.release(rec.id), false, 'idempotente');
  const c = await w.mgr.check(rec.id); assert.ok(c.attempt.problems.some((p) => p.code === 'evidence_missing'), 'a evidência verificada anterior não vale depois de uma rodada interrompida');
  rec.state = 'integrated'; assert.equal(w.mgr.release(rec.id), false); rec.state = 'finished';
});

test('W9 — digest CORRETO mas SEM checagem registrada: a integração é recusada (digest igual ao estado não equivale a uma checagem autorizada) e o destino não muda', async () => {
  const crypto = await import('node:crypto');
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id);
  assert.deepEqual(rec.attempts, [], 'nenhuma checagem foi registrada');
  // digest calculado POR FORA, só com o Git real e os campos do registro (a fórmula documentada em worktrees.js: finish()); não chama check/assess
  const targetHead = w.head(), wtHead = G(rec.path, 'rev-parse', 'HEAD'), contentTree = G(rec.path, 'rev-parse', 'HEAD^{tree}');
  const mergeTree = G(w.repo, 'merge-tree', '--write-tree', '--no-messages', '--name-only', targetHead, wtHead).split(/\r?\n/)[0];
  assert.match(mergeTree, /^[0-9a-f]{40,64}$/);
  const digest = crypto.createHash('sha256').update(JSON.stringify([rec.id, rec.repoPath, rec.baseBranch, targetHead, wtHead, mergeTree, contentTree, rec.cycleId, rec.rounds.at(-1)?.n ?? null])).digest('hex').slice(0, 32);
  // estado do destino antes da tentativa
  const head = w.head(), refs = w.refs(), file = fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), idx = fs.readFileSync(path.join(w.repo, '.git', 'index'));
  const r = await w.mgr.integrate(rec.id, { digest });
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, /não há checagem registrada com este digest/);
  assert.deepEqual([r.attempt.kind, r.attempt.outcome], ['integrate', 'refused']); assert.match(r.attempt.refusal, /não há checagem registrada/);
  assert.deepEqual([w.head(), w.refs(), w.status(), fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8')], [head, refs, '', file], 'branch, refs e working tree do destino intactos'); assert.ok(fs.readFileSync(path.join(w.repo, '.git', 'index')).equals(idx), 'índice intacto');
  assert.deepEqual([rec.state, rec.op, rec.integratedCommit], ['finished', null, null]); assert.equal(rec.attempts.filter((x) => x.kind === 'check').length, 0, 'a recusa não inventa uma checagem');
  // contraprova: o digest calculado por fora é EXATAMENTE o do estado real; faltava apenas a checagem registrada
  const c = await w.mgr.check(rec.id); assert.equal(c.attempt.result, 'mergeable'); assert.equal(c.attempt.digest, digest, 'a fórmula independente reproduz o digest real');
  const ok = await w.mgr.integrate(rec.id, { digest }); assert.equal(ok.ok, true, ok.error); assert.equal(rec.state, 'integrated'); assert.equal(w.head(), wtHead);
});

test('Revalidar (interface): botão só para inconsistente/com diagnóstico e resultado recovered | blocked | inconclusive nunca confundidos', async () => {
  const view = await import('../../client/src/worktree-view.js');
  const w = world(), rec = await ready(w); const rows = () => view.worktreeView([w.mgr.describe(rec)]);
  assert.equal(rows()[0].canRevalidate, false, 'ambiente saudável não oferece revalidar');
  rec.state = 'inconsistent'; assert.equal(rows()[0].canRevalidate, true);
  rec.state = 'finished'; rec.diagnostic = { code: 'inspection_failed', reason: 'git ausente', at: 'T' }; assert.equal(rows()[0].canRevalidate, true); assert.match(rows()[0].diagnostic, /inspection_failed: git ausente/); rec.diagnostic = null;
  // resultados reais do gerenciador (mesmos campos que a rota devolve)
  fs.renameSync(rec.path, `${rec.path}.fora`); await w.mgr.revalidate(rec.id); assert.equal(rec.state, 'inconsistent');
  let o = view.revalidateOutcome(await w.mgr.revalidate(rec.id)); assert.deepEqual([o.kind, o.ok], ['blocked', false]); assert.match(o.text, /Continua bloqueado: .*path_missing/);
  fs.renameSync(`${rec.path}.fora`, rec.path);
  o = view.revalidateOutcome(await w.mgr.revalidate(rec.id)); assert.deepEqual([o.kind, o.ok], ['recovered', true]); assert.match(o.text, /Recuperado/);
  // inconclusivo e formatos inesperados: nunca sucesso
  o = view.revalidateOutcome({ recovered: false, inconclusive: true, blocked: { code: 'inspection_failed', reason: 'tempo esgotado', inconclusive: true } }); assert.deepEqual([o.kind, o.ok], ['inconclusive', false]); assert.match(o.text, /tempo esgotado/);
  assert.equal(view.revalidateOutcome({ blocked: { reason: 'x' } }).ok, false); assert.equal(view.revalidateOutcome({ problems: [{ code: 'path_missing' }] }).ok, false); assert.equal(view.revalidateOutcome(null).kind, 'ok');
});
