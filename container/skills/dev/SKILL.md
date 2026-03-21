# /dev Skill

## What this skill does

Assembles a 4-person development team to scope, implement, test, and review code changes to NanoClaw. All work happens in an isolated git worktree — live code is never touched until Bartek explicitly merges.

## Trigger conditions

- Bartek types `/dev [task description]` in the Development Group
- Only works in the Development Group (telegram_dev)

## Team roles

| Role | Pool bot | Responsibility |
|------|----------|---------------|
| TataNano | Main bot | Lead — coordinates team, communicates with Bartek |
| Architect | Pool bot 1 | Scopes the change using RFC/ADR/SPIKE format |
| Coder | Pool bot 2 | Implements in isolated worktree, commits to staging branch |
| Reviewer | Pool bot 3 | Cold-reads all changed files, checks for regressions |
| Tester | Pool bot 4 | Reviews/adds unit tests, writes smoke checklist |

## Workflow

### Stage 1 — Architect scopes

Architect reads relevant source files and posts a structured document to the dev group.

**Choose format based on task type:**

| Task type | Format |
|-----------|--------|
| New feature | RFC |
| Architectural choice | ADR |
| "Is this possible?" | SPIKE |
| Bug fix | Plain description, no format needed |

**RFC format:**
```
## Problem
## Proposed solution
## Files affected
## What we are NOT doing
## Open questions
```

**ADR format:**
```
## Context
## Decision
## Consequences
```

**SPIKE format:**
```
## Question
## Investigation
## Findings
## Recommendation
```

Bartek discusses, pushes back, clarifies inline in the dev group. **Nothing moves to implementation until Bartek explicitly approves.**

### Stage 2 — Coder implements

- Works in an isolated git worktree (separate branch, live code untouched)
- Follows the approved RFC/ADR exactly — no scope creep
- Writes unit tests alongside code
- Runs `npm run build` — must be zero errors
- Runs `npx vitest run` — must pass (or document pre-existing failures)
- Commits all changes to a `staging` branch
- Posts to dev group: build result, test result, list of changed files with brief description of each change

### Stage 3 — Tester and Reviewer work in parallel

**Tester:**
- Reviews Coder's unit tests
- Adds missing test cases
- Runs full test suite
- Writes a 2-3 step manual smoke checklist for Bartek to run after deploy
- Posts ✅ TESTS PASSED or ❌ TESTS FAILED with details

**Reviewer:**
- Cold-reads every changed file in full
- Checks: TypeScript correctness, null safety, consistent style, edge cases, no regressions
- Checks: does the implementation match the approved RFC?
- Posts ✅ APPROVED or ❌ CHANGES REQUESTED with specific file + line for every issue

If either posts ❌ — Coder fixes and both re-check. Repeat until both post ✅.

### Stage 4 — Ready to deploy

TataNano posts to the dev group:

```
✅ Ready to deploy — branch `staging`

On your Mac mini:
  git diff main..staging        # review what changed
  git merge staging             # apply
  npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw

Smoke test checklist:
  [Tester's checklist here]

If something breaks:
  git revert HEAD
  launchctl stop com.nanoclaw && launchctl start com.nanoclaw
```

## Rules for the team

- **Architect:** never start a second round of scoping without Bartek's approval on the first
- **Coder:** never touch files outside the RFC scope — if in doubt, ask Architect
- **Reviewer:** never approve code you haven't read line by line
- **Tester:** always include a manual smoke test — automated tests alone are not enough for Telegram bot behaviour
- **Everyone:** post updates to the dev group so Bartek can follow progress in real time

## What NOT to do

- Do not generate Python install scripts — use git commits only
- Do not patch files with string replacement — all changes go through proper git commits
- Do not merge to main — Bartek does that step manually after reviewing the diff
- Do not start coding before Bartek approves the RFC/ADR

## Notes

- All pool bots are already configured in TELEGRAM_BOT_POOL
- Bot assignment is round-robin per sender per group — consistent across the session
- Bots are renamed to their role (Architect, Coder, Reviewer, Tester) on first message
- Worktree is cleaned up automatically after merge
