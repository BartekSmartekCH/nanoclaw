# NotebookLM Knowledge Hub — Scope

**Status:** Draft
**Date:** 2026-04-08
**Author:** CoderBot (discussion with Bartek)

---

## Problem

NanoClaw agents operate with limited context. Research data, articles, PDFs, project notes, and historical decisions either get lost or pollute the Claude context window. The current memory system (conversation archives + knowledge.md) works for session recall but doesn't cover:

1. **External knowledge** — articles, docs, PDFs, links Bartek finds useful
2. **Cross-project context** — info that spans multiple groups and bots
3. **On-demand depth** — agent needs a focused summary, not 50 pages of raw data
4. **Planning context** — daily/weekly decisions need background that shouldn't live in the prompt

---

## Solution: NotebookLM as External Knowledge Layer

Use Google NotebookLM as a managed knowledge repository. Bartek dumps raw sources (URLs, PDFs, notes, conversation exports) into organized notebooks. NanoClaw agents query NotebookLM on demand for grounded, cited summaries — keeping the context window clean.

### Integration: `notebooklm-mcp-cli`

The Python MCP server (`pip install notebooklm-mcp-cli`) exposes 35 tools directly to container agents via MCP protocol. No custom skill code needed — just config.

**Why MCP over Python library:**
- Agent decides when to consult NotebookLM autonomously
- No wrapper skill to build or maintain
- 35 tools available out of the box (query, create, add sources, generate audio, research)
- Fits NanoClaw's existing MCP server pattern (already uses `mcp__nanoclaw__*`)

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Bartek    │────>│   NotebookLM     │<────│  NanoClaw Agent  │
│  (browser)  │     │  (Google cloud)  │     │  (container)     │
│             │     │                  │     │                  │
│ dumps URLs, │     │ Notebooks:       │     │ MCP tools:       │
│ PDFs, notes │     │  - Projects      │     │  notebook_query  │
│             │     │  - Research      │     │  notebook_list   │
│             │     │  - Architecture  │     │  source_add      │
│             │     │  - Decisions     │     │  studio_create   │
└─────────────┘     └──────────────────┘     └──────────────────┘
                           │
                    Grounded summaries
                    with citations
```

### Auth Flow

1. **One-time setup on Mac host:**
   - Install Chrome debug mode: `open -a "Google Chrome" --args --remote-debugging-port=9222`
   - Run `nlm login` — extracts session cookies
   - Cookies stored in `~/.config/nlm-auth/`
2. **Container access:**
   - Mount `~/.config/nlm-auth/` read-only into containers
   - MCP server runs inside the container, uses stored cookies
   - No Chrome needed at runtime
3. **Refresh:**
   - Cookies expire every 2-4 weeks
   - Re-run `nlm login` on host when needed
   - Consider a cron job that checks auth health (`nlm doctor`)

### Dedicated Google Account

Use a throwaway Google account (not Bartek's main) to isolate risk. NotebookLM uses undocumented internal APIs — Google has disabled at least one account for bot-like access patterns. A dedicated account means worst case = re-create the account, not lose Gmail/Drive/Photos.

---

## Notebook Organization

Two categories of notebooks: **core** (fixed, always present) and **ad-hoc** (created on demand, growing over time).

### Core Notebooks — NanoClaw's Long-Term Brain

These are NanoClaw's persistent memory. They represent what the system *knows* across all sessions and groups. Always present, continuously updated. Think of them as the brain areas that are always active.

| Notebook | Brain Function | What Goes In |
|----------|---------------|--------------|
| **[Core] System Architecture** | Self-knowledge | How NanoClaw works — architecture, decisions, tradeoffs, container system, memory pipeline, channel setup. So agents understand their own infrastructure. |
| **[Core] Projects & Decisions** | Episodic memory | What's been built, what's in progress, what was decided and why. Historical context that prevents agents from re-asking or contradicting past decisions. |
| **[Core] Preferences & Rules** | Behavioral guidelines | Hard rules (security, .env, no inbound internet), soft preferences (concise responses, Polish for mama-bot), tool choices (edge-tts over Google TTS). What to always/never do. |

### Ad-hoc Notebooks — Bartek's Knowledge Library

These grow organically as Bartek explores topics, researches tools, or works on projects. Each notebook is a deep-dive into a specific subject.

Examples:
- `[Research] Video Generation 2026` — Veo 2, Runway, Kling comparisons
- `[Research] CGM & Diabetes` — articles, studies for MamaZdrowie
- `[Project] Lead Scraper` — market research, architecture options
- `[Project] Bart Bot Pool` — multi-persona design, TTS voices
- `[Ref] German Grammar` — resources for DeutschFlow tutor
- `[Ref] AI Agent Frameworks` — Claude SDK, LangGraph, CrewAI
- `[Learn] Home Automation` — smart home ideas, product reviews

### Agent Discovery — Title-Based

The notebook collection will grow over time. Agents discover relevant notebooks by scanning titles via `notebook_list`.

**Discovery flow:**

1. **`notebook_list`** — agent scans all available notebooks by title
2. **Core notebooks** — agent recognizes core notebooks by their `[Core]` prefix and consults them first for baseline context
3. **Title matching** — agent picks ad-hoc notebooks relevant to the current task by reading their titles
4. **`cross_notebook_query`** — for broad questions spanning multiple topics

No tags, no local metadata files. Simple and stateless.

Bartek maintains all notebooks via the web UI. Agents query but don't manage notebooks. In the future, agents may add conversation exports as sources automatically.

---

## Agent Behavior: NotebookLM as Primary Source

### Container CLAUDE.md Addition

Add to `groups/global/CLAUDE.md` and `groups/telegram_main/CLAUDE.md`:

```markdown
## Knowledge Lookup Protocol

NotebookLM is Bartek's extended memory — a growing collection of curated notebooks
covering architecture, active projects, research topics, and reference material.
Treat it as your primary knowledge source.

### When to consult NotebookLM

- Before starting any task that needs background context
- When planning or making architecture decisions
- When Bartek references a topic he's been researching
- During daily/weekly planning to check project status
- Before recommending a tool, library, or approach

### How to consult NotebookLM

1. **Discover:** `notebook_list` to see all available notebooks
2. **Select:** Pick the most relevant notebook(s) by title
3. **Query:** `notebook_query` with a focused question
4. **Cross-reference:** Use `cross_notebook_query` when the topic spans multiple notebooks
5. **Act:** Use the grounded, cited answer — don't re-research what's already there

### Priority order for information

1. NotebookLM (Bartek's vetted, curated sources)
2. Local project files and memory-index
3. Web search (only if NotebookLM doesn't cover it)
4. Ask Bartek

### What NOT to do

- Don't dump raw NotebookLM responses into conversation — summarize
- Don't query every notebook on every task — pick relevant ones by title
- Don't cache notebook contents across sessions — always query fresh
```

### When Agents Should Query NotebookLM

| Situation | What to query |
|-----------|---------------|
| Starting a new task | "What decisions have been made about X?" |
| Planning implementation | "What is the architecture for X? Any constraints?" |
| Encountering unfamiliar code | "What does the X system do? How was it designed?" |
| Debugging | "Have there been past issues with X?" |
| Daily/weekly planning | "What are the active projects and their status?" |
| Before suggesting a tool/library | "Has Bartek evaluated X? Any preferences?" |

---

## Implementation Plan

### Phase 1: MCP Server Setup

1. Install `notebooklm-mcp-cli` on the Mac host
2. Create dedicated Google account for NotebookLM
3. Run `nlm login` to authenticate
4. Test CLI: `nlm notebook list`, `nlm notebook query`
5. Add MCP server config to container runner (`src/container-runner.ts` or agent-runner-src)
6. Mount auth cookies into containers
7. Verify agent can call `notebook_query` from inside container

### Phase 2: Seed Notebooks

1. Create the notebook structure (see table above)
2. Add key NanoClaw docs as sources (CLAUDE.md, REQUIREMENTS.md, scope docs)
3. Add any external research/articles Bartek wants available
4. Test queries from the agent — verify grounded answers

### Phase 3: Agent Instructions

1. Add Knowledge Lookup Protocol to global CLAUDE.md
2. Add NotebookLM tool hints to container skill docs
3. Test with telegram_main: send a message requiring project context, verify agent consults NotebookLM

### Phase 4: Audio Briefings (optional)

1. Use `studio_create` to generate podcast-style audio summaries
2. Weekly cron: generate an audio briefing of project status
3. Send as Telegram voice message via existing TTS pipeline

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Google changes internal APIs | MCP tools break | `notebooklm-mcp-cli` is actively maintained, fixes land in days. Fallback: agent uses web search |
| Account disabled | Lose notebook access | Use dedicated throwaway account. Export notebooks periodically |
| Cookie expiration | Auth fails silently | Add `nlm doctor` to daily cron, alert if unhealthy |
| Agent over-queries | Slow responses, rate limits | Set guidance in CLAUDE.md: query once per task, cache the answer |
| NotebookLM down/slow | Agent blocks waiting | Set MCP timeout, agent should proceed without if unavailable |

---

## Dependencies

- `pip install notebooklm-mcp-cli` (Python >= 3.11)
- Google Chrome on host (for initial auth only)
- Dedicated Google account with NotebookLM access
- Container volume mount for `~/.config/nlm-auth/`

---

## Success Criteria

- [ ] Agent can query NotebookLM from inside a container
- [ ] Agent consults NotebookLM before web search for project-related questions
- [ ] Bartek can add a URL/PDF via NotebookLM web UI and agent can find it within minutes
- [ ] Context window stays clean — no raw research data in prompts
- [ ] Auth survives 2+ weeks without manual intervention
