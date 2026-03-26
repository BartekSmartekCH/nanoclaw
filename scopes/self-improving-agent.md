# Scope: Self-Improving Agent

**Inspired by:** clawhub.ai/pskoett/self-improving-agent
**Status:** Ready to build
**Date:** 2026-03-24

---

## Problem

Each NanoClaw container session starts fresh. Corrections, mistakes, and insights from past conversations are lost unless manually added to `CLAUDE.md`. Over time this means repeating the same errors, re-explaining the same preferences, and losing hard-won context.

---

## Goal

Give TataNano's main chat agent a persistent learning layer: it logs errors and corrections as they happen, and periodically promotes recurring patterns into permanent memory (`CLAUDE.md`).

---

## Key Constraint vs OpenClaw

OpenClaw agents are long-running — hooks and shell scripts can fire automatically throughout a session. NanoClaw containers are **ephemeral** — spawned per message, killed after. This means:

- No background processes or hooks inside the container
- All persistence must go through the mounted group folder (`/workspace/group/`)
- Periodic review must be driven by NanoClaw's **scheduler**, not the agent itself

---

## Design

### 1. Learning files

Three markdown files in `groups/telegram_main/`:

```
.learnings/
  ERRORS.md          # mistakes made, wrong approaches
  CORRECTIONS.md     # explicit user corrections ("no, not like that")
  INSIGHTS.md        # better approaches discovered mid-session
```

Each entry is structured:

```markdown
## LRN-20260324-001
**Type:** correction | error | insight
**Session:** 2026-03-24
**Summary:** One line description
**Detail:** What happened, what the right approach is
**Status:** pending | promoted
```

### 2. Agent instructions

Two new behaviours added to `groups/telegram_main/CLAUDE.md`:

**On session start:** Read `.learnings/ERRORS.md` and `.learnings/CORRECTIONS.md` — apply any `pending` entries as active constraints for this session.

**During session:** Log to `.learnings/` when:
- User explicitly corrects you ("no", "wrong", "don't do that", "I said X not Y")
- You hit a tool/API error you didn't anticipate
- You discover a clearly better approach than what you tried first

Do **not** log routine task completion or general conversation.

### 3. Promotion (scheduler task)

A scheduled task runs weekly for the Bartek group:

1. Reads all `pending` entries in `.learnings/`
2. Groups by pattern (same type + similar topic)
3. If a pattern appears **3+ times** → appends a one-line imperative rule to `groups/telegram_main/CLAUDE.md`
4. Marks those entries as `promoted`

This keeps `CLAUDE.md` from bloating — only recurring patterns graduate to permanent memory.

### 4. Manual promote command

Telegram command `/promote_learnings` (main group only) — triggers the promotion pass immediately without waiting for the scheduler. Useful after a correction-heavy session.

---

## What is NOT in scope

- Cross-group learning sharing (each group is isolated)
- Automatic skill extraction (OpenClaw feature, not applicable here)
- Changing how the container runner or proxy work
- Any UI beyond the Telegram command

---

## Files to change

| File | Change |
|------|--------|
| `groups/telegram_main/CLAUDE.md` | Add "log and read learnings" instructions |
| `container/skills/self-improving/SKILL.md` | Skill doc with logging format and triggers |
| `src/task-scheduler.ts` or DB | Add weekly promotion task for Bartek group |
| `src/channels/telegram.ts` | Add `/promote_learnings` command |

---

## Decisions

- **Scope:** Bartek main chat only (`groups/telegram_main/`)
- **Promotion format:** One-line imperative in `CLAUDE.md` (e.g. `Always confirm before deleting files.`)
- **Cross-group:** Not in scope — per-group isolation maintained
