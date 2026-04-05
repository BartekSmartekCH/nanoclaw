# Memory Improvements — Scope

**Status:** Draft
**Date:** 2026-04-05
**Author:** CoderBot (discussion with Bartek)

---

## Problem

NanoClaw has a functional memory system (archive + vector index) but three gaps limit its value:

1. **Low recall quality** — raw verbatim conversations are indexed. High noise, bad chunk boundaries, decisions buried in filler text.
2. **No proactive recall** — agents only see past context if they explicitly search for it. They rarely do.
3. **Stale container gap** — if a container goes stale mid-session, the indexer never fires until the next scheduled run (up to 12 hours later).

---

## Solution — Three Parts

### Part 1: Synthesis layer (storage quality)

After each session ends, run a synthesis pass using Ollama (`qwen2.5:7b`, already installed) that extracts structured knowledge from the conversation:

```
## 2026-04-05

**Decisions:** Fixed credential proxy — now reads OAuth token fresh from .env per request
**Built:** coder-bot session memory marker file (~/.claude-coder/coder-session)
**Open:** Lead scraper Phase 1 awaiting go-ahead
```

Stored in `groups/{name}/knowledge.md` — append-only, one entry per session.

**Raw archives stay.** Grep-friendly, full audit trail. The index covers knowledge.md first (high signal), raw archive second (full history).

**CoderBot:** Same synthesis pass, triggered in `triggerIndexer()` in `coder-bot/src/claude.ts` after each successful exchange. Writes to `groups/coder/knowledge.md`.

---

### Part 2: Indexing reliability

**Option B — Trigger on stale container:**
When a container is detected as stale/dead, immediately trigger the indexer for that group. Hooks into the stale container cleanup path in `src/index.ts`. ~5 lines. Ensures a full day's work gets indexed within seconds of the container dying, not at the next scheduled run.

**More frequent schedule:**
Change scheduled reindex from twice daily (`0 12,22 * * *`) to every 3 hours (`0 */3 * * *`). Catch-all safety net for any edge case Option B misses (crash recovery, missed exits, manual edits to archive files). Near-zero cost on local Ollama.

Both together: Option B handles the specific stale case immediately; the schedule catches everything else.

---

### Part 3: Proactive context injection (access)

Before a session starts, search the index with the incoming message as the query. Take top-3 relevant chunks from knowledge.md. Inject into the agent's context automatically.

**Injection timing: once per session for both system and group knowledge.**

Both are retrieved at session start using the first message as the query. No re-injection mid-session. Group knowledge is low-churn personal context (preferences, ongoing threads, past decisions) — it doesn't change meaningfully within a session, and the first message captures the dominant topic well enough. Topic-change detection was considered but rejected: it requires an embedding call per message (same cost as full re-injection), adds state complexity, and the marginal value is low given containers auto-restart on idle timeout.

**For containers** (`src/container-runner.ts`):
Query index before spawning. Pass result as an additional environment variable or mounted snippet. Agent sees it in its context at session start. No tool call needed, no instruction in CLAUDE.md needed.

```
[Memory]
System: credential proxy reads token fresh per request (fixed 2026-04-05)
System: lead scraper Phase 1 scoped, not yet built
Group: Bartek prefers commits per logical unit
[/Memory]
```

**For CoderBot** (`coder-bot/src/claude.ts`):
Same search, different injection point. In `runClaude()`, query the index before building the CLI args. Prepend the memory block to the prompt string passed to the CLI.

```ts
const memory = await searchMemory(prompt, 'coder')
const augmentedPrompt = memory ? `${memory}\n\n${prompt}` : prompt
// then: args.push(augmentedPrompt)
```

---

## Files Touched

| File | Change |
|------|--------|
| `container/skills/memory-search/indexer.py` | Add synthesis pass using Ollama after indexing raw chunks |
| `container/skills/memory-search/search.py` | New: query index, return top-k formatted as memory block |
| `src/container-runner.ts` | Call search.py before spawn, inject result into container context |
| `src/index.ts` | Trigger indexer on stale container detection (Option B) |
| `src/task-scheduler.ts` | Change schedule from `0 12,22 * * *` to `0 */3 * * *` |
| `coder-bot/src/claude.ts` | Query index before runClaude, prepend memory to prompt |
| `container/skills/memory-search/indexer.py` | Check `.synthesis-pending` flag on each run, retry if present |
| `src/index.ts` | Send Telegram alert if `.synthesis-pending` flag older than 3 hours |

---

## Shared System Knowledge (Option 2)

Per-group `knowledge.md` keeps group contexts isolated, but creates a blind spot: CoderBot builds things based on decisions made in telegram_main, and vice versa. They never see each other's knowledge.

**Solution: one shared `groups/system/knowledge.md`**

A single cross-cutting knowledge file, written by any bot, readable by all. Only for system-level facts — architecture decisions, what's been built, open items that span multiple bots.

```
groups/
  system/
    knowledge.md        ← shared, all bots read this
  telegram_main/
    knowledge.md        ← personal assistant context only
  coder/
    knowledge.md        ← coding session context only
```

**Rules:**
- Each bot still writes to its own `knowledge.md` for group-specific context
- Any bot can APPEND to `groups/system/knowledge.md` when a system-level decision is made
- No bot can delete or overwrite system knowledge — append-only
- system knowledge is injected alongside group knowledge at session start (lower weight — top-1 chunk vs top-3 from group)

**What goes in system knowledge:**
- Architecture decisions ("SQLite for all local storage")
- What bots exist and what they do (mirrors system-manifest.md but synthesized)
- Cross-cutting bugs fixed ("credential proxy stale token — fixed 2026-04-05")
- Active projects and their status ("lead scraper Phase 1 — awaiting go-ahead")

**What stays in group knowledge:**
- Conversation-specific context
- Personal preferences discussed in that group
- Tutor progress (DeutschFlow, LinguaFlow)

**Files added:**
| File | Change |
|------|--------|
| `groups/system/knowledge.md` | New shared file, created on first write |
| `container/skills/memory-search/indexer.py` | Index system knowledge alongside group knowledge |
| `src/container-runner.ts` | Inject top-1 system chunk + top-3 group chunks |
| `coder-bot/src/claude.ts` | Same — prepend system + group memory to prompt |

**Synthesis routing logic (in indexer):**
After synthesis, Ollama pass decides: is this fact system-level or group-level? System-level facts get appended to `groups/system/knowledge.md`. Group-level facts go to `groups/{name}/knowledge.md`. This keeps the shared file clean — only things that matter across bots end up there.

---

## What's NOT in scope

- Real-time in-session indexing (indexer runs after session, not during)
- Changing the embeddings model (nomic-embed-text is sufficient)
- Retroactive synthesis of existing archives (forward-only from implementation date)

---

## Open Questions

1. **Synthesis prompt** — how much to extract per session? Risk of over-summarizing (losing nuance) vs under-summarizing (still noisy). Proposed: 5-10 bullet points max per session.
2. **knowledge.md growth** — append-only means it grows indefinitely. After 6 months it could be 50k+ tokens. Compact quarterly? Or cap at last N entries for indexing?
3. **Injection token budget** — top-3 chunks from knowledge.md could be 300-500 tokens. Acceptable overhead per session. Confirm.
4. **Synthesis failure handling** — Ollama failures handled via Option B + C below (flag + alert). Raw archive still indexed on failure.

**Option B — Mark and retry:**
When synthesis fails, write a flag file (`groups/{name}/.synthesis-pending`). The scheduled indexer (every 3 hours) checks for this flag on each run and retries synthesis before indexing. Closes the gap automatically without human involvement.

**Option C — Alert:**
If a `.synthesis-pending` flag has existed for more than one scheduled cycle (i.e. Ollama has been down 3+ hours), send a Telegram notification to Bartek. One alert per group per outage — no spam.

**CoderBot synthesis failure:** Same pattern. Flag file at `groups/coder/.synthesis-pending`. CoderBot runs on host so it checks the flag at start of `triggerIndexer()`. Alert sent via Telegram to Bartek's chat ID if flag is older than 3 hours.

---

## Build Phases

### Phase 1+2 — Reliability + Synthesis (merged, linear execution)

Merged because Phase 1 alone (indexing raw archives more frequently) has no user-visible value until synthesis exists. Synthesis without reliability fixes means the improved indexer won't fire after stale containers. They ship together.

---

#### Step 1 — Schedule bump

**What:** Update `next_run` and `schedule_value` for all 4 active memory-reindex tasks from `0 12,22 * * *` to `0 */3 * * *`.

**How:** Two SQL UPDATEs on `store/messages.db`.

```sql
UPDATE scheduled_tasks
SET schedule_value = '0 */3 * * *',
    next_run = datetime('now', '+3 hours')
WHERE id LIKE 'memory-reindex-%' AND status = 'active';
```

**Files touched:** none (DB only)

**Test:** Verify with `SELECT id, schedule_value, next_run FROM scheduled_tasks WHERE id LIKE 'memory-reindex-%';`

---

#### Step 2 — Stale container indexer trigger

**What:** When the idle timer fires and closes a container's stdin, immediately set `next_run = now` for that group's memory-reindex task. The scheduler loop (runs every 60s) picks it up and fires the indexer within 1 minute.

**How:** In `src/index.ts`, in `resetIdleTimer()`, after `queue.closeStdin(chatJid)`:

```ts
// Trigger memory reindex immediately on stale container
const reindexTaskId = `memory-reindex-${group.folder}`;
const reindexTask = getTaskById(reindexTaskId);
if (reindexTask?.status === 'active') {
  updateTask(reindexTaskId, { next_run: new Date().toISOString() });
  logger.info({ group: group.name }, 'Triggered memory reindex after idle timeout');
}
```

**Imports to add:** `getTaskById`, `updateTask` from `./db.js`

**Files touched:** `src/index.ts`

**Test:** Start a container session, let it go idle (or manually trigger idle timeout), confirm `next_run` gets updated in DB and indexer fires within 60s.

---

#### Step 3 — Synthesis pass in indexer

**What:** After indexing raw archive chunks, run an Ollama pass (`qwen2.5:7b`) over the newly indexed files to extract structured facts. Append results to `groups/{name}/knowledge.md`.

**Format of extracted output:**

```markdown
## 2026-04-05

**Decisions:** Fixed credential proxy stale token — now reads OAuth token fresh from .env per request
**Built:** coder-bot session memory marker file
**Open:** Lead scraper Phase 1 awaiting go-ahead
**Preferences:** Bartek prefers commits per logical unit
```

**Logic in `indexer.py`:**
1. Collect which files were newly indexed in this run (already tracked in loop)
2. For each new file, concatenate its raw text (truncated to 6000 chars to fit context)
3. POST to Ollama `/api/generate` with `qwen2.5:7b` and a structured extraction prompt
4. Parse response, append to `knowledge.md` with date header
5. On Ollama failure: write `groups/{name}/.synthesis-pending` flag file, continue (raw index still saved)

**Retry logic:**
At the start of each indexer run, check for `.synthesis-pending`. If present and Ollama is reachable, process the flag file's listed sessions first, then delete the flag.

**Files touched:** `container/skills/memory-search/indexer.py`

**Test:**
1. Run indexer manually on a group with existing conversations: `python3 container/skills/memory-search/indexer.py --group telegram_main`
2. Verify `groups/telegram_main/knowledge.md` is created and populated
3. Kill Ollama, re-run — verify `.synthesis-pending` flag is written and raw index still updates

---

#### Step 4 — Index knowledge.md alongside archives

**What:** Add `knowledge.md` as a priority source in the indexer. Index it alongside archive chunks. Chunks from `knowledge.md` get a `source: "knowledge"` tag so they rank higher in search results.

**How:** In `indexer.py`, after processing `conversations/`, check if `groups/{name}/knowledge.md` exists. Run it through `chunk_text()`. Add each chunk with `"source": "knowledge"` in the metadata. These replace any previous `knowledge` chunks on each run (knowledge.md is append-only, so re-indexing it is safe).

**Files touched:** `container/skills/memory-search/indexer.py`

**Test:**
1. Ensure knowledge.md has content from Step 3
2. Run indexer again, verify chunks with `source: "knowledge"` appear in `index.json`
3. Manually call search.py (if exists) or inspect index for a known fact from knowledge.md

---

### Pause point after Phase 1+2

Before proceeding to Phase 3 (proactive injection), review:
- Is knowledge.md content quality good? (check actual extracted facts)
- Is synthesis latency acceptable? (qwen2.5:7b pass adds ~10-30s per session to indexer run)
- Any edge cases from stale trigger?

Proposal for Phase 3 go-ahead only after Bartek confirms quality.

---

### Phase 3 — Proactive injection (separate, later)
- `search.py` utility
- `src/container-runner.ts` injection (top-3 group + top-1 system)
- CoderBot prompt augmentation (same)
- Injection format: `[Memory]...[/Memory]` block prepended to session start

### Phase 4 — Shared system knowledge (separate, later)
- `groups/system/knowledge.md`
- Synthesis routing: Ollama decides system-level vs group-level per fact
- All bots read system knowledge at injection time

---

## Status

Phase 1+2 scoped and ready. Awaiting go-ahead.
