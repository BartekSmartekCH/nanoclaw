# RFC: Bot Shared Awareness

**Status:** Proposed
**Author:** TataNano (telegram_main)
**Date:** 2026-04-04

---

## Problem

NanoClaw bots share infrastructure (source code, scopes folder) but have no awareness of each other's actions. When one bot implements a change, other bots don't know unless they happen to read the affected files.

**Concrete example that triggered this RFC:**
- Coder-bot changed memory indexing from weekly → twice-daily (`0 12,22 * * *`)
- The `SKILL.md` still says "weekly"
- TataNano (main) had incorrect information about the system until manually audited
- No bot was notified. No log existed.

**Root cause:** There is no shared record of *what has been built, changed, or configured* across the system. Each bot only knows what it can see in its own conversation history or by reading source files.

---

## Proposed Solution

Three small additions:

### 1. `system-manifest.md` — living system log

A single file at `/workspace/project/system-manifest.md` (already exists but only lists host environment). Extend it to include:

- **Bots registry** — all active bots, their group, purpose, memory type
- **Scheduled tasks** — all active cron jobs, what they do, frequency
- **Recent changes log** — last 20 entries, newest first: what changed, who did it, when

Format (append-only for the log section):

```markdown
## Bots

| Bot | Group | Purpose | Memory |
|-----|-------|---------|--------|
| TataNano | telegram_main | Personal assistant | SQLite + vector |
| ... | | | |

## Scheduled Tasks

| ID | Group | Schedule | Purpose |
|----|-------|----------|---------|
| memory-reindex-telegram_main | telegram_main | 0 12,22 * * * | Rebuild vector index |
| ... | | | |

## Change Log

### 2026-04-04 — Coder-bot
- Changed memory indexer schedule from weekly to twice-daily (0 12,22 * * *)
- Added indexing for telegram_deutschflow and telegram_linguaflow groups

### 2026-03-21 — Coder-bot
- Deployed coder-bot to production
...
```

### 2. Rule in `global/CLAUDE.md` — all bots read manifest on start

Add a section to the global CLAUDE.md that every bot inherits:

```markdown
## System Manifest

Read `/workspace/project/system-manifest.md` at the start of any session where
you are about to make system-level changes (new scheduled tasks, new bots,
config changes). This gives you full awareness of what is already running.

After making any system-level change, append an entry to the Change Log section.
```

### 3. Rule in coder-bot's CLAUDE.md — update manifest after every deploy

Add to `/workspace/project/data/sessions/telegram_dev/.claude/CLAUDE.md` (or equivalent coder-bot instructions):

```markdown
## After every implementation

After shipping any change, append to `/workspace/project/system-manifest.md`:
- Date, your role (Coder-bot)
- What changed (1-3 bullet points)
- Any new scheduled tasks (ID, group, schedule, purpose)
- Any files or skills added/modified
```

---

## What We Are NOT Doing

- **Not building a message bus or pub/sub between bots** — too complex, not needed
- **Not auto-notifying Bartek on every change** — would be noisy
- **Not adding a database table** — flat markdown file is enough, human-readable, no infra
- **Not version-controlling the manifest separately** — it lives in the repo, git handles history

---

## Files Affected

| File | Change |
|------|--------|
| `/workspace/project/system-manifest.md` | Extend with bots registry, scheduled tasks, change log |
| `/workspace/project/groups/global/CLAUDE.md` | Add "System Manifest" section (~8 lines) |
| `/workspace/project/data/sessions/telegram_dev/.claude/CLAUDE.md` or coder-bot CLAUDE.md | Add post-deploy update rule |

---

## Open Questions

1. **Who populates the initial manifest?** — TataNano can do it now as a one-time task, pulling from the DB audit we just ran.
2. **What triggers a "system-level change"?** — Any new scheduled task, new bot registration, new skill, config change. Normal conversations don't need logging.
3. **Does bart-bot need this?** — No. Bart-bot is isolated by design, no system changes come from it.

---

## Expected Outcome

Any bot, at any time, can read one file and know:
- What bots exist and what they do
- What cron jobs are running
- What has changed recently and who changed it

No more silent drift between what's built and what bots know about.
