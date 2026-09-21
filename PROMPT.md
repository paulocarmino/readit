# Contexto

Quero criar um projeto novo do zero em ~/readit-idgaf: um **navegador local para agentes de IA** (Claude Code, Codex/GPT etc.) lerem páginas que eu indico. Isso inclui sites que dependem de JavaScript e sites que bloqueiam scrapers comuns (ex.: Reddit, que também bloqueia o Firecrawl).

Não é scraping em escala. É uso pessoal: o agente abre UMA URL que eu apontei, usando MEU navegador, MINHA conta logada e MEU IP residencial, e lê o conteúdo. Uma página por vez, a meu pedido.

Ele é a versão "lite" de um projeto antigo meu, ~/playwright-orchestrator (monorepo enterprise com RabbitMQ, Fastify, workers, S3 e GUI). NÃO quero nada desse ferramental de escala aqui, mas quero reaproveitar os aprendizados de Playwright de lá (lista abaixo).

# O que construir

Um **servidor MCP (stdio)** em TypeScript/Node 22, usando `@modelcontextprotocol/sdk` + `playwright`. Ele sobe quando o cliente MCP inicia e morre quando o cliente fecha. Nada de servidor, Docker ou fila.

## Navegador

- Um único Chromium com **perfil persistente** (`chromium.launchPersistentContext`) em `~/.local/share/readit-idgaf/profile`. Eu faço login uma vez (Reddit, etc.) e os cookies ficam salvos.
- Lançado de forma preguiçosa (lazy) na primeira tool call. Encerrado de forma limpa em SIGINT/SIGTERM/fim do stdin.
- Roda no WSL2 (WSLg mostra janelas headed). Decidir e me propor: headed sempre vs. headless por padrão + relançar headed quando precisar de login. Lembrar que duas instâncias não podem usar o mesmo perfil ao mesmo tempo.

## Tools MCP (proposta inicial, pode refinar comigo)

- `read_page(url, options?)`: navega, espera o conteúdo, limpa o ruído e devolve **markdown limpo** (título, URL final, conteúdo principal). Opções tipo `selector`, `wait_for`, `max_chars`.
- `open_browser(url?)`: abre a janela visível pra eu logar ou resolver captcha manualmente.
- `screenshot(url)`: opcional, pra debug.
- `close_browser()`.

## Adaptadores por site (evolução do sistema de plugins do orchestrator)

- **Genérico** (padrão): extração de conteúdo principal (avaliar Readability + conversão para markdown, ex. turndown) para qualquer site.
- **Reddit**: buscar `<thread>.json` via `context.request` (compartilha os cookies do perfil logado; não precisa de API key). Montar post + árvore completa de comentários (autor, score, aninhamento), expandindo "more comments" via `/api/morechildren`. Fallback para DOM do old.reddit.com.
- Um adaptador = domínio(s) que atende + schema zod de opções + handler. Adicionar um site novo não pode exigir mexer no núcleo.

# Reaproveitar do ~/playwright-orchestrator (LEIA antes de escrever código)

- `packages/types/src/plugin.ts` + `apps/worker/src/plugin-loader.ts`: padrão plugin/registro. Base dos adaptadores, sem a parte de fila/job type.
- `apps/worker/src/browser-manager.ts`: ciclo de vida (init/shutdown idempotente, cleanup que loga e não propaga). Adaptar para contexto persistente único.
- `packages/plugin-screenshot/src/scrubber.ts`: seletores de cookie banner, chat widget, modais. Remover antes de extrair.
- `packages/plugin-scoutify-shared/src/cloudflare.ts`: detectar página de challenge e retornar erro claro ("resolva na janela com open_browser").
- `packages/plugin-scoutify-shared/src/selectors.ts` (`findWithRetry`) e `SCOUTIFY-OPTIMIZATIONS.md`: `domcontentloaded` em vez de `networkidle`, retry por polling, extração em lote com `page.evaluate`.
- `packages/plugin-core/src/retry.ts`: backoff com jitter. Copiar.
- `eslint.config.js`, `tsconfig.base.json`, `.prettierrc`, `.husky/`, `CLAUDE.md`: mesmo padrão de qualidade.

# Regras

- **Projeto simples**: um único package (não monorepo), pnpm, ESM, TypeScript strict.
- **ATENÇÃO MCP stdio**: stdout é o canal do protocolo. Todo log vai para **stderr** (pino com destination stderr ou similar). Nunca `console.log`.
- Proibido `any` (usar `unknown` + type guards). `import type` para tipos. JSDoc em funções públicas.
- Dependências sempre via `pnpm add`, nunca editando package.json na mão.
- **TDD** para a lógica (conversão de JSON do Reddit → markdown, extração genérica, seleção de adaptador): escrever os testes primeiro, me mostrar pra aprovar, depois implementar. Usar fixtures reais salvas em arquivo (ex.: um `.json` de thread real do Reddit).
- **Você mesmo roda todos os comandos e faz todas as edições.** Nunca me peça pra rodar comando, trocar texto ou editar arquivo. Só me chame para decisões ou para ações físicas (ex.: fazer login na janela do navegador).
- Antes de dar algo por pronto: lint, format:check, typecheck e testes passando.
- Nunca commitar sem eu pedir. Mensagens de commit em inglês, `type: description`.
- Criar um CLAUDE.md do projeto com essas regras.
- No README, a instrução de registro no Claude Code (`claude mcp add readit-idgaf ...`) e no Codex CLI.

# Primeiro passo

Leia os arquivos de referência acima, depois me proponha a estrutura de pastas, as dependências e a interface das tools/adaptadores **antes** de criar qualquer coisa. Aí seguimos com o TDD.
