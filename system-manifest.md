# NanoClaw System Manifest

This file is the single source of truth for what is running, how it is configured, and what has changed.

**All bots read this before making system-level changes.**
**CoderBot appends to the Change Log after every implementation.**

---

## Host Environment

- macOS Darwin 25.3, Apple Silicon (Mac mini)
- Ollama localhost:11434 — qwen2.5vl:7b
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

| ID | Group | Schedule | What It Does |
|----|-------|----------|-------------|
| memory-reindex-telegram_main | telegram_main | `0 12,22 * * *` | Rebuilds vector index over conversation archive |
| memory-reindex-telegram_dev | telegram_dev | `0 12,22 * * *` | Rebuilds vector index over conversation archive |
| memory-reindex-telegram_deutschflow | telegram_deutschflow | `0 12,22 * * *` | Rebuilds vector index over conversation archive |
| memory-reindex-telegram_linguaflow | telegram_linguaflow | `0 12,22 * * *` | Rebuilds vector index over conversation archive |

**CoderBot indexer:** Triggered automatically after each coding session. Runs `container/skills/memory-search/indexer.py --group coder` directly on the host. Uses Ollama `nomic-embed-text` at `localhost:11434`.

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

---

## Change Log

### 2026-04-04 — CoderBot

- Fixed stale container bug: replaced `resetIdleTimer()` with `queue.closeStdin(chatJid)` in auth error handler (`src/index.ts:378`). Dead containers now close within seconds of auth error instead of sitting idle for 30 minutes.
- Added CoderBot conversation archive: each coding session now appended to `groups/coder/conversations/YYYY-MM-DD.md`
- Added CoderBot vector index: indexer triggered automatically after each session, writes to `groups/coder/memory-index/`
- Created `system-manifest.md` — system-wide awareness for all bots
- Updated `groups/global/CLAUDE.md` — added manifest reading rule and coder memory reference
- Updated `~/.claude-coder/CLAUDE.md` — added manifest update rule
