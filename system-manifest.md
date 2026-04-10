# NanoClaw System Manifest

This file is the single source of truth for what is running, how it is configured, and what has changed.

**All bots read this before making system-level changes.**
**CoderBot appends to the Change Log after every implementation.**

---

## Host Environment

- macOS Darwin 25.3, Apple Silicon (Mac mini)
- Ollama localhost:11434 — `nomic-embed-text` (embeddings), `gemma4:e2b` (memory synthesis), `qwen2.5vl:7b` (vision / crawler extraction)
- whisper-cpp (local STT), edge-tts (TTS), ffmpeg
- Docker Desktop
- Node 20, npm, TypeScript
- gh CLI (GitHub authenticated)
- Claude Code 2.1.81

---

## Bots

| Bot | Process | Purpose | Memory |
|-----|---------|---------|--------|
| TataNano | `com.nanoclaw` (launchd) | Personal assistant — main Telegram group | SQLite + conversation archive + vector index |
| CoderBot | `com.nanoclaw.coder` (launchd) | Direct Claude Code access for coding tasks | Conversation archive + vector index (as of 2026-04-04) |
| CrawlerBot | `com.nanoclaw.crawler` (launchd) | Lead scraper — Telegram commands `/scrape`, `/crawl`, `/export` | SQLite (jobs, pages, leads) |
| Bart | `com.nanoclaw.bart` (launchd) | Bart Simpson personality chatbot — Fish Audio TTS | None (ephemeral by design) |
| MamaZdrowie | `com.nanoclaw.mama` (launchd) | Health assistant for Bartek's mother — Polish, edge-tts | SQLite (glucose, meals, medication) |

**NanoClaw groups (Telegram channels inside TataNano):**

| Group | Folder | Purpose | Memory |
|-------|--------|---------|--------|
| Main | `telegram_main` | Primary personal assistant | SQLite + archive + vector index |
| Dev | `telegram_dev` | Development and testing | SQLite + archive + vector index |
| DeutschFlow | `telegram_deutschflow` | German language tutor (Katja) | Archive + vector index + learner.json |
| LinguaFlow | `telegram_linguaflow` | Spanish language tutor | Archive + vector index + learner.json |

---

## Scheduled Tasks

Memory reindexing runs on the **host** via launchd, not inside agent containers (the indexer talks to Ollama only — wrapping it in a Claude container wastes tokens and trips OAuth rate limits). All schedules below call `scripts/memory-reindex.sh` which runs `container/skills/memory-search/indexer.py` directly.

| Service (launchd) | Group | Schedule (local time) |
|---|---|---|
| `com.nanoclaw.reindex-main` | `telegram_main` | 03:00 / 09:00 / 15:00 / 21:00 |
| `com.nanoclaw.reindex-dev`  | `telegram_dev`  | 00:30 / 06:30 / 12:30 / 18:30 |

**Language bots** (`telegram_deutschflow`, `telegram_linguaflow`) are intentionally **not indexed** — ephemeral practice sessions, no semantic recall needed.

**CoderBot indexer:** event-driven, not scheduled. Triggered automatically after each coding session by `coder-bot/src/index.ts`. Runs `container/skills/memory-search/indexer.py --group coder` directly on the host. Uses Ollama `nomic-embed-text` for embeddings and `gemma4:e2b` for synthesis at `localhost:11434`.

**Adding a new group:** copy an existing reindex plist in `~/Library/LaunchAgents/`, change `Label`, the second `ProgramArguments` string (the group folder name), and pick `StartCalendarInterval` hours that don't collide with existing jobs. Then `launchctl load` it. Do **not** add `memory-reindex-*` rows to `scheduled_tasks` — that's the deprecated in-container path.

---

## Memory Architecture

| Bot | Archive Location | Index Location | Accessible To |
|-----|-----------------|----------------|---------------|
| TataNano | `groups/telegram_main/conversations/` | `groups/telegram_main/memory-index/` | Main group only |
| Dev | `groups/telegram_dev/conversations/` | `groups/telegram_dev/memory-index/` | Dev group only |
| DeutschFlow | `groups/telegram_deutschflow/conversations/` | `groups/telegram_deutschflow/memory-index/` | DeutschFlow only |
| LinguaFlow | `groups/telegram_linguaflow/conversations/` | `groups/telegram_linguaflow/memory-index/` | LinguaFlow only |
| CoderBot | `groups/coder/conversations/` | `groups/coder/memory-index/` | TataNano (main) + CoderBot |

**Index format:** JSON, `nomic-embed-text` embeddings, 1800-char chunks with 200-char overlap.
**Search skill:** `container/skills/memory-search/indexer.py`

---

## Key Paths

| Path | Purpose |
|------|---------|
| `store/messages.db` | Central SQLite — messages, sessions, scheduled tasks, registered groups |
| `groups/global/CLAUDE.md` | Shared assistant persona, mounted RO into all non-main containers |
| `groups/coder/` | CoderBot conversation archive and vector index |
| `container/skills/` | Skills synced into every agent container at startup |
| `data/ipc/` | Per-group IPC directories (isolated, no cross-group access) |
| `~/.claude-coder/` | CoderBot's Claude Code config and OAuth state |
| `crawler-bot/data/tatanano.db` | CrawlerBot's SQLite — jobs, pages, leads |
| `mama-bot/data/mama.db` | MamaZdrowie's SQLite — glucose, meals, medication |
| `scopes/` | Design notes and implementation plans (see "Scopes & Plans" below) |

---

## Capabilities & Roadmap

Live capabilities NanoClaw bots can rely on **today**:

- **Telegram** (channels: main, dev, deutschflow, linguaflow), **WhatsApp** (legacy `main` group), **Voice** (Whisper STT + edge-tts TTS, mirrored if user sends voice), **Image vision** (qwen2.5vl:7b via Ollama), **Memory search** (nomic-embed-text + gemma4:e2b synthesis), **Web crawl/lead scrape** (CrawlerBot only), **Ollama local models** (embeddings, synthesis, vision).
- **Gmail read/send/attachments** — **live for Claude Code (host) and CoderBot only** as of 2026-04-10 via local MCP `@gongrzhe/server-gmail-autoauth-mcp`. Authorized account: `bart70895@gmail.com`. OAuth artifacts at `~/.gmail-mcp/` (`gcp-oauth.keys.json` = client credential, `credentials.json` = cached refresh token). 22 tools exposed including `download_attachment` (the hosted `claude.ai Gmail` MCP cannot download attachments — that was the main motivation; proven working with 29 .eml files into `~/Documents/NanoClaw/silicon-emails/`). **Container bots (`telegram_main`, `telegram_dev`) cannot use Gmail** — Phase 2 deferred. **Token caveat:** Testing-mode OAuth refresh token expires every ~7 days; recovery is `npx @gongrzhe/server-gmail-autoauth-mcp auth` from a terminal with browser access.

**Planned / scoped, not yet wired into bots:**

- **Gmail for container bots (Phase 2)** — would require mounting `~/.gmail-mcp/` RO into containers + adding the MCP entry to `container/agent-runner/src/index.ts` mcpServers + image rebuild + NanoClaw restart. Implementation notes preserved in approved plan at `~/.claude/plans/misty-whistling-pine.md` (Deferred section). Workaround today: ask CoderBot in its dedicated chat for any Gmail action.
- **NotebookLM knowledge hub** — see `scopes/notebooklm-knowledge-hub/`.
- **CrawlerBot v2**, **Bart bot pool**, **Self-improving agent** — each has a scope file under `scopes/`.

When a user asks "can you do X?", check both this section and `scopes/` before answering — the capability may be planned but not live.

---

## Scopes & Plans

Design notes and implementation plans live in `/Users/tataadmin/nanoclaw/scopes/`. **Scopes are NOT indexed** by the memory pipeline — many were never executed and indexing them would pollute `knowledge.md` with unbuilt features. Bots should treat `scopes/` as a roadmap reference, not as ground truth.

**How to use scopes:**

- Before answering "is feature X built?" — grep `scopes/` for X. If a scope file exists, the feature is planned (status is in the SCOPE.md header). If no scope file exists and no code exists, the feature is neither built nor planned.
- Before starting new design work — check `scopes/` and `scopes/archive/` to avoid re-scoping something that already has a plan.
- After finishing implementation — move the scope from `scopes/{name}/` to `scopes/archive/{name}/` so the active list stays small.

**Current active scopes (as of 2026-04-10):**

- `scopes/gmail-mcp-oauth/` — local Gmail MCP for all agents
- `scopes/notebooklm-knowledge-hub/` — NotebookLM as a shared knowledge layer
- `scopes/bart-bot-pool/` — Bart bot pool design
- `scopes/fix-knowledge-duplicates/` — dedup pass for memory synthesis
- `scopes/upstream-merge-2026-04-06/` — pending NanoClaw upstream merge
- `scopes/crawler-bot-v2.md`, `scopes/lead-scraper.md`, `scopes/memory-improvements.md`, `scopes/self-improving-agent.md`, `scopes/bot-shared-awareness/` — standalone design notes

---

## Change Log

### 2026-04-04 — CoderBot

- Fixed stale container bug: replaced `resetIdleTimer()` with `queue.closeStdin(chatJid)` in auth error handler (`src/index.ts:378`). Dead containers now close within seconds of auth error instead of sitting idle for 30 minutes.
- Added CoderBot conversation archive: each coding session now appended to `groups/coder/conversations/YYYY-MM-DD.md`
- Added CoderBot vector index: indexer triggered automatically after each session, writes to `groups/coder/memory-index/`
- Created `system-manifest.md` — system-wide awareness for all bots
- Updated `groups/global/CLAUDE.md` — added manifest reading rule and coder memory reference
- Updated `~/.claude-coder/CLAUDE.md` — added manifest update rule
