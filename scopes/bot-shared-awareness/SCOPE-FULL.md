# Bot Shared Awareness + Cross-Bot Memory — Full Scope

**Status:** Proposed
**Date:** 2026-04-04
**Replaces/Extends:** `SCOPE.md` (system manifest only)

---

## Problem Statement

Two separate but related gaps:

**Gap 1 — System change blindness**
When any bot implements a change (new scheduled task, config change, code fix), no other bot knows. TataNano learned about the twice-daily reindex schedule through a manual audit, not from the system itself. Already scoped in `SCOPE.md` — included here for completeness.

**Gap 2 — Memory islands**
Every bot's knowledge is siloed. CoderBot has no persistent memory at all. CrawlerBot's scraped leads are invisible to everyone else. NanoClaw groups can only search their own conversation history. If CoderBot implements a feature today, TataNano cannot recall it next week without reading source files manually.

---

## Current State

| Bot | Conversation Archive | Vector Index | Accessible To Others? |
|-----|---------------------|-------------|----------------------|
| telegram_main | ✓ `groups/telegram_main/conversations/` | ✓ 5.5MB | ✗ No |
| telegram_dev | ✓ | ✓ 5.5MB | ✗ No |
| telegram_deutschflow | ✓ | ✓ | ✗ No |
| telegram_linguaflow | ✓ | ✓ | ✗ No |
| CoderBot | ✗ Nothing | ✗ Nothing | — |
| CrawlerBot | ✗ Nothing | ✗ Nothing | — |
| Bart | ✗ (by design) | ✗ (by design) | — |
| Mama | ✗ | ✗ | — |

**Key infrastructure fact:**
The indexer (`container/skills/memory-search/indexer.py`) already works for any group — it just needs `--group <name>` and a `conversations/` folder with markdown files. No code changes needed to support new groups.

**Key access fact:**
- Main group containers mount the entire project dir RO → can already read `groups/coder/` if it existed
- Non-main group containers mount only `groups/global/` RO → cannot see per-bot indexes unless added to global mount
- CoderBot runs natively on the host → has full R/W access to all of `groups/`

---

## Proposed Architecture

### Three layers. Each independent, each delivers value alone.

---

### Layer 1 — System Manifest *(from existing SCOPE.md)*

A single file `system-manifest.md` at the project root. All bots read it on system-level tasks. All bots append to it after making changes.

**Content:**
- Bots registry (name, purpose, memory type)
- Active scheduled tasks (ID, group, schedule, what it does)
- Change log (append-only, newest first)

**Who updates it:** Primarily CoderBot. Rule added to CoderBot's CLAUDE.md.
**Who reads it:** All bots via their respective mounts.

**Files touched:**
- `system-manifest.md` (new, project root)
- `groups/global/CLAUDE.md` (add 8-line "read manifest" rule)
- `~/.claude-coder/CLAUDE.md` (add "update manifest after deploy" rule)

**Size:** Small. ~2 days of work to bootstrap initial content + add rules.

---

### Layer 2 — CoderBot Conversation Archive + Index

CoderBot currently has zero memory. Every restart = blank slate. Every conversation is lost.

**What to build:**

After each completed Claude session, CoderBot appends to:
```
groups/coder/conversations/YYYY-MM-DD.md
```

Format matches existing NanoClaw convention (timestamps, role labels). One file per day.

A scheduled task (cron `0 12,22 * * *`, same as other groups) runs the indexer:
```
python3 indexer.py --group coder --base /workspace/project --index-dir /workspace/group/memory-index
```

The index lives at:
```
groups/coder/memory-index/index.json
```

**Cross-access:**
Main group container already mounts `/workspace/project` RO → TataNano can read `groups/coder/memory-index/index.json` directly and run semantic search over CoderBot's history.

**Decision needed:** Should CoderBot's coding sessions be searchable by ALL bots (via global mount) or only by main group (via project mount)?
- Option A: Main group only — simpler, no mount changes
- Option B: All groups — requires adding `groups/coder/memory-index/` to the global mount

**Files touched:**
- `coder-bot/src/claude.ts` (~20 lines: append to archive after each run)
- `store/messages.db` (new scheduled task row for coder reindex)

---

### Layer 3 — CrawlerBot Job Summary Archive + Index

CrawlerBot has a rich SQLite DB (`crawler-bot/data/tatanano.db`) with scraped pages and extracted leads — but it's completely invisible to all other bots.

**What to build:**

A Python export script (`crawler-bot/tatanano/exporter_md.py`) that runs after each crawl job completes. It converts the job summary to markdown:

```
groups/crawler/conversations/YYYY-MM-DD-job-<name>.md
```

Format example:
```markdown
## Crawl Job: Polish Architects Warsaw — 2026-04-04

**URLs crawled:** 47
**Leads extracted:** 12

### Leads
- Jan Kowalski | jan@studio.pl | Studio K | Architect | Warsaw
- ...

### Summary
Job scraped 47 pages from studio-k.pl, extracted 12 contacts...
```

Same indexer runs on `groups/crawler/` — leads become semantically searchable.

TataNano can then answer: *"What architects did we scrape last month in Kraków?"*

**Decision needed:** Trigger for export — run after every job completion, or on a daily schedule?
- Option A: After every `/crawl` command completes (real-time)
- Option B: Nightly export of all completed jobs

**Files touched:**
- `crawler-bot/tatanano/exporter_md.py` (new, ~50 lines Python)
- `crawler-bot/tatanano/bot.py` (call exporter after crawl completes)
- `store/messages.db` (new scheduled task row for crawler reindex)

---

### Layer 4 — Global Shared Memory Index *(optional, depends on decisions above)*

Currently non-main groups (DeutschFlow, LinguaFlow) can only search their own conversations. They cannot search system history, coder sessions, or crawl results.

**Option A — No global index (simplest)**
Only main group (TataNano) gets cross-bot memory via its project mount. Non-main groups stay isolated. This is the right default.

**Option B — Selective global index**
A nightly task merges selected chunks from all indexes into:
```
groups/global/memory-index/index.json
```
Non-main groups get this via their `/workspace/global/` mount.

**Recommendation:** Start with Option A. Option B only if a concrete need emerges (e.g., DeutschFlow needing to know about system changes).

---

## Phased Delivery

| Phase | What | Value | Effort |
|-------|------|-------|--------|
| 1 | System manifest | All bots know what changed | Small (~1 day) |
| 2 | CoderBot archive + index | CoderBot memory survives restarts, TataNano can recall coding history | Small (~1 day) |
| 3 | CrawlerBot export + index | Leads become searchable via TataNano | Medium (~2 days) |
| 4 | Global index merge | All groups see cross-bot memory | Medium, defer |

Phases 1 and 2 are independent. Phase 3 is independent. Phase 4 depends on 2 and 3.

---

## Open Decisions

**D1:** CoderBot coding sessions — accessible to main group only (Option A) or all groups (Option B)?

**D2:** CrawlerBot export trigger — after each job (Option A) or nightly batch (Option B)?

**D3:** Start with Phase 1 only, or 1+2 together?

**D4:** Should Mama bot's health events (glucose logs, medication) be archived to markdown and indexed? Low value for search, but creates an audit trail. Out of scope for now unless you want it.

---

## What Is Explicitly Out Of Scope

- Bart bot memory (ephemeral by design — it's a personality chatbot, not a knowledge system)
- Cross-bot real-time messaging or pub/sub
- Centralised vector database (Chroma, Pinecone etc.) — the flat JSON index is sufficient
- Automatic git-triggered manifest updates (CoderBot writes manually after deploys)
