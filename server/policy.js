// Política de execução e aprovações (M9). Regras PURAS e centralizadas: nada aqui executa processos, grava o banco nem confia em quem pediu a ação.
//
// O que o sistema realmente faz (e, portanto, o que a política classifica): o Executor só LÊ, CRIA e EDITA arquivos dentro do workspace (Read, Edit, Write, Glob, Grep;
// sem shell, rede, instalação, exclusão, commit ou deploy) e o orquestrador roda scripts de verificação já aprovados por um humano (verify.js: aprovação ligada ao hash
// do script; é o controle existente para "executar comandos" e não é duplicado aqui).
//
// Decisões, da menos para a mais restritiva (a pior vence):
//   allow             : ler/criar/editar arquivos comuns do workspace.
//   approval_required : alteração de arquivos que mudam o que o projeto instala ou executa (manifestos, CI, Docker, hooks), arquivos de segredos, sobrescrita integral.
//   deny              : o que o Executor NÃO tem como fazer (shell, instalar, publicar, commit/push, excluir, rede), caminhos fora do workspace, .git e o estado do orquestrador.
//
// Limite honesto: a política avalia o ESCOPO DECLARADO da etapa (título, instruções, critérios e expectedFiles), não cada chamada de ferramenta do Executor durante a
// execução (a CLI não oferece esse gancho aqui). As regras de texto são heurísticas de aviso antecipado; a barreira real contra shell/rede/exclusão é a lista fixa de
// ferramentas do Executor (executor/index.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeRelPath } from './evidence.js';

export const POLICY_VERSION = 1;
export const DECISIONS = ['allow', 'approval_required', 'deny'];
const RANK = { allow: 0, approval_required: 1, deny: 2 };
const clip = (s, n) => String(s ?? '').slice(0, n);

const SECRET_FILE = /(^|\/)(\.env(\.[^/]+)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[a-z]+)?|secrets?\.(json|ya?ml|toml|env)|[^/]+\.(pem|key|pfx|p12|keystore|jks))$/i;
const SECRET_EXAMPLE = /\.(example|sample|template|dist)$/i; // .env.example documenta variáveis, não guarda valores
const SENSITIVE_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|Pipfile|go\.mod|Cargo\.toml|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.gitlab-ci\.yml|\.gitmodules)$|(^|\/)(\.github|\.husky|\.claude|\.circleci)\//i;
/** Para o controle de escopo (scope.js): o mesmo critério da política decide o que é segredo e o que é sensível. */
export const isSecretPath = (rel) => SECRET_FILE.test(rel) && !SECRET_EXAMPLE.test(rel);
export const isSensitivePath = (rel) => SENSITIVE_FILE.test(rel);
const OUTSIDE_TEXT = /(^|[\s"'`(=])(?:[A-Za-z]:\/|\/\/|~\/|(?:\.\.\/)+|\/(?:etc|usr|var|home|root|bin|sbin|opt|tmp|Users|mnt|proc|sys|private|Library|Applications|System|Volumes)\b|%[A-Za-z_]+%|\$\{?(?:HOME|USERPROFILE)\b)/;
// Sem distinção de caixa (Windows/macOS) e com pontos/espaços finais (`.git.`, `.git /x`, equivalentes a `.git` no Windows). `.github`, `.gitignore` etc. não casam: depois de `.git` só entram [. ] e então / espaço, aspas, `)` ou fim.
const GIT_DIR_TEXT = /(^|[\s"'`(/=:,;[{|&<>])\.git[. ]*(\/|\s|$|["'`),;:?!\]}|&<>])/i; // delimitadores de texto livre: `--git-dir=.git/hooks`, `.git,`, `.git;`, `.git&&ls`
const STATE_TEXT = /(^|[\s"'`/])db\.json(\.(tmp|bak))?\b/i;
// Sobrescrita destrutiva: o ALVO precisa ser o conteúdo/arquivo inteiro. Verbos genéricos sozinhos ("substituir todo o texto X por Y", "limpar a lista") não contam.
const OVERWRITE_PATTERNS = [
  /\b(?:sobrescrev\w*|overwrit\w*)\b/i,
  /\breescrev\w*\s+(?:do\s+zero|por\s+completo|inteiramente|tudo|(?:o|a)\s+(?:arquivo|file)\s+(?:todo|inteir[oa]|por\s+completo))\b/i,
  /\bsubstitu\w*\s+(?:todo\s+(?:o\s+)?conte[uú]do|(?:o|a)\s+(?:arquivo|file)\s+(?:todo|inteir[oa]|por\s+completo|completamente)|(?:todo|inteiramente|completamente|por\s+completo)\b[^.\n]{0,20}\b(?:conte[uú]do|arquivo|file)\b)/i,
  /\b(?:rewrite|replace)\s+(?:the\s+)?(?:whole|entire|complete)\s+(?:file|content)s?\b|\brewrite\s+(?:from\s+scratch|entirely)\b/i,
  /\b(?:apag\w*|limp\w*|esvazi\w*|clear\w*|empty|wipe\w*)\s+(?:completamente\s+|por\s+completo\s+)?(?:o\s+|todo\s+o\s+|the\s+(?:whole\s+)?)?(?:conte[uú]do|content)\b/i,
];

// Contexto de uma menção a arquivo sensível. Por ORAÇÃO (separada por . ; , quebra de linha, "mas"/"porém"): só conta como alteração se houver um verbo de ESCRITA não negado e o
// arquivo não aparecer como FONTE de leitura ("conforme o package.json", "definido no package.json"). Negação antes do arquivo ("não altere", "sem tocar no") anula a menção.
// Os arquivos declarados em expectedFiles (o escopo de escrita da etapa) sempre contam. Segredos são mais estritos: ler também conta, só a negação anula.
const WRITE_VERB = /\b(?:alter\w*|edit\w*|modific\w*|atualiz\w*|adicion\w*|inclu\w*|insir\w*|cri(?:e|ar|ando|ad[oa]s?)|escrev\w*|grav\w*|remov\w*|renome\w*|troc\w*|mud(?:e|ar|ando|ad[oa]s?)|ajust\w*|configur\w*|defin(?:a|ir|indo)|reescrev\w*|sobrescrev\w*|substitu\w*|corrij\w*|corrig\w*|acrescent\w*|incremen\w*|bump\w*|upgrad\w*|updat\w*|chang\w*|add(?:ing|ed)?|modif\w*|writ\w*|creat\w*|append\w*|renam\w*|fix\w*|patch\w*|rewrit\w*|overwrit\w*)\b/gi;
const NEG_CTX = /\b(?:n[aã]o|nunca|jamais|sem|evite|evitar|proibid\w*|exceto|never|don'?t|do\s+not|without|avoid|except)\b/i;
const READ_CTX = /(?:conforme|de\s+acordo\s+com|segundo|com\s+base\s+(?:em|no|na|nos|nas)|baseand[oa]-se\s+em|a\s+partir\s+(?:d[oae]s?|de)|usando|lendo|consultando|(?:definid|descrit|declarad|listad|presente|existente|configurad)[oa]s?\s+(?:no|na|em)|according\s+to|based\s+on|as\s+defined\s+in|defined\s+in|listed\s+in)\s+(?:(?:o|a|os|as|no|na|nos|nas|do|da|dos|das)\s+)*$/i;
const CLAUSE_SPLIT = /\.(?=\s|$)|[;!?\n,]|\b(?:mas|por[eé]m|entretanto|but)\b/i; // o ponto só separa oração quando é final ("package.json" não é separado)
const clausesOf = (text) => text.split(CLAUSE_SPLIT).filter((c) => c && c.trim());
/** Há um verbo de escrita NÃO negado na oração? */
const writes = (clause) => [...clause.matchAll(WRITE_VERB)].some((v) => !NEG_CTX.test(clause.slice(0, v.index)));

// Capacidades que o Executor NÃO tem: pedir isso é pedir o impossível, e "aprovar" seria simular uma proteção. Cada item: [rótulo, regex].
const UNSUPPORTED = [
  ['instalar dependências', /\b(?:npm|pnpm|yarn|bun|pip3?|poetry|cargo)\s+(?:install|add|i|ci)\b|\binstal(?:e|ar|ação|acao)\b[^.\n]{0,30}\b(?:depend[eê]ncias?|pacotes?|packages?|dependencies)\b/i],
  ['publicar, fazer deploy, commit ou push', /\bgit\s+(?:push|commit|reset|clean|rebase|merge|checkout|stash)\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bkubectl\b|\bterraform\s+apply\b|\b(?:fazer|realizar|executar|rodar)\s+(?:o\s+|um\s+)?(?:deploy|commit|push)\b|\bdeploy(?:ar)?\s+(?:em|para|na|no)\b|\bpublicar\b[^.\n]{0,30}\b(?:site|app|pacote|package|produ[cç][aã]o)\b|\bpublish\b/i],
  ['executar comandos de shell', /\b(?:execut(?:e|ar)|rod(?:e|ar)|run)\b[^.\n]{0,30}\b(?:comandos?|commands?|shell|terminal|bash|powershell|cmd)\b|\b(?:curl|wget|sudo|Invoke-WebRequest|Remove-Item)\b|\brm\s+-[a-z]*[rf]|\brmdir\b|\bdel\s+\//i],
  ['acessar a rede', /\b(?:baix(?:ar|e)|download|acessar|acesse|fetch)\b[^.\n]{0,60}https?:\/\//i],
  ['excluir arquivos ou pastas', /\b(?:apag(?:ar|ue|ando)|exclu(?:ir|a|indo)|delet(?:ar|e)|deleting)\b[^.\n]{0,25}\b(?:arquivos?|pastas?|diret[oó]rios?|files?|folders?|director(?:y|ies))\b/i],
];
const NEGATION = /\b(n[aã]o|nunca|sem|jamais|never|without|don'?t|do not)\b[^.\n]*$/i; // "não faça commit" não é um pedido de commit

const normText = (s) => String(s ?? '').replace(/\\/g, '/');
/** A regex casa em `text` fora de uma negação imediata? */
function asks(re, text) {
  const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  for (const m of text.matchAll(g)) if (!NEGATION.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
  return false;
}

/** @returns {{decision:'allow'|'approval_required'|'deny', rules:object[], summary:{what:string, why:string[], impact:string[]}}} */
export function evaluateTask(action, { workspace = null, protectedDirs = [], exists = null } = {}) {
  const rule = (id, decision, reason, impact, subjects) => ({ id, decision, reason, impact, ...(subjects?.length ? { subjects } : {}) });
  const wsPath = workspace?.path;
  const there = exists ?? ((rel) => { try { return !!wsPath && fs.existsSync(path.join(wsPath, rel)); } catch { return false; } });
  const a = action && typeof action === 'object' ? action : {};
  const strs = [a.title, a.instructions].every((x) => typeof x === 'string') && (a.acceptance ?? []).every?.((x) => typeof x === 'string') && (a.expectedFiles ?? []).every?.((x) => typeof x === 'string');
  const found = [];
  if (!strs || !wsPath) {
    found.push(rule('unclassifiable', 'deny', 'Não foi possível classificar a ação com segurança (dados incompletos ou espaço de trabalho ausente).', 'Nada é executado quando a ação não pode ser avaliada.'));
  } else {
    const text = normText([a.title, a.instructions, ...(a.acceptance ?? [])].join('\n'));
    const files = (a.expectedFiles ?? []).map((p) => ({ raw: p, rel: safeRelPath(p) }));
    const rels = files.filter((f) => f.rel).map((f) => f.rel);
    const clauses = clausesOf(text);
    /** Arquivos que casam com `re` e são realmente alvo: os de expectedFiles + os citados em contexto de escrita (ou, com `anyUse`, citados sem negação). */
    const mentions = (re, extra, anyUse = false) => {
      const out = new Set(rels.filter((p) => re.test(p) && !(extra && extra.test(p))));
      for (const clause of clauses) {
        for (const m of clause.matchAll(/[^\s"'`(),;]+/g)) {
          const t = m[0].replace(/[.:!?]+$/, '').replace(/^\.\//, '');
          if (!re.test(t) || (extra && extra.test(t))) continue;
          if (NEG_CTX.test(clause.slice(0, m.index))) continue;                                  // "não altere X", "sem tocar em X"
          if (!anyUse && (READ_CTX.test(clause.slice(Math.max(0, m.index - 60), m.index)) || !writes(clause))) continue; // só referência/leitura/execução
          out.add(t);
        }
      }
      return [...out];
    };

    // --- deny ---
    const badPaths = files.filter((f) => !f.rel).map((f) => String(f.raw).slice(0, 80));
    if (badPaths.length || OUTSIDE_TEXT.test(text)) found.push(rule('outside_workspace', 'deny', 'A ação referencia um caminho fora do espaço de trabalho (absoluto, "..", unidade, pasta do usuário ou diretório interno do Git).', 'O Executor só pode atuar dentro do espaço de trabalho; nada é executado.', badPaths));
    else if (GIT_DIR_TEXT.test(text)) found.push(rule('git_internal', 'deny', 'A ação mexe na pasta interna do Git (.git).', 'Alterar .git pode corromper o histórico do projeto; nada é executado.'));
    const inState = rels.filter((rel) => protectedDirs.some((d) => { const r = path.relative(d, path.resolve(wsPath, rel)); return !!d && !r.startsWith('..') && !path.isAbsolute(r); }));
    const wsInState = protectedDirs.some((d) => { const r = path.relative(path.resolve(d), path.resolve(wsPath)); return !r.startsWith('..') && !path.isAbsolute(r); });
    if (inState.length || wsInState || STATE_TEXT.test(text)) found.push(rule('orchestrator_state', 'deny', 'A ação alcança o estado interno do orquestrador (banco de dados, aprovações), que o Executor não pode alterar.', 'Permitir isso deixaria o Executor alterar as próprias aprovações; nada é executado.', inState));
    for (const [label, re] of UNSUPPORTED) if (asks(re, text)) found.push(rule('unsupported_capability', 'deny', `A ação pede para ${label}, o que o Executor não faz (ele só lê e edita arquivos dentro do espaço de trabalho).`, 'Não existe como executar nem como aprovar esta ação; o Planner precisa replanejar sem ela.'));

    // --- approval_required ---
    const secrets = mentions(SECRET_FILE, SECRET_EXAMPLE, true);
    if (secrets.length) found.push(rule('secret_files', 'approval_required', 'A etapa lê ou altera arquivos que costumam guardar segredos ou credenciais.', 'O conteúdo desses arquivos pode ser lido pelo Executor (e enviado ao modelo) e alterado. Os valores dos segredos não são gravados na auditoria.', secrets));
    const sensitive = mentions(SENSITIVE_FILE, null, false);
    if (sensitive.length) found.push(rule('sensitive_files', 'approval_required', 'A etapa altera arquivos que definem o que o projeto instala ou executa (dependências, automação, Docker, hooks).', 'Mudar esses arquivos pode alterar dependências, pipelines ou o que roda no projeto.', sensitive));
    if (clauses.some((c) => OVERWRITE_PATTERNS.some((re) => { const m = re.exec(c); return !!m && !NEG_CTX.test(c.slice(0, m.index)); }))) {
      const existing = rels.filter(there);
      found.push(rule('destructive_overwrite', 'approval_required', 'A etapa pede para sobrescrever, esvaziar ou reescrever conteúdo por inteiro.', existing.length ? `O conteúdo atual de ${existing.join(', ')} pode ser perdido (sem Git, não há como desfazer).` : 'Conteúdo existente pode ser perdido (sem Git, não há como desfazer).', existing));
    }
  }
  if (!found.length) found.push(rule('workspace_file_edit', 'allow', 'Ler, criar e editar arquivos comuns dentro do espaço de trabalho.', 'Alterações ficam restritas ao espaço de trabalho e passam pelas verificações reais.'));
  const decision = found.reduce((w, r) => (RANK[r.decision] > RANK[w] ? r.decision : w), 'allow');
  const hit = found.filter((r) => r.decision === decision);
  const files = (Array.isArray(a.expectedFiles) ? a.expectedFiles : []).slice(0, 8);
  return {
    decision, rules: found,
    summary: { what: `Executar a etapa "${clip(a.title, 120)}"${files.length ? ` (arquivos: ${files.join(', ')})` : ''}`, why: hit.map((r) => r.reason), impact: hit.map((r) => `${r.impact}${r.subjects?.length ? ` [${r.subjects.slice(0, 6).join(', ')}]` : ''}`) },
  };
}

/** Impressão digital do que foi apresentado ao humano: ação (texto, arquivos, agente), escopo (etapa/plano), workspace e regras que exigiram a aprovação. Qualquer mudança material gera outro valor. */
export function actionDigest(action, workspace, scope, verdict) {
  const canon = {
    v: POLICY_VERSION, ws: { id: workspace?.id ?? null, path: workspace?.path ?? null }, step: scope?.stepId ?? null, plan: scope?.planId ?? null,
    title: String(action.title ?? '').trim(), instructions: String(action.instructions ?? '').trim(), acceptance: (action.acceptance ?? []).map((x) => String(x).trim()),
    files: [...(action.expectedFiles ?? [])].sort(), agent: action.agent ?? null, rules: verdict.rules.filter((r) => r.decision !== 'allow').map((r) => r.id).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// Autorização prévia (ao aprovar o plano): só para o que uma pessoa PODE conceder por etapa. deny nunca; segredos exigem aprovação individual na hora; qualquer regra desconhecida também não.
const PREAUTH_RULES = ['sensitive_files', 'destructive_overwrite'];
/** @returns {{ok:boolean, reason:string|null}} esta avaliação pode ser pré-autorizada na aprovação do plano? */
export function preAuthProblem(verdict) {
  if (verdict?.decision === 'allow') return { ok: false, reason: 'não precisa de autorização (a política já permite)' };
  if (verdict?.decision !== 'approval_required') return { ok: false, reason: 'é proibida pela política e nunca pode ser autorizada' };
  const ids = (verdict.rules ?? []).filter((r) => r.decision !== 'allow').map((r) => r.id);
  if (ids.includes('secret_files')) return { ok: false, reason: 'lê ou altera arquivos de segredo, que exigem a sua aprovação individual na hora de executar' };
  const other = ids.filter((id) => !PREAUTH_RULES.includes(id));
  if (other.length || !ids.length) return { ok: false, reason: `tem uma regra que não aceita autorização prévia (${other.join(', ') || 'nenhuma regra'})` };
  return { ok: true, reason: null };
}

const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'consumed', 'void'];
/**
 * Consistência entre aprovações e rodadas gravadas (um banco editado, parcial ou corrompido não pode virar execução): toda aprovação "consumida" tem a rodada que a usou e toda
 * rodada que cita uma aprovação a tem consumida por ela. Devolve o motivo ou null.
 */
export function approvalProblem(c) {
  if (c?.approvals === undefined) return (Array.isArray(c?.rounds) ? c.rounds : []).some((r) => r?.approvalId) ? 'há rodada ligada a uma aprovação, mas o ciclo não tem aprovações gravadas' : null;
  if (!Array.isArray(c.approvals)) return 'as aprovações gravadas não têm a estrutura esperada';
  const rounds = Array.isArray(c.rounds) ? c.rounds : [];
  for (const a of c.approvals) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.digest !== 'string' || !APPROVAL_STATUS.includes(a.status)) return 'há uma aprovação gravada com estrutura inválida';
    if (a.origin === 'plan_approval') { // autorização do plano: vários usos limitados; cada rodada que a cita precisa estar registrada nela e vice-versa
      for (const n of Array.isArray(a.consumedRounds) ? a.consumedRounds : []) { const r = rounds.find((x) => x?.n === n); if (!r || r.approvalId !== a.id) return `a autorização do plano ${a.id} consta como usada na rodada ${n}, mas a rodada não a registra: o resultado da ação é incerto`; }
      if (a.status === 'consumed' && !(a.consumedRounds ?? []).length) return `a autorização do plano ${a.id} consta como consumida sem nenhuma rodada`;
    } else if (a.status === 'consumed') {
      const r = rounds.find((x) => x?.n === a.consumedRound);
      if (!r || r.approvalId !== a.id) return `a aprovação ${a.id} consta como consumida, mas a rodada ${a.consumedRound} não a registra: o resultado da ação é incerto`;
    }
  }
  for (const r of rounds) {
    if (!r?.approvalId) continue;
    const a = c.approvals.find((x) => x.id === r.approvalId);
    if (a?.origin === 'plan_approval') { if (!(a.consumedRounds ?? []).includes(r.n) || a.digest !== r.approvalDigest) return `a rodada ${r.n} foi executada com a autorização do plano ${r.approvalId}, mas o registro dessa autorização está ausente ou inconsistente: o resultado da ação é incerto`; continue; }
    if (!a || a.status !== 'consumed' || a.consumedRound !== r.n || a.digest !== r.approvalDigest) return `a rodada ${r.n} foi executada com a aprovação ${r.approvalId}, mas o registro dessa aprovação está ausente ou inconsistente: o resultado da ação é incerto`;
  }
  return null;
}
