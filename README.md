# readit

A local browser for AI agents. An MCP server (stdio) that lets Claude Code, Codex and other MCP
clients read **one page at a time, when you ask**, using **your** Chromium profile: your logins,
your cookies, your residential IP. Handles JS-rendered sites and sites that block scrapers (e.g.
Reddit, which also blocks Firecrawl).

This is not a scraper. There is no crawling, queue or concurrency: one page, on request.

## How it works

- One Chromium with a persistent profile at `~/.local/share/readit/profile`, launched lazily on
  the first tool call and closed when the MCP client exits.
- Headless by default. `open_browser` relaunches it **visible** on the same profile so you can log in
  or solve a captcha. On WSL2 the window shows up through WSLg.
- Site adapters turn pages into clean markdown:
  - **generic** (any site): renders JS, removes cookie banners/modals/chat widgets, extracts the main
    content with Readability, converts to markdown (turndown + GFM tables).
  - **reddit**: threads (post + full nested comment tree with author, score, "more comments"
    expanded via `/api/morechildren`) and listings (subreddits, users, search), read from Reddit's
    JSON with your cookies. Falls back to old.reddit.com HTML.

## Dashboard

```bash
pnpm dashboard
```

Opens `http://localhost:7777/?token=…` (on WSL it opens in your Windows browser). The token is
kept in `~/.config/readit/dashboard.token`, so the link can be bookmarked; without it the page
asks you to paste the token. `pnpm dashboard --rotate-token` generates a new one. Separate process
from the MCP server: it reads the same database, so it shows calls from every MCP client and works
even when no agent is running.

- **Usage**: calls, success rate, blocked/login walls, latency p50/p95, calls per day, top hosts,
  adapters, and recent calls. Click a call to see its arguments, error and every log line of that
  call (navigation, retries, fallbacks).
- **Logs**: recent log lines from all processes.
- **Credentials**: add cookies so the agent's Chromium starts logged in.
  - _Reddit_: paste the value of the `reddit_session` cookie (the dialog shows where to find it in
    DevTools).
  - _Other site_: domain + cookies as a `Cookie:` header, Cookie-Editor JSON export, or `name=value`
    lines.

History is kept forever; use _Clear history_ to wipe it.

### How credentials are stored

- Cookie values are encrypted with **AES-256-GCM** (row id as associated data) in
  `~/.local/share/readit/readit.db`. The key lives in a separate file,
  `~/.config/readit/secret.key` (mode 0600, created on first use), or in `READIT_SECRET_KEY`.
- Values are never shown again, logged or returned by any tool: the dashboard shows only
  `name=••••abcd`.
- On every browser launch, and on the next call after a change in the dashboard, the MCP server
  injects the cookies into the profile. Removing a credential also removes its cookies from the
  profile.
- Threat model: this protects against accidental leaks (a copied/backed-up database, an agent
  reading the DB file). It does not protect against someone who already runs code as your user —
  the Chromium profile itself holds the same cookies.
- The dashboard listens on 127.0.0.1 only, requires the access token (exchanged for an HttpOnly, SameSite=Strict cookie valid for 30 days), checks `Host`/`Origin` (DNS rebinding / CSRF from other sites) and
  sends a strict CSP.

## Tools

| Tool                                                                                         | What it does                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `read_page(url, selector?, wait_for?, max_chars?, start_index?, adapter?, adapter_options?)` | Returns markdown with title, final URL and content. Long pages are paginated with `start_index`. |
| `open_browser(url?)`                                                                         | Opens the visible window so you can log in / solve a challenge.                                  |
| `screenshot(url?, full_page?)`                                                               | JPEG of a URL or of the open tab (debug).                                                        |
| `close_browser()`                                                                            | Closes the browser; the next call relaunches it headless.                                        |

When a page is blocked or needs login, `read_page` says so and tells the agent to call
`open_browser`. You do the login in the window, tell the agent, and it retries.

## Setup

Requires **Node 22** (there is a `.mise.toml`, so `mise install` picks it up), **pnpm**, and a Linux
desktop or WSL2 with WSLg (needed only for the visible window).

```bash
git clone git@github.com:paulocarmino/readit.git readit
cd readit
mise install                        # or use your own Node 22
pnpm install
pnpm exec playwright install chromium
pnpm build
```

Nothing else is needed: the profile, the database and the encryption key are created on first use.
Replace `/home/pcarmino/readit` below with wherever you cloned it.

### Register in Claude Code

```bash
claude mcp add readit --scope user -- node /home/pcarmino/readit/dist/index.js
```

### Register in Codex CLI

```bash
codex mcp add readit -- node /home/pcarmino/readit/dist/index.js
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.readit]
command = "node"
args = ["/home/pcarmino/readit/dist/index.js"]
```

Chromium locks its profile, so **two clients cannot use the same profile at the same time**. If you
run Claude Code and Codex at once, give one of them its own profile (and log in there too):

```bash
claude mcp add readit --scope user -e READIT_PROFILE_DIR=/home/pcarmino/.local/share/readit/profile-claude -- node /home/pcarmino/readit/dist/index.js
```

### First login (Reddit, etc.)

Either add a credential in the dashboard (`pnpm dashboard` → Credentials), or ask the agent to
"open the browser at https://www.reddit.com/login", log in in the window and tell the agent you're
done. Both end up as cookies in the profile.

## State lives outside the repo

Nothing below is in git. All of it is created automatically the first time it is needed, so a fresh
clone works right away — it just starts empty (not logged in anywhere, no history).

| Path                               | What it is                                       | Created when                 |
| ---------------------------------- | ------------------------------------------------ | ---------------------------- |
| `~/.local/share/readit/profile/`   | Chromium profile: cookies, logins, local storage | first tool call              |
| `~/.local/share/readit/readit.db`  | Call history, logs, encrypted credentials        | first run (MCP or dashboard) |
| `~/.config/readit/secret.key`      | AES-256 key for credentials (random, mode 0600)  | first run (MCP or dashboard) |
| `~/.config/readit/dashboard.token` | Dashboard access token (random, mode 0600)       | first `pnpm dashboard`       |

To use your own encryption key instead of the file (e.g. from a password manager):

```bash
openssl rand -base64 32          # put the result in READIT_SECRET_KEY
```

### Moving to another machine, or backing up

- **Simplest:** copy nothing. Clone, run, and add the credentials again in the dashboard (and/or log
  in once with `open_browser`).
- **To keep the credentials:** copy both `~/.config/readit/secret.key` **and**
  `~/.local/share/readit/readit.db`. The database alone is useless without the key — that is
  the point of keeping them apart.
- **To keep the logged-in sessions without the credentials feature:** copy
  `~/.local/share/readit/profile/`. Treat it like a password file; it holds live cookies.
- Lost the key? Delete the credentials in the dashboard and add them again; everything else (history,
  logs) keeps working.

## Configuration (env vars)

| Variable                | Default                           | Meaning                                                       |
| ----------------------- | --------------------------------- | ------------------------------------------------------------- |
| `READIT_PROFILE_DIR`    | `~/.local/share/readit/profile`   | Chromium profile directory                                    |
| `READIT_HEADLESS`       | `true`                            | `false` = always use a visible window                         |
| `READIT_IDLE_MS`        | `600000`                          | Close the headless browser after this idle time (`0` = never) |
| `READIT_TIMEOUT_MS`     | `30000`                           | Navigation / request timeout                                  |
| `READIT_MAX_CHARS`      | `40000`                           | Default `max_chars` of `read_page`                            |
| `READIT_LOG_LEVEL`      | `info`                            | pino level (logs go to stderr; info+ also to the DB)          |
| `READIT_DB_PATH`        | `~/.local/share/readit/readit.db` | History, logs and credentials                                 |
| `READIT_KEY_FILE`       | `~/.config/readit/secret.key`     | Credential encryption key                                     |
| `READIT_SECRET_KEY`     | —                                 | Base64 32-byte key (overrides the key file)                   |
| `READIT_DASHBOARD_PORT` | `7777`                            | Dashboard port                                                |

## Adding a site adapter

Create `src/adapters/<site>/index.ts`:

```ts
import { z } from 'zod';
import { defineAdapter } from '../types.js';

export const exampleAdapter = defineAdapter({
  name: 'example',
  description: 'What it returns, in one line (shown to the agent).',
  hosts: ['example.com'], // suffix match: also www.example.com
  matches: (url) => url.pathname.startsWith('/posts/'), // optional
  optionsSchema: z.object({ include_replies: z.boolean().default(true) }),
  read: (url, options, ctx) =>
    ctx.withPage(url.href, async (page, warnings) => ({
      title: await page.title(),
      url: page.url(),
      markdown: '...',
      warnings,
    })),
});
```

Then add it to the list in `src/adapters/index.ts` and run `pnpm build`. Nothing else changes.

## Development

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
```
