# CLAUDE.md

## Projeto: readit

Servidor MCP (stdio) que dá a agentes de IA um navegador local para ler UMA página por vez, a pedido
do usuário, usando o Chromium com o perfil persistente dele (logins, cookies, IP residencial).
Versão "lite" do `~/playwright-orchestrator`: sem fila, sem servidor HTTP, sem Docker, sem monorepo.

## Estrutura

```
src/
  index.ts                 entrypoint: `readit` (MCP) ou `readit dashboard`
  mcp.ts                   MCP stdio: abre stores, transport, shutdown (SIGINT/SIGTERM/fim do stdin)
  server.ts                tools MCP + rastreamento de cada call (callId, status, logs)
  dashboard/server.ts      dashboard HTTP (node:http) em 127.0.0.1; UI estática em public/
  store/                   SQLite (node:sqlite, WAL): calls, logs, credentials (AES-256-GCM), meta
  credentials/parse.ts     parsers de cookie (reddit_session, header Cookie, JSON de extensão, linhas)
  config.ts                env vars (READIT_*)
  logger.ts                pino → stderr
  errors.ts                UserFacingError (mensagem mostrada ao agente como está)
  browser/
    browser-manager.ts     contexto persistente único, lazy, headless⇄headed, fila serial, idle timeout
    navigate.ts            goto domcontentloaded + wait_for + espera de conteúdo estável + challenge
    challenge.ts           detecção de Cloudflare/captcha/bloqueio
  adapters/
    types.ts               SiteAdapter, AdapterContext, PageResult, defineAdapter()
    registry.ts            escolha de adaptador por domínio (sufixo) + matches(); genérico é o fallback
    index.ts               LISTA de adaptadores (único lugar a tocar para registrar um site novo)
    generic/               Readability + turndown, scrubber de banners/modais
    reddit/                JSON (.json, /api/morechildren) com cookies do perfil; fallback old.reddit
  lib/                     retry (backoff com jitter), truncate (paginação por start_index)
```

## Comandos

```bash
pnpm build          # tsc → dist/ (o cliente MCP roda dist/index.js: SEMPRE rebuildar após mudar código)
pnpm dev            # tsx src/index.ts (só para debug; ver aviso sobre tsx abaixo)
pnpm dashboard      # dashboard em http://localhost:7777 (token impresso no terminal)
pnpm lint           # eslint
pnpm lint:fix
pnpm format         # prettier --write
pnpm format:check
pnpm typecheck      # tsc --noEmit
```

Antes de dar qualquer tarefa por concluída:

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
```

Este projeto **não tem testes nem TDD** (decisão do usuário). Validar mudanças rodando o servidor de
verdade com um cliente MCP (SDK `Client` + `StdioClientTransport`) contra páginas reais.

## Regras obrigatórias para a IA

### stdout é o protocolo MCP

- **Nunca** `console.log`/`console.*` (o ESLint bloqueia com `no-console: error`). Log só via `logger`
  (pino em stderr, fd 2). Qualquer byte fora do protocolo em stdout quebra o cliente.

### Código

- TypeScript strict, ESM, Node 22 (`.mise.toml`). Um único package, pnpm.
- **Proibido `any`** (ESLint `no-explicit-any: error`). Usar `unknown` + type guards/zod.
  Lib sem tipos → criar `.d.ts` em `src/types/`.
- `import type` para imports só de tipo.
- JSDoc em toda função/classe pública.
- **Dependências só via `pnpm add` / `pnpm add -D`**, nunca editando `package.json` à mão.
- TypeScript fixado em 6.x: typescript-eslint ainda não suporta TS 7.
- Funções passadas a `page.evaluate` rodam no browser: nada de closures sobre variáveis do Node.
  O `tsx` (pnpm dev) injeta `__name` em funções nomeadas e pode quebrar `evaluate`; o build com `tsc`
  não tem esse problema.

### Navegador

- Um único `launchPersistentContext` em `READIT_PROFILE_DIR` (padrão
  `~/.local/share/readit/profile`). Dois processos não podem usar o mesmo perfil ao mesmo tempo.
- Headless por padrão; `open_browser` relança headed no mesmo perfil para login/captcha manual.
  O headed fica aberto até `close_browser` (sem idle timeout); o headless fecha após `READIT_IDLE_MS`.
- `channel: 'chromium'` (binário completo, new headless) nos dois modos; UA sem "HeadlessChrome".
- Navegação com `domcontentloaded` + polling (nunca `networkidle`). Extração em lote: `page.content()`
  e parse no Node, ou um único `page.evaluate`.
- Página de challenge/login → `UserFacingError` dizendo para chamar `open_browser`.

### Dados, dashboard e credenciais

- Banco único `READIT_DB_PATH` (padrão `~/.local/share/readit/readit.db`), compartilhado entre
  processos MCP e o dashboard. Migrações em `src/store/db.ts` (`PRAGMA user_version`): só adicionar
  novas, nunca editar as existentes.
- Escritas de histórico são best effort: falha no banco nunca pode quebrar uma tool call.
- Histórico guardado para sempre (decisão do usuário); limpeza só manual no dashboard.
- Credenciais: valores cifrados (AES-256-GCM, chave em `~/.config/readit/secret.key` 0600).
  **Nunca** logar, retornar em tool ou mandar ao frontend um valor de cookie. A UI só vê `preview`.
- O `BrowserManager` sincroniza cookies no launch e antes de cada operação (checa
  `credentials_version` em `meta`), e remove do perfil cookies de credenciais apagadas.
- Dashboard: só 127.0.0.1, token persistente (`~/.config/readit/dashboard.token`, `--rotate-token` troca) → cookie
  HttpOnly SameSite=Strict de 30 dias; sem cookie, `/` serve `public/login.html`, checagem de
  Host/Origin, CSP sem inline (usar `el.style`/classes, nunca `style=""` nem `innerHTML`).
- Frontend (`public/`) é JS puro sem build; texto sempre via `textContent`.

### Adaptadores

- Um adaptador = pasta em `src/adapters/<site>/` exportando `defineAdapter({ name, description, hosts,
matches?, optionsSchema (zod, aceita {}), read })` + uma linha em `src/adapters/index.ts`.
  Adicionar site novo **não** pode exigir mexer em `server.ts`, `browser/` ou `registry.ts`.
- Reddit: bloqueia perfil anônimo ("Prove your humanity" / old.reddit → /login). É preciso logar uma
  vez via `open_browser`. O cliente tenta `context.request` e cai para `fetch` dentro de uma aba
  reddit.com (TLS de Chrome real) e, por fim, para o DOM do old.reddit.

### Commits

- **Nunca commitar sem o usuário pedir.**
- Mensagens em inglês, formato `type: description` (feat, fix, refactor, docs, chore...).
- Pre-commit roda lint-staged (eslint --fix + prettier).

### Autonomia

- A IA roda todos os comandos e faz todas as edições. Só chamar o usuário para decisões ou ações
  físicas (ex.: logar na janela do navegador).
