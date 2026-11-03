// Marco C — fechamento: I1 (recuperação de registros inconsistentes e Git indisponível), I2 (ciclo anterior em pastCycles), I3 (falha ao consultar o Git NUNCA é "limpo")
// e I4 (worktree é checkout frio: verificação sem ambiente preparado é recusada). Repositórios Git REAIS mas TEMPORÁRIOS; falhas do Git são INJETADAS por `runGit`;
// banco temporário; nenhum modelo, nenhuma missão real, nenhuma rede (sem remoto, sem instalação de dependências).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-hard-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const W = await import('../worktrees.js');
const db = store.load(); db.missions = []; db.workspaces = []; store.saveOrThrow();
after(async () => { await new Promise((r) => setTimeout(r, 300)); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- helpers ----------
const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const GX = (cwd, ...args) => { try { return G(cwd, ...args); } catch (e) { return `ERRO:${e.status}`; } };
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const LINES = Array.from({ length: 12 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n';
const DOWN = { code: -1, out: '', err: 'spawn git ENOENT', failed: true, timedOut: false };
const TIMEOUT = { code: -1, out: '', err: 'Command failed: timeout', failed: true, timedOut: true };
/** Injeta falhas do Git: `ctl.rule(args, cwd)` devolve um resultado falso (ou null para usar o Git real); `ctl.calls` registra cada comando. */
const injector = () => { const ctl = { rule: null, calls: [] }; ctl.runGit = (cwd, args, o) => { ctl.calls.push(args); const f = ctl.rule?.(args, cwd); return f ? Promise.resolve(f) : W.git(cwd, args, o); }; return ctl; };
let n = 0;
/** Repositório novo (1 commit), missão com ciclo "concluído e verificado" e um gerenciador PRÓPRIO (banco em memória privado: a recuperação só enxerga os registros deste mundo). */
function world({ ctl = null, cycle = { status: 'completed', assurance: 'verified' } } = {}) {
  const id = ++n, repo = path.join(tmp, `repo${id}`); fs.mkdirSync(repo);
  G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false'); wr(repo, 'a.txt', LINES); wr(repo, 'b.txt', 'b\n'); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
  const ws = { id: `ws${id}`, name: `ws${id}`, path: repo, verifications: [] }, m = { id: `m${id}`, workspaceId: ws.id, tasks: [], cycle: { id: `cyc${id}`, rounds: [], ...cycle } };
  const pdb = { worktrees: [], missions: [m], workspaces: [ws] };
  const mgr = W.createWorktreeManager({ db: pdb, root: path.join(tmp, `wts${id}`), runGit: ctl?.runGit });
  return { repo, ws, m, mgr, db: pdb, ctl, head: () => G(repo, 'rev-parse', 'HEAD'), refs: () => G(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), status: () => G(repo, 'status', '--porcelain', '-uall') };
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
const codes = (att) => att.problems.map((p) => p.code);
const readOnly = (a) => ['rev-parse', 'symbolic-ref', 'merge-base', 'status'].includes(a[0]) || (a[0] === 'worktree' && a[1] === 'list'); // o que a recuperação pode pedir ao Git
const gitState = (w, recs) => ({ refs: w.refs(), wts: G(w.repo, 'worktree', 'list', '--porcelain'), head: w.head(), main: w.status(), dirs: recs.map((r) => fs.existsSync(r.path)), heads: recs.filter((r) => fs.existsSync(r.path)).map((r) => `${GX(r.path, 'rev-parse', 'HEAD')}|${GX(r.path, 'status', '--porcelain', '-uall')}`) });

// =====================================================================================================================
// I1 — Git indisponível no boot e recuperação explícita de registros inconsistentes
// =====================================================================================================================
test('I1 — boot com Git INDISPONÍVEL: nenhum registro é invalidado, nada é apagado, a operação inacabada fica pendente e o diagnóstico explica', async () => {
  const ctl = injector(), w = world({ ctl });
  const fin = await ready(w); // finished, com trabalho
  const cr = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; cr.state = 'creating'; cr.op = { kind: 'create', at: 'T' }; // queda DEPOIS de o Git criar o worktree
  const ig = await ready(w); await w.mgr.snapshot(ig.id); ig.op = { kind: 'integrate', at: 'T', oldHead: w.head(), newCommit: ig.headCommit, branch: 'main', prevState: 'finished' }; // queda ANTES de a branch andar
  const before = gitState(w, [fin, cr, ig]);
  ctl.rule = () => DOWN;
  const out = await w.mgr.recover();
  assert.deepEqual([fin.state, cr.state, ig.state], ['finished', 'creating', 'finished'], 'um Git que não responde não prova que o ambiente é inválido');
  assert.equal(cr.op?.kind, 'create'); assert.equal(ig.op?.kind, 'integrate', 'a operação inacabada continua registrada para ser conciliada depois');
  assert.deepEqual(out.unverified.map((u) => u.id).sort(), [fin.id, cr.id, ig.id].sort()); assert.deepEqual(out.inconsistent, []); assert.deepEqual(out.settled, []);
  for (const r of [fin, cr, ig]) { assert.equal(r.diagnostic.code, 'inspection_failed'); assert.ok(r.diagnostic.reason.length > 0); assert.ok(!r.history.some((h) => h.event === 'inconsistent'), 'nenhuma marca de inconsistência'); }
  assert.deepEqual(gitState(w, [fin, cr, ig]), before, 'nada foi apagado nem alterado no Git ou nas pastas');
  const again = await w.mgr.recover(); assert.deepEqual([fin.state, cr.state, ig.state], ['finished', 'creating', 'finished']); assert.equal(again.unverified.length, 3, 'repetir com o Git ainda fora do ar continua sem decidir');
  // o Git volta: a MESMA conciliação (próximo boot ou nova chamada) agora decide com o Git real
  ctl.rule = null;
  const ok = await w.mgr.recover();
  assert.deepEqual(ok.unverified, []); assert.deepEqual([fin.state, cr.state, ig.state], ['finished', 'ready', 'finished'], 'criação concluída; integração que não andou volta ao estado anterior');
  assert.equal(cr.op, null); assert.equal(ig.op, null); for (const r of [fin, cr, ig]) assert.equal(r.diagnostic, null, 'diagnóstico limpo depois de conciliar');
  assert.deepEqual(ok.settled.map((s) => [s.id, s.from, s.to]), [[cr.id, 'creating', 'ready']]); assert.equal(w.head(), before.head, 'a branch não andou');
  assert.equal(gitState(w, [fin, cr, ig]).refs, before.refs);
});

test('I1 — timeout do Git no boot é tratado como "não verificado", nunca como inválido; a revalidação concilia uma operação pendente quando o Git volta', async () => {
  const ctl = injector(), w = world({ ctl });
  const cr = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; cr.state = 'creating'; cr.op = { kind: 'create', at: 'T' };
  const rd = await ready(w); // ready/finished sem operação
  ctl.rule = () => TIMEOUT; const out = await w.mgr.recover();
  assert.equal(cr.state, 'creating'); assert.equal(rd.state, 'finished'); assert.equal(out.unverified.length, 2); assert.match(cr.diagnostic.reason, /tempo esgotado/);
  const blocked = await w.mgr.revalidate(cr.id); assert.equal(blocked.ok, true); assert.equal(blocked.inconclusive, true); assert.equal(blocked.blocked.code, 'inspection_failed'); assert.equal(cr.state, 'creating'); assert.equal(cr.op.kind, 'create');
  const rd2 = await w.mgr.revalidate(rd.id); assert.equal(rd2.inconclusive, true); assert.equal(rd.state, 'finished', 'revalidar com o Git fora do ar não marca inconsistente');
  ctl.rule = null;
  const done = await w.mgr.revalidate(cr.id); assert.equal(done.ok, true); assert.equal(cr.state, 'ready'); assert.equal(cr.op, null); assert.equal(cr.diagnostic, null);
  const ok = await w.mgr.revalidate(rd.id); assert.deepEqual([ok.problems, rd.state, rd.diagnostic], [[], 'finished', null]);
});

test('I1 — recuperação de um registro INCONSISTENTE válido: o Git confirma identidade e estado; enquanto continuar inválido ou o Git não responder, fica bloqueado com a razão', async () => {
  const ctl = injector(), w = world({ ctl }), rec = await ready(w); await w.mgr.snapshot(rec.id);
  // (a) a pasta some por fora => definitivo => inconsistent; a recuperação RECUSA enquanto não voltar
  fs.renameSync(rec.path, `${rec.path}.fora`);
  assert.equal((await w.mgr.revalidate(rec.id)).ok, true); assert.equal(rec.state, 'inconsistent'); assert.equal(w.mgr.workspaceFor(w.m), null);
  let r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, false); assert.equal(r.blocked.code, 'still_invalid'); assert.match(r.blocked.reason, /path_missing/); assert.equal(rec.state, 'inconsistent'); assert.equal(rec.diagnostic.code, 'still_invalid');
  // (b) a pasta volta, mas o Git não responde: continua bloqueado, marcado como INCONCLUSIVO (diferente de inválido)
  fs.renameSync(`${rec.path}.fora`, rec.path);
  ctl.rule = () => DOWN; r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, false); assert.equal(r.inconclusive, true); assert.equal(r.blocked.code, 'inspection_failed'); assert.equal(rec.state, 'inconsistent'); assert.equal(rec.diagnostic.inconclusive, true);
  // (c) o Git volta: recuperado para "finished" (há ciclo e rodadas), com a evidência e o trabalho intactos
  ctl.rule = null; const head = G(rec.path, 'rev-parse', 'HEAD'), refs = w.refs();
  r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, true, JSON.stringify(r.blocked)); assert.equal(r.recoveredTo, 'finished'); assert.equal(rec.state, 'finished'); assert.equal(rec.diagnostic, null); assert.equal(rec.op, null);
  assert.ok(rec.history.some((h) => h.event === 'recovered' && h.to === 'finished')); assert.equal(G(rec.path, 'rev-parse', 'HEAD'), head); assert.equal(w.refs(), refs); assert.equal(w.mgr.workspaceFor(w.m).path, rec.path);
  assert.equal((await mergeable(w, rec.id)).result, 'mergeable', 'depois de recuperado volta a poder ser checado');
  // (d) ambiente novo (sem ciclo nem trabalho) marcado inconsistente por um Git que caiu no boot antigo => volta a "ready"
  const fresh = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; fresh.state = 'inconsistent';
  r = await w.mgr.revalidate(fresh.id); assert.equal(r.recovered, true); assert.equal(fresh.state, 'ready');
  // (e) com execução registrada na hora da queda: a rodada vira "interrompida" (nunca evidência)
  const run = await ready(w); run.state = 'inconsistent'; run.current = { round: 2, taskId: 'tx', at: 'T' };
  r = await w.mgr.revalidate(run.id); assert.equal(r.recovered, true); assert.equal(run.state, 'finished'); assert.equal(run.current, null); assert.equal(run.rounds.at(-1).level, 'interrupted');
});

test('I1 — integração INCERTA: só volta a "integrated" se o Git mostra o commit integrado no destino (limpo); caso contrário continua bloqueada', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); const c = await mergeable(w, rec.id), i = await w.mgr.integrate(rec.id, { digest: c.digest }); assert.equal(i.ok, true, i.error);
  const newCommit = rec.integratedCommit, att = rec.attempts.at(-1);
  // (a) destino contém o commit => "integrated" (mesmo partindo de um registro legado "inconsistent" sem pistas)
  rec.state = 'inconsistent'; att.outcome = 'inconsistent'; const head = w.head();
  let r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, true, JSON.stringify(r.blocked)); assert.equal(rec.state, 'integrated'); assert.equal(rec.integratedCommit, newCommit); assert.equal(w.head(), head);
  // (b) destino com alterações pendentes: bloqueado, e o arquivo pendente NÃO é tocado
  rec.state = 'inconsistent'; wr(w.repo, 'pendente.txt', 'meu trabalho\n');
  r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, false); assert.equal(r.blocked.code, 'target_dirty'); assert.equal(rec.state, 'inconsistent'); assert.equal(fs.readFileSync(path.join(w.repo, 'pendente.txt'), 'utf8'), 'meu trabalho\n'); fs.rmSync(path.join(w.repo, 'pendente.txt'));
  // (c) o commit registrado NÃO está no destino e o HEAD do destino não é o anterior: bloqueado
  rec.integratedCommit = null; att.newCommit = 'b'.repeat(40); att.targetHead = 'a'.repeat(40);
  r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, false); assert.equal(r.blocked.code, 'target_head_unexpected'); assert.equal(rec.state, 'inconsistent'); assert.equal(w.head(), head);
  // (d) destino exatamente onde estava antes e commit ausente: a integração não aconteceu => volta ao estado de trabalho (nada integrado)
  att.targetHead = head; r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, true); assert.equal(rec.state, 'finished'); assert.equal(rec.integratedCommit, null);
});

test('I1 — registro REALMENTE inválido não é recuperado (branch trocada, pasta que não é worktree, branch do destino mudou) e nada é alterado ou apagado', async () => {
  const ctl = injector(), w = world({ ctl });
  // branch do worktree trocada
  const a = await ready(w); G(a.path, 'checkout', '-q', '-b', 'outra-branch');
  assert.equal((await w.mgr.revalidate(a.id)).ok, true); assert.equal(a.state, 'inconsistent'); const ra = await w.mgr.revalidate(a.id);
  assert.equal(ra.recovered, false); assert.equal(ra.blocked.code, 'still_invalid'); assert.match(ra.blocked.reason, /branch_changed/); assert.equal(ra.blocked.inconclusive, false); assert.equal(a.state, 'inconsistent');
  assert.equal(GX(w.repo, 'branch', '--list', 'outra-branch') !== '', true); assert.equal(GX(w.repo, 'branch', '--list', a.branch) !== '', true, 'a branch do orquestrador não foi apagada');
  // a pasta virou uma pasta comum (não é mais um worktree)
  const b = await ready(w); fs.renameSync(b.path, `${b.path}.fora`); fs.mkdirSync(b.path); wr(b.path, 'qualquer.txt', 'x\n');
  await w.mgr.revalidate(b.id); assert.equal(b.state, 'inconsistent'); const rb = await w.mgr.revalidate(b.id);
  assert.equal(rb.recovered, false); assert.match(rb.blocked.reason, /not_a_worktree|not_registered/); assert.equal(fs.readFileSync(path.join(b.path, 'qualquer.txt'), 'utf8'), 'x\n'); assert.equal(fs.existsSync(`${b.path}.fora`), true);
  fs.rmSync(b.path, { recursive: true, force: true }); fs.renameSync(`${b.path}.fora`, b.path);
  // o workspace principal trocou de branch (o destino registrado não existe mais como HEAD)
  const c = await ready(w); c.state = 'inconsistent'; G(w.repo, 'checkout', '-q', '-b', 'desvio');
  const rc = await w.mgr.revalidate(c.id); assert.equal(rc.recovered, false); assert.equal(rc.blocked.code, 'target_branch_changed'); assert.equal(c.state, 'inconsistent'); G(w.repo, 'checkout', '-q', 'main');
  // pasta do worktree inexistente de vez
  const d = await ready(w); d.state = 'inconsistent'; fs.rmSync(d.path, { recursive: true, force: true });
  const rd = await w.mgr.revalidate(d.id); assert.equal(rd.recovered, false); assert.match(rd.blocked.reason, /path_missing/); assert.equal(d.state, 'inconsistent');
});

test('I1 — a recuperação NUNCA é destrutiva: só consulta o Git (leitura), sem apagar branch, pasta ou commit e sem --force', async () => {
  const ctl = injector(), w = world({ ctl });
  const ok = await ready(w), bad = await ready(w), integ = await ready(w); await w.mgr.snapshot(integ.id);
  ok.state = 'inconsistent'; G(bad.path, 'checkout', '-q', '-b', 'outra'); bad.state = 'inconsistent';
  const ic = await mergeable(w, integ.id); assert.equal((await w.mgr.integrate(integ.id, { digest: ic.digest })).ok, true); integ.state = 'inconsistent'; integ.attempts.at(-1).outcome = 'inconsistent';
  wr(w.repo, 'solto.txt', 'não rastreado\n'); const before = gitState(w, [ok, bad, integ]); const files = fs.readdirSync(w.repo).sort();
  ctl.calls = [];
  await w.mgr.revalidate(ok.id); await w.mgr.revalidate(bad.id); await w.mgr.revalidate(integ.id); ctl.rule = () => DOWN; await w.mgr.revalidate(bad.id); await w.mgr.recover(); ctl.rule = null; await w.mgr.recover();
  assert.ok(ctl.calls.length > 0); assert.deepEqual(ctl.calls.filter((a) => !readOnly(a)), [], 'a recuperação só pediu comandos de LEITURA ao Git');
  assert.ok(!ctl.calls.some((a) => a.some((x) => ['--force', '-f', '-D', 'remove', 'prune', 'reset', 'clean', 'checkout', 'merge', 'commit'].includes(x))));
  const after = gitState(w, [ok, bad, integ]); assert.equal(after.refs, before.refs); assert.equal(after.wts, before.wts); assert.deepEqual(after.dirs, before.dirs); assert.deepEqual(after.heads, before.heads);
  assert.deepEqual(fs.readdirSync(w.repo).sort(), files); assert.equal(fs.readFileSync(path.join(w.repo, 'solto.txt'), 'utf8'), 'não rastreado\n');
  assert.deepEqual([ok.state, bad.state, integ.state], ['finished', 'inconsistent', 'inconsistent'], 'recuperado só o válido; o inválido e o de destino sujo seguem bloqueados');
});

// =====================================================================================================================
// I3 — falha ao consultar o estado do Git nunca é "workspace limpo"
// =====================================================================================================================
const STATUS_FAULTS = {
  'erro do Git (código ≠ 0)': { code: 128, out: '', err: 'fatal: not a git repository', failed: false, timedOut: false },
  timeout: TIMEOUT,
  'Git ausente': DOWN,
  'saída fora do formato': { code: 0, out: 'isto não é porcelain\n', err: '', failed: false, timedOut: false },
  'saída incompleta (sem quebra final)': { code: 0, out: ' M a.tx', err: '', failed: false, timedOut: false },
};
const onlyStatus = (fault) => (a) => (a[0] === 'status' ? fault : null);

test('I3 — git status bem-sucedido: LIMPO e SUJO continuam distinguidos (comportamento normal preservado)', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id);
  let c = await mergeable(w, rec.id); assert.equal(c.result, 'mergeable', JSON.stringify(c.problems)); assert.deepEqual(codes(c), []);
  wr(rec.path, 'novo.txt', 'x\n'); c = await mergeable(w, rec.id); assert.equal(c.result, 'invalid'); assert.deepEqual(codes(c).filter((x) => x.endsWith('_unknown')), []); assert.ok(codes(c).includes('uncommitted_changes')); fs.rmSync(path.join(rec.path, 'novo.txt'));
  wr(w.repo, 'sujo.txt', 'x\n'); c = await mergeable(w, rec.id); assert.ok(codes(c).includes('target_dirty')); assert.deepEqual(codes(c).filter((x) => x.endsWith('_unknown')), []); fs.rmSync(path.join(w.repo, 'sujo.txt'));
  const fresh = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record; assert.equal(fresh.baseDirty, false);
});

for (const [name, fault] of Object.entries(STATUS_FAULTS)) {
  test(`I3 — ${name}: estado DESCONHECIDO não é limpo — bloqueia checagem, integração, snapshot e limpeza, sem alterar nada`, async () => {
    const ctl = injector(), w = world({ ctl }), rec = await ready(w); await w.mgr.snapshot(rec.id);
    const good = await mergeable(w, rec.id); assert.equal(good.result, 'mergeable'); const head = w.head(), refs = w.refs(), wtHead = G(rec.path, 'rev-parse', 'HEAD');
    ctl.rule = onlyStatus(fault);
    // checagem: nunca "pode integrar" e nunca devolve digest
    const c = await mergeable(w, rec.id); assert.equal(c.result, 'invalid'); assert.equal(c.digest, null); assert.ok(codes(c).includes('target_state_unknown') && codes(c).includes('worktree_state_unknown'), JSON.stringify(codes(c)));
    assert.ok(!codes(c).includes('target_dirty') && !codes(c).includes('uncommitted_changes') && !codes(c).includes('evidence_stale'), 'desconhecido não vira "sujo" nem "conteúdo mudou"');
    // integração com o digest que era VÁLIDO antes da falha: recusada, destino intacto
    const i = await w.mgr.integrate(rec.id, { digest: good.digest }); assert.equal(i.ok, false); assert.equal(i.status, 409); assert.equal(w.head(), head); assert.equal(w.refs(), refs); assert.equal(rec.state, 'finished'); assert.equal(rec.integratedCommit, null);
    // snapshot: com alterações de verdade no worktree, mas estado desconhecido => nada é registrado
    wr(rec.path, 'extra.txt', 'x\n'); const s = await w.mgr.snapshot(rec.id); assert.equal(s.ok, false); assert.equal(s.status, 409); assert.match(s.error, /Snapshot não registrado/); assert.equal(G(rec.path, 'rev-parse', 'HEAD'), wtHead); fs.rmSync(path.join(rec.path, 'extra.txt'));
    // limpeza: mesmo integrado e limpo, estado desconhecido => nada é removido
    ctl.rule = null; const again = await mergeable(w, rec.id); assert.equal((await w.mgr.integrate(rec.id, { digest: again.digest })).ok, true); assert.equal(rec.state, 'integrated');
    ctl.rule = onlyStatus(fault); const cl = await w.mgr.cleanup(rec.id); assert.equal(cl.ok, false); assert.equal(cl.status, 409); assert.match(cl.error, /nada foi removido/);
    assert.equal(fs.existsSync(rec.path), true); assert.equal(GX(w.repo, 'branch', '--list', rec.branch) !== '', true); assert.equal(rec.state, 'integrated'); assert.equal(rec.op, null);
    // com o Git respondendo de novo, a mesma limpeza funciona (o bloqueio era só a dúvida)
    ctl.rule = null; const ok = await w.mgr.cleanup(rec.id); assert.equal(ok.ok, true, ok.error); assert.equal(fs.existsSync(rec.path), false);
  });
}

test('I3 — reutilização: com o estado do candidato desconhecido o worktree NÃO é reaproveitado nem substituído; com o Git normal, é reaproveitado', async () => {
  for (const [name, fault] of Object.entries(STATUS_FAULTS)) {
    const ctl = injector(), w = world({ ctl }), rec = (await w.mgr.create({ mission: w.m, workspace: w.ws })).record;
    ctl.rule = onlyStatus(fault); const e = await w.mgr.ensureFor(w.m, w.ws);
    assert.equal(e.ok, false, name); assert.equal(e.status, 409); assert.match(e.error, /não reaproveitado/); assert.equal(w.db.worktrees.length, 1, 'nenhum ambiente novo foi criado'); assert.equal(rec.state, 'ready');
    ctl.rule = null; const ok = await w.mgr.ensureFor(w.m, w.ws); assert.equal(ok.ok, true); assert.equal(ok.created, false); assert.equal(ok.record.id, rec.id);
  }
});

test('I3 — criação com base de estado desconhecido registra "base com alterações" na dúvida (aviso conservador), sem bloquear', async () => {
  const ctl = injector(), w = world({ ctl }); ctl.rule = onlyStatus(TIMEOUT);
  const r = await w.mgr.create({ mission: w.m, workspace: w.ws }); assert.equal(r.ok, true, r.error); assert.equal(r.record.baseDirty, true);
});

test('I3 — o Git falha DEPOIS do merge: o estado do destino não é comprovado => "inconsistent" (nunca "integrado" por suposição) e a recuperação explícita confirma pelo Git', async () => {
  const ctl = injector(), w = world({ ctl }), rec = await ready(w); await w.mgr.snapshot(rec.id); const c = await mergeable(w, rec.id), head = w.head();
  let merged = false; ctl.rule = (a) => { if (a[0] === 'merge') merged = true; return merged && a[0] === 'status' ? TIMEOUT : null; };
  const i = await w.mgr.integrate(rec.id, { digest: c.digest }); assert.equal(i.ok, false); assert.equal(i.status, 500); assert.equal(rec.state, 'inconsistent'); assert.equal(rec.op, null);
  assert.notEqual(w.head(), head, 'o Git realmente avançou a branch; o registro não presume nada'); assert.match(rec.history.at(-1).reason, /não comprovadas/);
  ctl.rule = null; const r = await w.mgr.revalidate(rec.id); assert.equal(r.recovered, true, JSON.stringify(r.blocked)); assert.equal(rec.state, 'integrated'); assert.equal(rec.integratedCommit, G(w.repo, 'rev-parse', 'HEAD'));
});

// =====================================================================================================================
// I2 — o ciclo do worktree pode estar em pastCycles
// =====================================================================================================================
const moveToPast = (w) => { const old = w.m.cycle; w.m.pastCycles = [old]; w.m.cycle = { id: `cyc_novo${w.m.id}`, status: 'running', rounds: [], worktreeId: 'wt_00000000' }; return old; };

test('I2 — integração VÁLIDA cujo ciclo foi movido para pastCycles: checa, integra e continua exigindo digest, checagem registrada e evidência', async () => {
  const w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); const old = moveToPast(w);
  const c = await mergeable(w, rec.id); assert.equal(c.result, 'mergeable', JSON.stringify(c.problems)); assert.equal(c.evidence.match, true);
  const bad = await w.mgr.integrate(rec.id, { digest: 'f'.repeat(32) }); assert.equal(bad.ok, false); assert.match(bad.error, /autorização não corresponde/); assert.equal(rec.state, 'finished');
  const i = await w.mgr.integrate(rec.id, { digest: c.digest }); assert.equal(i.ok, true, i.error); assert.equal(rec.state, 'integrated'); assert.equal(w.m.pastCycles[0], old); assert.equal(w.m.cycle.status, 'running', 'o ciclo novo não foi tocado');
  // evidência continua valendo: conteúdo que muda depois da rodada verificada
  const w2 = world(), r2 = await ready(w2); await w2.mgr.snapshot(r2.id); moveToPast(w2); wr(r2.path, 'tarde.txt', 'x\n'); // o ciclo ativo novo impede snapshot: o conteúdo mudou sem nova evidência
  const c2 = await mergeable(w2, r2.id); assert.equal(c2.result, 'invalid'); assert.ok(codes(c2).includes('evidence_stale'));
  // sem checagem registrada com o digest, mesmo correto
  const w3 = world(), r3 = await ready(w3); await w3.mgr.snapshot(r3.id); moveToPast(w3); const c3 = await mergeable(w3, r3.id); r3.attempts = r3.attempts.filter((x) => x.kind !== 'check');
  const i3 = await w3.mgr.integrate(r3.id, { digest: c3.digest }); assert.equal(i3.ok, false); assert.match(i3.error, /não há checagem registrada/);
});

test('I2 — recusas preservadas: ciclo de OUTRA missão, inexistente, id parecido, que declara outro worktree, não concluído ou não verificado', async () => {
  const problemsOf = async (w, rec) => codes(await mergeable(w, rec.id));
  // outra missão: o ciclo existe, mas na pastCycles de uma missão diferente
  let w = world(), rec = await ready(w); await w.mgr.snapshot(rec.id); let old = moveToPast(w); w.m.pastCycles = [];
  w.db.missions.push({ id: 'm_outra', workspaceId: w.ws.id, tasks: [], cycle: { id: 'cyc_outra', status: 'completed', assurance: 'verified' }, pastCycles: [old] });
  assert.ok((await problemsOf(w, rec)).includes('cycle_missing'), 'outra missão');
  // inexistente
  w = world(); rec = await ready(w); await w.mgr.snapshot(rec.id); old = moveToPast(w); w.m.pastCycles = []; assert.ok((await problemsOf(w, rec)).includes('cycle_missing'), 'inexistente');
  w = world(); rec = await ready(w); await w.mgr.snapshot(rec.id); w.m.cycle = undefined; assert.ok((await problemsOf(w, rec)).includes('cycle_missing'), 'missão sem ciclo');
  // id parecido (prefixo/sufixo), nunca por semelhança
  w = world(); rec = await ready(w); await w.mgr.snapshot(rec.id); old = moveToPast(w); w.m.pastCycles = [{ ...old, id: `${old.id}x` }, { ...old, id: old.id.slice(0, -1) }];
  assert.ok((await problemsOf(w, rec)).includes('cycle_missing'), 'id parecido');
  // o ciclo anterior declara OUTRO worktree
  w = world(); rec = await ready(w); await w.mgr.snapshot(rec.id); old = moveToPast(w); old.worktreeId = 'wt_ffffffff'; assert.ok((await problemsOf(w, rec)).includes('cycle_missing'), 'ciclo de outro worktree');
  // ciclo antigo não verificado ou não concluído
  for (const [field, value] of [['assurance', 'unverified'], ['assurance', undefined], ['status', 'blocked'], ['status', 'cancelled'], ['status', 'running']]) {
    w = world(); rec = await ready(w); await w.mgr.snapshot(rec.id); old = moveToPast(w); old[field] = value;
    const p = await problemsOf(w, rec); assert.ok(p.includes('cycle_not_verified'), `${field}=${value}`); assert.ok(!p.includes('cycle_missing'));
    const i = await w.mgr.integrate(rec.id, { digest: (await w.mgr.check(rec.id)).attempt.digest ?? 'a'.repeat(32) }); assert.equal(i.ok, false); assert.equal(rec.state, 'finished'); assert.equal(w.head(), G(w.repo, 'rev-parse', 'main'));
  }
});

// =====================================================================================================================
// I4 — o worktree é um checkout frio: verificação só roda com ambiente preparado de forma explícita
// =====================================================================================================================
const pkg = (extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', private: true, scripts: { test: 'node --test' }, ...extra }, null, 2);
const dep = (dir, name) => wr(dir, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));

test('I4 — environmentFor: sem dependências OK; com dependências só se o node_modules PRÓPRIO do worktree tem todas; senão recusa com instrução, sem copiar nada', async () => {
  const w = world(), rec = await ready(w), e = () => w.mgr.environmentFor(rec.id);
  assert.deepEqual([e().ok, e().code], [true, 'no_package']); wr(rec.path, 'package.json', pkg()); assert.deepEqual([e().ok, e().code], [true, 'no_dependencies']);
  wr(rec.path, 'package.json', pkg({ devDependencies: { 'dep-a': '1.0.0', '@esc/dep-b': '1.0.0' } }));
  let r = e(); assert.equal(r.ok, false); assert.equal(r.code, 'dependencies_not_prepared'); assert.ok(r.reason.includes(rec.path) && /npm ci/.test(r.reason) && /Nada foi copiado/.test(r.reason), r.reason);
  dep(rec.path, 'dep-a'); r = e(); assert.equal(r.code, 'dependencies_incomplete'); assert.match(r.reason, /@esc\/dep-b/);
  dep(rec.path, '@esc/dep-b'); assert.deepEqual([e().ok, e().code], [true, 'prepared']);
  // node_modules que é um LINK (para o principal ou para qualquer lugar) nunca é aceito
  const alvo = path.join(tmp, `alvo${n}`); fs.mkdirSync(path.join(alvo, 'dep-a'), { recursive: true }); fs.mkdirSync(path.join(alvo, '@esc', 'dep-b'), { recursive: true }); wr(alvo, 'dep-a/package.json', '{}'); wr(alvo, '@esc/dep-b/package.json', '{}');
  fs.rmSync(path.join(rec.path, 'node_modules'), { recursive: true, force: true }); fs.symlinkSync(alvo, path.join(rec.path, 'node_modules'), 'junction');
  r = e(); assert.equal(r.ok, false); assert.equal(r.code, 'node_modules_not_isolated'); fs.rmSync(path.join(rec.path, 'node_modules'), { force: true, recursive: false }); assert.equal(fs.existsSync(alvo), true, 'o alvo do link não foi apagado');
  // nome de dependência malicioso nunca vira caminho
  wr(rec.path, 'package.json', pkg({ dependencies: { '../fora': '1.0.0' } })); r = e(); assert.equal(r.ok, false); assert.equal(r.code, 'package_invalid');
  assert.equal(w.mgr.environmentFor('wt_inexistente').ok, false);
});

test('I4 — o node_modules do workspace PRINCIPAL nunca é copiado nem usado: o worktree frio continua recusado', async () => {
  const w = world(); wr(w.repo, '.gitignore', 'node_modules/\n'); wr(w.repo, 'package.json', pkg({ devDependencies: { 'dep-a': '1.0.0' } })); G(w.repo, 'add', '-A'); G(w.repo, 'commit', '-q', '-m', 'pkg');
  dep(w.repo, 'dep-a'); // instalado e IGNORADO no principal
  const rec = await ready(w), before = fs.readdirSync(path.join(w.repo, 'node_modules')).sort();
  assert.equal(fs.existsSync(path.join(rec.path, 'node_modules')), false, 'arquivos ignorados não acompanham o worktree');
  const r = w.mgr.environmentFor(rec.id); assert.equal(r.ok, false); assert.equal(r.code, 'dependencies_not_prepared'); assert.equal(fs.existsSync(path.join(rec.path, 'node_modules')), false, 'nada foi copiado');
  assert.deepEqual(fs.readdirSync(path.join(w.repo, 'node_modules')).sort(), before);
});

// ----- no ciclo real (executor = CLI falsa; Planner e verificador SIMULADOS): a recusa vira verificação "blocked", nunca "pass", e nada roda no principal -----
const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
const mgrC = W.createWorktreeManager({ db, root: path.join(tmp, 'wtsC') });
const { startTaskRun } = setupExecution(express(), { db, executor, workspaceOf: (m) => mgrC.workspaceFor(m) });
let seq = 0, verCalls = [];
function repoC({ deps = true } = {}) {
  const dir = path.join(tmp, `c${++seq}`); fs.mkdirSync(dir); G(dir, 'init', '-q', '-b', 'main'); G(dir, 'config', 'core.autocrlf', 'false');
  wr(dir, 'base.txt', 'base\n'); wr(dir, '.gitignore', 'node_modules/\n'); wr(dir, 'package.json', pkg(deps ? { devDependencies: { 'dep-a': '1.0.0' } } : {})); G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'base');
  const ws = { id: `cws${seq}`, name: `cws${seq}`, path: dir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] };
  db.workspaces.push(ws); const m = { id: `cm${seq}`, demo: false, title: `M${seq}`, objective: 'obj', workspaceId: ws.id, createdAt: 'T0', tasks: [] }; db.missions.push(m);
  return { dir, ws, m, status: () => G(dir, 'status', '--porcelain', '-uall') };
}
const J = (o) => JSON.stringify(o);
const planner = (answers) => ({ calls: [], busy: () => false, cancel: async () => {}, describeTier: () => null, decide: async () => { const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1 } }; } });
const step = (id, file) => ({ id, title: `Etapa ${id}`, instructions: `MODE:produce FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: [] });
const planAns = (...steps) => J({ decision: 'plan', rationale: 'dividir', steps });
const done = () => J({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (ws, item) => { verCalls.push(ws.path); return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null }; } });
const mkCycle = (pl, { isolation = true } = {}) => createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true, stepRetries: 0, worktrees: mgrC, worktreeIsolation: isolation, persistRetryMs: [1] });

test('I4 — no ciclo isolado, projeto com dependências e worktree frio: a verificação é RECUSADA (blocked), o verificador nem roda e nada vai ao principal; preparado o ambiente, a retomada verifica no worktree', async () => {
  const r = repoC(), head = G(r.dir, 'rev-parse', 'HEAD'); verCalls = [];
  const cy = mkCycle(planner([planAns(step('a', 'a.txt')), done()])); assert.equal((await cy.start(r.m.id, 6)).status, 202); await cy.idle();
  const c = r.m.cycle, rec = mgrC.get(c.worktreeId); assert.ok(rec);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked', `${c.blockedCode}: ${c.blockedReason}`); assert.notEqual(c.assurance, 'verified');
  const v = c.rounds[0].report.verifications; assert.equal(v.length, 1); assert.equal(v[0].status, 'blocked'); assert.equal(v[0].source, 'backend'); assert.match(v[0].reason, /Ambiente do worktree não preparado/); assert.equal(v[0].code, 'dependencies_not_prepared', 'a interface decide pelo código, não pelo texto'); assert.match(v[0].reason, /npm ci/);
  assert.equal(v[0].exitCode, null); assert.notEqual(v[0].status, 'pass'); assert.deepEqual(verCalls, [], 'o verificador (nem o simulado) foi chamado: nada foi "verificado"');
  assert.equal(fs.existsSync(path.join(r.dir, 'a.txt')), false); assert.equal(r.status(), ''); assert.equal(G(r.dir, 'rev-parse', 'HEAD'), head); assert.equal(fs.existsSync(path.join(rec.path, 'node_modules')), false);
  const chk = await mgrC.check(rec.id); assert.notEqual(chk.attempt.result, 'mergeable', 'sem verificação real não há integração');
  // preparação EXPLÍCITA (feita por um humano fora do orquestrador; aqui simulada com arquivos locais, sem rede) e retomada
  dep(rec.path, 'dep-a'); assert.equal(mgrC.environmentFor(rec.id).ok, true);
  const cy2 = mkCycle(planner([done()])); const res = await cy2.resume(r.m.id); assert.equal(res.status, 202, JSON.stringify(res)); await cy2.idle();
  assert.ok(verCalls.length >= 1); assert.deepEqual([...new Set(verCalls)], [rec.path], 'a verificação rodou NO worktree preparado, nunca no principal'); assert.equal(r.status(), '');
});

test('I4 — modo SEM isolamento preservado (verifica no workspace principal, sem a exigência de ambiente) e worktree sem dependências declaradas verifica normalmente', async () => {
  const off = repoC(); verCalls = [];
  const cy = mkCycle(planner([planAns(step('a', 'a.txt')), done()]), { isolation: false }); assert.equal((await cy.start(off.m.id, 6)).status, 202); await cy.idle();
  assert.equal(off.m.cycle.status, 'completed', `${off.m.cycle.blockedCode}: ${off.m.cycle.blockedReason}`); assert.equal('worktreeId' in off.m.cycle, false); assert.deepEqual([...new Set(verCalls)], [off.dir]);
  const lean = repoC({ deps: false }); verCalls = [];
  const cy2 = mkCycle(planner([planAns(step('a', 'a.txt')), done()])); assert.equal((await cy2.start(lean.m.id, 6)).status, 202); await cy2.idle();
  const rec = mgrC.get(lean.m.cycle.worktreeId); assert.equal(lean.m.cycle.status, 'completed', `${lean.m.cycle.blockedCode}: ${lean.m.cycle.blockedReason}`); assert.deepEqual([...new Set(verCalls)], [rec.path]);
});
