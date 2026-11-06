# AI Dev Orchestrator

Central local para coordenar agentes de IA em desenvolvimento de software. Responda em português do Brasil. Este arquivo vale só para este repositório; a coordenação geral da equipe de agentes (níveis de risco, quando delegar, registro de uso) está no `~/.claude/CLAUDE.md` e não é repetida aqui.

## Estrutura
- `server/` — API Node (ESM, Express 4, única dependência de runtime). `index.js` (rotas e boot), `cycle.js` (ciclo autônomo da missão), `delivery.js` (relatório de entrega), `store.js` (persistência em JSON), `executor/` (CLIs dos agentes como processos filhos), `policy.js`, `verify.js`, `evidence.js`, `workspaces.js`, `instance-lock.js`, `orphans.js`.
- `client/` — interface React 18 + Vite + Three.js. Não tem testes próprios; a lógica de `client/src/*.js` é testada a partir de `server/test/`.
- `server/test/*.test.mjs` — testes com `node:test`; `fake-cli.mjs` simula o agente; `server/test/manual/` são scripts manuais com o Claude real.
- `data/` — banco real do usuário (`db.json`) e travas. `client/dist` — build servido pelo servidor.

## Comandos (confirmados no `package.json`)
- `npm test` = `node --test server/test/*.test.mjs` (a suíte completa leva alguns minutos).
- Um arquivo: `node --test server/test/<arquivo>.test.mjs`; um teste: acrescente `--test-name-pattern="trecho do nome"`.
- `npm run server` sobe a API em `127.0.0.1:4317` (somente loopback) **com o banco real**. `npm run build` e `npm start` reescrevem `client/dist`.
- `npm run dev` (`concurrently`) sobe `npm run server` (API em `127.0.0.1:4317`, **com o banco real**) e `npm run client` (Vite) ao mesmo tempo; não o use onde já há servidor na 4317 nem para testar.
- `npm run test:real` e `npm run test:real-cycle` chamam o Claude de verdade e consomem créditos.

## Restrições operacionais (não faça sem autorização explícita do usuário)
- Não toque em `data/db.json` nem em `client/dist`. Não reinicie nem encerre o servidor da porta 4317 (pode estar em uso).
- Não rode `test:real*`, missões reais nem integrações com efeitos externos. Não faça commit, push ou deploy.
- Não instale dependências. Não leia nem exiba `.env` ou credenciais.

## Como testar com segurança
O `store.js` usa `data/` quando `ORCH_DATA_DIR` não está definido, e cerca de 20 arquivos de teste não o definem sozinhos. **Sempre aponte `ORCH_DATA_DIR` para um diretório temporário vazio antes de rodar a suíte completa**, e remova-o depois:
- bash: `export ORCH_DATA_DIR="$(mktemp -d -t orch-suite-XXXX)"; npm test`
- PowerShell: `$env:ORCH_DATA_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP "orch-suite-$(Get-Random)")).FullName; npm test`

Os testes que sobem o servidor usam porta e diretório próprios e não dependem da 4317. Teste com workspaces, bancos e portas temporários; limpe o que criar (existem diretórios `orch-*` residuais no temporário do sistema; não apague os que não forem seus). Não enfraqueça nem remova testes existentes para fazer algo passar; relate o defeito.

## Convenções
- ESM; strings e mensagens ao usuário em português; comentários curtos explicando o porquê.
- Contratos novos (rotas, campos de ciclo ou de relatório) vêm com testes em `server/test/`. O gate de conclusão é estrito: conclusão só com evidência `verified`; a exceção é a aceitação humana explícita e auditável, nunca automática.
- Falha de persistência deve desfazer o estado parcial (padrão `saveOrThrow` + rollback).

## Delegação neste projeto
- Responsabilidade: `server/` → `backend-developer`; `client/` → `frontend-developer`. Em mudanças nas duas camadas, fixe o contrato da API antes e dê a cada agente arquivos disjuntos.
- Superfícies sensíveis, que justificam `security-reviewer` além da revisão normal: aprovações e aceitação (`cycle.js`, `policy.js`), execução de processos (`executor/`, `verify.js`, `orphans.js`), arquivos e caminhos (`workspaces.js`, `evidence.js`), persistência e travas (`store.js`, `instance-lock.js`), rotas e checagem de origem (`index.js`).
- Mudança no ciclo, no gate de conclusão ou em contratos do relatório de entrega é de nível alto: prefira `code-reviewer` e testes direcionados antes da suíte completa.
- Ajustes localizados (um ou dois arquivos, sem contrato nem superfície sensível) são feitos direto, sem agentes.
- **Ao delegar, repasse no prompt de cada agente** as restrições operacionais relevantes deste arquivo (não reiniciar o servidor da 4317; não tocar `data/db.json` nem `client/dist`; não rodar `test:real*` nem missões reais; não fazer commit, push ou deploy), o uso de `ORCH_DATA_DIR` temporário em qualquer teste e a proibição de acessar dados reais sem autorização explícita do usuário.
