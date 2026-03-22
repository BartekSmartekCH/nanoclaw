# Option B — Dedicated Coder Bot (Scope)

## What it is
A standalone Telegram bot running natively on the Mac mini host (no Docker container), connected directly to a Claude Code session. Full read/write access to the NanoClaw project. Its own OAuth token, independent from TataNano.

## Use case
Talk directly to Claude Code from Telegram — edit files, run builds, commit code — without going through the 4-person dev team workflow. A direct terminal companion via Telegram.

## Architecture

```
Telegram → @PomocnikFourBot → lightweight Node.js listener
                                       ↓
                              Claude Code (native, host)
                                       ↓
                              ~/nanoclaw (full read/write)
```

- Own launchd plist: com.nanoclaw.coder
- Own Claude Code install: separate ~/.claude profile
- Own OAuth token: separate Keychain entry

## What it can do
- Edit any file in ~/nanoclaw directly
- Run npm run build, git, npx vitest
- Commit to staging branch without worktree tricks
- Answer questions about the codebase with full context

## What it cannot do
- Access files outside ~/nanoclaw (scoped for safety)
- Act without Bartek's instruction (no autonomous tasks)
- Be used by anyone other than Bartek's Telegram user ID

## Security model
- Restricted to Bartek's Telegram user ID only — hardcoded, not configurable via chat
- Scoped to ~/nanoclaw working directory
- All actions logged
- git is the safety net — every change is a commit, revertible in 30 seconds

## Auth
- Own Claude Code OAuth installation
- Own Keychain entry
- Token expiry independent from TataNano
- Same fix needed if it expires — but failures are isolated

## What gets built
1. Lightweight Telegram listener (Node.js, ~300 lines)
2. Wrapper that spawns Claude Code with --no-container flag
3. com.nanoclaw.coder launchd plist
4. Scope-limiting config (allowedPaths: ~/nanoclaw)

## Effort
Medium — 1-2 days for the dev team using the /dev skill.

## Relationship to dev group
Complementary, not competing:

| | Dev group | Option B |
|--|-----------|----------|
| Team | 4 bots | Just you + Claude Code |
| Workflow | RFC → approve → implement | Direct conversation |
| Best for | Structured features | Quick fixes, exploration |
| Safety | RFC approval gate | Git commits |

## Status
Scoped. Not yet started. Implement via /dev skill in the development group.
