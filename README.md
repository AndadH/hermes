# Hermes

An autonomous executive intelligence built on Cloudflare Workers. Hermes runs as a persistent AI agent accessible via Telegram and a WebSocket interface (used by an Obsidian plugin), with a shared vault, structured memory, timers, calendar integration, and a self-discovering tool system.

---

## What it does

- **Telegram bot** — primary interface. Hermes reads and responds to messages, remembers context across conversations, and can act autonomously via scheduled timers and event callbacks.
- **Obsidian plugin interface** — WebSocket-based chat that gives Hermes access to your vault as a shared collaborative workspace. Both you and Hermes read and write notes there.
- **Structured memory** — entity store (contacts, projects, organizations, any custom type) backed by D1 with FTS5 full-text search and a relationship graph.
- **Vault sync** — bidirectional sync between the Cloudflare R2 bucket and Obsidian via a manifest/upload/download protocol. Notes created by Hermes appear in Obsidian automatically.
- **Autonomous scheduling** — `scheduleTimer` fires a full agent turn at a future time; `scheduleCode` runs a deterministic JS snippet. Both are backed by Durable Objects.
- **Event callbacks** — `registerCallback` fires an agent turn when a Telegram message matches a regex or a specific emoji reaction is added.
- **Tool discovery** — the agent can explore its full tool catalog at runtime via `discoverTools`, which reads a structured spec with categories, tags, examples, and disambiguation notes.

---

## Architecture

```
Cloudflare Worker (Hono router)
├── /telegram/webhook          Telegram bot handler
├── /ws/:sessionId             WebSocket chat (Obsidian plugin)
├── /sync/*                    Vault sync API (manifest, upload, download, delete)
├── /search                    Standalone semantic search (AutoRAG)
└── /health                    Health check

Durable Objects
├── ChatDO                     Per-session WebSocket + conversation history
├── TimerDO                    Scheduled intent/code timers (alarm API)
└── CallbackDO                 Telegram event callbacks

Storage
├── D1 (hermes-db)             Conversation history, vault manifest, entity store, timers, callbacks
└── R2 (vault)                 Markdown notes (shared with Obsidian)

AI
└── Workers AI (AutoRAG)       Semantic search over vault notes
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers paid plan (required for Durable Objects)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- Node.js >= 20
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Access to `@cloudflare/codemode` (currently in closed beta — required for the tool sandbox)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# D1 database
wrangler d1 create hermes-db
# ↑ Copy the database_id into wrangler.toml

# R2 bucket
wrangler r2 bucket create vault
```

### 3. Update wrangler.toml

Replace the `database_id` under `[[d1_databases]]` with the ID from step 2. Everything else can stay as-is for a first deploy.

### 4. Run database migrations

```bash
wrangler d1 migrations apply DB --remote
```

This runs all migrations in `migrations/` in order:

| File | What it creates |
|---|---|
| `0001_add_tasks_table.sql` | Tasks table (legacy) |
| `0002_initialize.sql` | Vault file manifest + tombstones |
| `0003_add_telegram_history.sql` | Telegram conversation history |
| `0004_*` | Telegram context tracking |
| `0005_add_fts_to_telegram.sql` | FTS5 index on Telegram history |
| `0006_add_entities.sql` | Entity store + schema registry + relationship graph + FTS5 |

### 5. Set secrets

```bash
wrangler secret put API_SECRET               # shared bearer token for HTTP endpoints
wrangler secret put GOOGLE_AI_KEY            # Gemini API key (console.cloud.google.com)
wrangler secret put TELEGRAM_BOT_TOKEN       # from @BotFather
wrangler secret put TELEGRAM_ALLOWED_USER_ID # your Telegram user ID (get from @userinfobot)
wrangler secret put TAVILY_API_KEY           # web search — free tier at app.tavily.com
wrangler secret put GOOGLE_CAL_CLIENT_EMAIL  # Google service account email
wrangler secret put GOOGLE_CAL_PRIVATE_KEY   # service account private key (PEM, with \n)
wrangler secret put GOOGLE_CALENDAR_ID       # calendar ID (e.g. your@email.com)

# Optional — tools degrade gracefully without these
wrangler secret put WOLFRAM_APP_ID           # developer.wolframalpha.com — math CAS
wrangler secret put FRED_API_KEY             # fred.stlouisfed.org — US economic data
```

### 6. Set vars in wrangler.toml

```toml
[vars]
TELEGRAM_CHAT_ID = "your-telegram-chat-id"  # get from @userinfobot or any message update
```

### 7. Generate types

```bash
wrangler types
```

### 8. Deploy

```bash
wrangler deploy
```

### 9. Register the Telegram webhook

After deploy, point Telegram at your worker:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://hermes.<your-subdomain>.workers.dev/telegram/webhook"
```

### 10. Set up AutoRAG (semantic vault search)

In the Cloudflare dashboard, create an AutoRAG index named `hermes-vault` and point it at your R2 bucket. This powers `searchVault`. See [Cloudflare AutoRAG docs](https://developers.cloudflare.com/ai-gateway/ai-rag/).

---

## Google Calendar setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project, enable the Google Calendar API
3. Create a service account, download the JSON key
4. Share your calendar with the service account email (give it editor access)
5. Set `GOOGLE_CAL_CLIENT_EMAIL` and `GOOGLE_CAL_PRIVATE_KEY` secrets
6. Set `GOOGLE_CALENDAR_ID` to your calendar's ID (found in Calendar settings)

---

## Development

```bash
# Local dev (no Durable Objects — use --remote for full features)
wrangler dev

# Deploy
npm run deploy

# Tail live logs
wrangler tail

# Regenerate types after wrangler.toml changes
npm run cf-typegen
```

---

## Project structure

```
src/
├── index.ts                    Hono router — all HTTP routes
├── types.ts                    Shared TypeScript types + Env interface
│
├── agent/
│   ├── index.ts                runAgentTurn / runTelegramTurn entry points
│   ├── kernel.ts               Core agent loop — tool dispatch, round accounting, nudges
│   ├── gemini.ts               Gemini API calls + SSE streaming
│   └── kernels/
│       ├── base.ts             Shared persona, coreGuidelines, calendarGuidelines
│       ├── obsidian.ts         WebSocket kernel config (hotTools, maxRounds, prompt)
│       └── telegram.ts         Telegram kernel config
│
├── tools/
│   ├── registry.ts             All tool definitions — category, tags, note, examples, execute
│   ├── spec.ts                 Builds HermesSpec + __index for discoverTools
│   ├── vault.ts                Obsidian vault R2 operations
│   ├── web.ts                  webSearch (Tavily) + fetchPage
│   ├── calendar.ts             Google Calendar read/write
│   ├── history.ts              Telegram history FTS + getHistory
│   ├── timer.ts                scheduleTimer, scheduleCode, cancel*
│   ├── callbacks.ts            registerCallback, deleteCallback, listCallbacks
│   ├── telegram.ts             sendTelegramMessage
│   ├── daily.ts                readMemory, writeMemory (daily journal)
│   ├── math.ts                 newtonMath, wolframAlpha
│   ├── research.ts             openAlex, arxiv, wikipedia, fred, worldBank
│   └── entities.ts             Entity store — findEntities, createEntity, linkEntities, etc.
│
├── durable/
│   ├── chatDO.ts               WebSocket session + conversation history
│   ├── timerDO.ts              Timer alarm handler
│   └── callbackDO.ts           Telegram callback matching
│
└── handlers/
    ├── middleware.ts            Auth (bearer + WS secret)
    ├── telegramHandlers.ts      Telegram webhook processing
    ├── syncHandlers.ts          Vault sync API (manifest/upload/download/delete)
    └── searchHandlers.ts        Standalone AutoRAG search endpoint

migrations/
├── 0001_add_tasks_table.sql
├── 0002_initialize.sql          Vault manifest
├── 0003_add_telegram_history.sql
├── 0004_*.sql                   Telegram context
├── 0005_add_fts_to_telegram.sql
└── 0006_add_entities.sql        Entity store + FTS5 + seeded schemas
```

---

## API reference

All HTTP endpoints (except `/health` and `/telegram/webhook`) require:
```
Authorization: Bearer <API_SECRET>
```

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/telegram/webhook` | Telegram bot webhook (no auth — verified by bot token) |
| `GET` | `/ws/:sessionId` | WebSocket chat. Use `new` for a new session. Auth via `?secret=` |
| `POST` | `/sync/manifest` | Vault sync — returns files to upload/download |
| `POST` | `/sync/upload` | Upload vault files to R2 |
| `POST` | `/sync/batchDownload` | Download vault files from R2 |
| `POST` | `/sync/delete` | Mark vault files as deleted (tombstone) |
| `POST` | `/search` | Semantic search over vault (AutoRAG) |

---

## Tool categories

Tools are organized into categories discoverable via `discoverTools`:

| Category | Description |
|---|---|
| `vault` | Shared workspace — notes and docs; both you and Hermes read and write here |
| `memory` | Everything Hermes accumulates — entities, observations, chat history, daily log |
| `research` | External data — openAlex, arxiv, wikipedia, fred, worldBank; webSearch as fallback |
| `math` | Symbolic math (Newton API) and advanced CAS (Wolfram\|Alpha) |
| `calendar` | Google Calendar read and write |
| `async` | Timers, scheduled code, event callbacks |
| `communication` | Send proactive Telegram messages |

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `API_SECRET` | Yes | Bearer token for HTTP endpoints |
| `GOOGLE_AI_KEY` | Yes | Gemini API key |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_ALLOWED_USER_ID` | Yes | Your Telegram user ID (whitelist) |
| `TELEGRAM_CHAT_ID` | Yes | Chat ID for proactive messages (set in vars) |
| `TAVILY_API_KEY` | Yes | Web search |
| `GOOGLE_CAL_CLIENT_EMAIL` | Yes | Google service account email |
| `GOOGLE_CAL_PRIVATE_KEY` | Yes | Service account private key |
| `GOOGLE_CALENDAR_ID` | Yes | Calendar ID |
| `WOLFRAM_APP_ID` | No | Wolfram\|Alpha — enables `wolframAlpha` tool |
| `FRED_API_KEY` | No | FRED — enables `fred` tool |