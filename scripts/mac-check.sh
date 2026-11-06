#!/usr/bin/env bash
# Diagnostico para o macOS: investiga por que 3 testes de arvore de processos falham no Mac e (opcional) devolve o relatorio pelo GitHub.
#   bash scripts/mac-check.sh             roda o diagnostico e mostra o resumo
#   bash scripts/mac-check.sh --suite     tambem roda a suite completa (alguns minutos)
#   bash scripts/mac-check.sh --enviar    envia o relatorio para a branch mac-report-<data-hora> (so se nao houver alteracoes rastreadas)
# Somente leitura no projeto: usa ORCH_DATA_DIR temporario, so encerra processos que o proprio script criou e nao toca em dados reais.
# Compativel com o bash 3.2 do macOS.
set -u
cd "$(dirname "$0")/.." || exit 1

ENVIAR=0; SUITE=0
for a in "$@"; do
  case "$a" in
    --enviar) ENVIAR=1 ;;
    --suite) SUITE=1 ;;
    *) echo "opcao desconhecida: $a"; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M)"
# Pastas temporarias proprias (relatorio e dados de teste). SEM elas o script nao roda: com ORCH_DATA_DIR vazio os testes usariam o data/ real.
WORK="$(mktemp -d -t forge-mac-XXXXXX 2>/dev/null)"
DATA="$(mktemp -d -t orch-mac-XXXXXX 2>/dev/null)"
if [ -z "$WORK" ] || [ -z "$DATA" ] || [ ! -d "$WORK" ] || [ ! -d "$DATA" ]; then
  echo "ERRO: nao consegui criar as pastas temporarias (mktemp). Nada foi executado."; exit 3
fi
export ORCH_DATA_DIR="$DATA"
REPORT="$WORK/relatorio-$STAMP.txt"
cleanup() { [ -n "${DATA:-}" ] && [ -d "$DATA" ] && rm -rf "$DATA"; [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
sec() { log ""; log "=== $*"; }

sec "Ambiente"
log "macOS: $(sw_vers -productVersion 2>/dev/null)  arquitetura: $(uname -m)"
log "node: $(node -v 2>/dev/null)  em: $(command -v node)"
log "git: $(git log --oneline -1)  branch: $(git branch --show-current)"
log "alteracoes rastreadas: $(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"

sec "A. ps no terminal"
PS_LINES="$(ps -A -o pid=,ppid= 2>&1 | wc -l | tr -d ' ')"
log "linhas de 'ps -A -o pid=,ppid=': $PS_LINES"
ps -A -o pid=,ppid= 2>&1 | head -3 | while IFS= read -r l; do log "  $l"; done

sec "B. ps visto pelo node"
node -e "
const { execFileSync } = require('child_process');
try {
  const o = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  console.log('linhas pelo node:', o.trim().split('\n').length);
  console.log('amostra:', JSON.stringify(o.split('\n').slice(0, 2)));
} catch (e) { console.log('ERRO do ps no node:', e.code || e.message); }
" 2>&1 | tee -a "$REPORT"

sec "C. Experimento direto: pai -> neto e descendantsOf"
node --input-type=module -e "
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { descendantsOf } = await import(pathToFileURL(process.cwd() + '/server/orphans.js').href);
const SLEEP = 'setInterval(() => {}, 1000)';
const code = \"const g = require('child_process').spawn(process.execPath, ['-e', '\" + SLEEP + \"'], { stdio: 'ignore' }); console.log(g.pid); \" + SLEEP;
const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
const grand = await new Promise((r) => parent.stdout.once('data', (d) => r(Number(String(d).trim()))));
const got = descendantsOf(parent.pid);
console.log('pai:', parent.pid, ' neto (esperado):', grand);
console.log('descendantsOf(pai) devolveu:', JSON.stringify(got), got.length === 1 && got[0] === grand ? ' -> OK' : ' -> DIFERENTE do esperado');
try { console.log(execFileSync('ps', ['-o', 'pid,ppid,stat,command', '-p', parent.pid + ',' + grand], { encoding: 'utf8' }).trim()); } catch (e) { console.log('ps -p falhou:', e.message); }
try {
  const all = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n');
  console.log('linhas do ps com pai/neto:', JSON.stringify(all.filter((l) => new RegExp('^\\\\s*(' + parent.pid + '|' + grand + ')\\\\s').test(l) || new RegExp('\\\\s' + parent.pid + '\\\\s*\$').test(l))));
} catch (e) { console.log('ps -A falhou:', e.message); }
for (const p of [grand, parent.pid]) { try { process.kill(p, 'SIGKILL'); } catch {} }
" 2>&1 | tee -a "$REPORT"

run_tests() { # $1 = rotulo; $2... = arquivos
  local label="$1"; shift
  local out="$WORK/test-$label.txt"
  node --test "$@" >"$out" 2>&1
  log "-- $label: $(grep -E '^ℹ (tests|pass|fail|cancelled|skipped) ' "$out" | tr '\n' ' ')"
  if grep -qE '^\s*✖' "$out"; then
    log "   FALHARAM:"
    grep -E '^\s*✖' "$out" | sort -u | head -8 | while IFS= read -r l; do log "     $l"; done
    log "   detalhes (esperado/atual):"
    grep -E -A8 'AssertionError|expected|actual' "$out" | head -50 | while IFS= read -r l; do log "     $l"; done
  fi
}

sec "D. Testes que falharam, sozinhos (2 rodadas)"
run_tests rodada1 server/test/posix-process.test.mjs server/test/orphans.test.mjs
run_tests rodada2 server/test/posix-process.test.mjs server/test/orphans.test.mjs

if [ "$SUITE" = 1 ]; then
  sec "E. Suite completa (alguns minutos)"
  node --test server/test/*.test.mjs >"$WORK/suite.txt" 2>&1
  log "$(grep -E '^ℹ (tests|pass|fail|cancelled|skipped) ' "$WORK/suite.txt" | tr '\n' ' ')"
  grep -E '^\s*✖' "$WORK/suite.txt" | sort -u | head -12 | while IFS= read -r l; do log "   $l"; done
fi

sec "RESUMO"
log "ps: $PS_LINES linhas | veja as secoes C e D acima"

if [ "$ENVIAR" = 1 ]; then
  sec "Enviando o relatorio"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "NAO enviei: ha alteracoes em arquivos rastreados (git status). Guarde com 'git stash' e rode de novo."
  else
    ORIG="$(git branch --show-current)"; BR="mac-report-$STAMP"
    if git switch -c "$BR" >/dev/null 2>&1; then
      mkdir -p mac-report && cp "$REPORT" "mac-report/relatorio-$STAMP.txt"
      if git add mac-report && git commit -q -m "chore: relatorio de validacao do macOS ($STAMP)" && git push -q -u origin "$BR"; then
        echo "ENVIADO: origin/$BR"
      else
        echo "FALHA ao commitar/enviar o relatorio (o relatorio completo esta acima na tela)"
      fi
      git switch "$ORIG" >/dev/null 2>&1
    else
      echo "FALHA ao criar a branch $BR"
    fi
  fi
fi

echo ""
echo "Pronto. Se nao usou --enviar, me diga so a secao RESUMO e as linhas 'FALHARAM' acima."
