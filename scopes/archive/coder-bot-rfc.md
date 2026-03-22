# RFC: Coder Bot — Direct Claude Access from Telegram
**Date:** 2026-03-21
**Status:** Stage 1 approved — ready for Stage 2

## Problem

NanoClaw development requires a 4-person team workflow (Architect → Coder → Reviewer) even for quick edits. Bartek needs direct access to Claude Code from Telegram for exploratory work, file editing, and build debugging without the RFC approval cycle.

TataNano and CoderBot cannot safely coexist on the same Mac mini without isolation: single Claude Code config dir `~/.claude`, single Keychain entry, risk of cross-bot interference.

## Proposed Solution

A separate Telegram bot (@CoderBot) running natively on the Mac mini (not Docker). Own bot token, own Keychain entries, own Claude Code config dir. Same launchd user as TataNano (`bartek`). Fully isolated.

## Architecture

```
Bartek → @CoderBot (new Telegram token)
       → coder-bot/src/index.ts (Node.js listener on Mac mini)
       → Claude Code subprocess (CLAUDE_CONFIG_DIR=~/.claude-coder)
       → ~/nanoclaw + ~/openclaw (whitelisted paths)
       → npm, git, npx, node (whitelisted commands)
```

## Keychain & Auth Design

Three separate Keychain entries:

| Service name | Owner | Content |
|---|---|---|
| `Claude Code-credentials` | TataNano (existing) | TataNano OAuth token |
| `NanoClaw-coder-credentials` | CoderBot (new) | CoderBot OAuth token |
| `NanoClaw-coder-telegram-token` | CoderBot (new) | CoderBot Telegram bot token |

Read at startup via:
```bash
security find-generic-password -s "NanoClaw-coder-credentials" -a bartek -w
security find-generic-password -s "NanoClaw-coder-telegram-token" -a bartek -w
```

Tokens are loaded into memory at startup — NOT stored in launchd plist env vars (that would be plaintext on disk).

## File System Isolation

```
/Users/bartek/
├── .claude/          (TataNano — unchanged)
├── .claude-coder/    (CoderBot — separate, set via CLAUDE_CONFIG_DIR env var)
├── nanoclaw/
│   └── coder-bot/    (CoderBot source code)
└── openclaw/         (read-only for CoderBot)
```

`CLAUDE_CONFIG_DIR=~/.claude-coder` is set in the environment before spawning Claude Code subprocess. This isolates session cache, config.json, and state files completely.

## Security Model

### Path Validation

```typescript
const ALLOWED_PATHS = [
  '/Users/bartek/nanoclaw',
  '/Users/bartek/openclaw',
];
const READONLY_PATHS = ['/Users/bartek/openclaw'];

function validatePath(userPath: string, isWrite: boolean): void {
  let canonical: string;
  try {
    canonical = fs.realpathSync(userPath);
  } catch {
    // Path doesn't exist yet — check parent dir instead
    const parent = path.dirname(userPath);
    const canonicalParent = fs.realpathSync(parent);
    canonical = path.join(canonicalParent, path.basename(userPath));
  }

  const isAllowed = ALLOWED_PATHS.some(
    allowed => canonical === allowed || canonical.startsWith(allowed + '/')
  );
  if (!isAllowed) {
    throw new Error(`Access denied: ${canonical} is outside allowed scope`);
  }

  if (isWrite && READONLY_PATHS.some(p => canonical.startsWith(p))) {
    throw new Error(`Write access denied: ${canonical} is read-only`);
  }
}
```

### Command Whitelist

Allowed: `npm`, `git`, `npx`, `node` — argument arrays only, never shell strings.

Forbidden: `cat`, `ls`, `rm`, `cp`, `mv`, `security`, `curl`, `wget`, shell pipes/metacharacters.

**npm:** All npm/npx commands run with `--ignore-scripts` flag to prevent postinstall script execution. Exception: `npm run build`, `npm test`, `npx vitest` — Bartek must explicitly confirm these before execution (bot asks "Run scripts? yes/no").

**git:** All standard git operations allowed within whitelisted paths. `git clone` is restricted to `https://github.com/BartekSmartekCH/` only — cloning from other URLs is blocked at the validator level. This prevents a compromised Telegram session from cloning malicious repos into whitelisted paths.

**node:** Executes scripts within whitelisted paths. Accepted risk — same trust level as keyboard access.

### Trust Boundary

CoderBot operates at **Bartek's keyboard trust level**. This means:
- If Bartek's Telegram account is compromised, an attacker has the same access as Bartek at the Mac mini keyboard — they can read/write ~/nanoclaw and ~/openclaw, run builds, commit code.
- This is explicitly acceptable because: CoderBot scope is limited to two directories; git history is the revert mechanism; Mac mini is a personal device.
- This trust boundary must be re-evaluated if CoderBot scope is expanded or other users are added.

### User ID Check

Bartek's Telegram user ID hardcoded **in source code** — not in any config file or env var. Config files within ~/nanoclaw are writable by Claude Code, so the user ID must not be stored there. Source code change requires a commit, creating an audit trail.

Checked on every incoming message before any processing. Unauthorized attempts logged and rejected.

### Telegram

Uses long-polling (not webhook) — simpler, no port exposure required.

User ID from Telegram API is authoritative (server-side) — cannot be spoofed by client.

### Logs

Logs stored at `~/Library/Logs/nanoclaw-coder/` — **outside** the whitelisted paths `~/nanoclaw` and `~/openclaw`. This prevents Claude Code from reading logs and exposing sensitive command history in responses.

Permissions: `chmod 0600` on all log files. Rotate weekly, keep 4 weeks.

## Process Lifecycle & Error Handling

- Startup: read Keychain → fail loudly to Telegram if missing
- SIGTERM: kill active Claude subprocess → post shutdown message to Telegram → exit
- Claude crash mid-op: catch exit code, post error to Telegram, ready for next request
- OAuth 401: post auth failure to Telegram with recovery instructions
- Path/command violation: reject immediately, post reason to Telegram
- Long-running commands: stream output every 5 seconds as separate Telegram messages, timeout after 10 minutes

## Installation Steps

```bash
# Store tokens in Keychain
security add-generic-password -s "NanoClaw-coder-credentials" \
  -a bartek -w "<CLAUDE_OAUTH_TOKEN>"
security add-generic-password -s "NanoClaw-coder-telegram-token" \
  -a bartek -w "<TELEGRAM_BOT_TOKEN>"
# To update existing: add -U flag

# Install Node deps
cd ~/nanoclaw/coder-bot && npm install

# Create Claude config dir
mkdir -p ~/.claude-coder

# Install launchd plist
cp launchd/com.nanoclaw.coder.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.coder.plist

# Verify
launchctl list | grep com.nanoclaw.coder
```

## Uninstallation Steps

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.coder.plist
rm ~/Library/LaunchAgents/com.nanoclaw.coder.plist
security delete-generic-password -s "NanoClaw-coder-credentials"
security delete-generic-password -s "NanoClaw-coder-telegram-token"
rm -rf ~/nanoclaw/coder-bot
rm -rf ~/.claude-coder
```

## launchd Plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.coder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/Users/bartek/nanoclaw/coder-bot/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/bartek/nanoclaw</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/bartek</string>
    <key>CLAUDE_CONFIG_DIR</key>
    <string>/Users/bartek/.claude-coder</string>
  </dict>
  <key>StartInterval</key>
  <integer>10</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/bartek/Library/Logs/nanoclaw-coder/coder-bot.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/bartek/Library/Logs/nanoclaw-coder/coder-bot.log</string>
</dict>
</plist>
```

Note: `/usr/bin/env node` resolves Node from PATH — safer than hardcoding a version-specific path.

## Files to Create

1. `coder-bot/src/index.ts` — Telegram listener, message routing
2. `coder-bot/src/keychain.ts` — Keychain token reader
3. `coder-bot/src/validator.ts` — Path and command validation
4. `coder-bot/src/claude-spawn.ts` — Claude Code subprocess management
5. `coder-bot/src/logger.ts` — Structured logging with rotation
6. `coder-bot/launchd/com.nanoclaw.coder.plist` — launchd config
7. `coder-bot/package.json` — Dependencies
8. `coder-bot/tsconfig.json` — TypeScript config
9. `install-coder-bot.sh` — Install script
10. `uninstall-coder-bot.sh` — Uninstall script

## Alternatives Considered

1. **Extend TataNano** — rejected: conflates team and personal workflows
2. **Bash wrapper around Claude CLI** — rejected: no multi-turn sessions, fragile
3. **Containers for CoderBot** — rejected: defeats purpose of native file access
4. **Single bot with role switching** — rejected: no separation of concerns
5. **Tokens in .env** — rejected: Keychain is the macOS standard; .env risks version-control accidents
6. **Hardcoded Node path in plist** — rejected: use `/usr/bin/env node` to survive version upgrades

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Token leaked in logs | Low | High | Never log token values |
| Symlink escape | Low | High | `fs.realpathSync()` before whitelist check |
| CoderBot crash | Low | Medium | launchd auto-restart (StartInterval: 10) |
| TataNano interference | Low | High | Separate Keychain + config dirs |
| Token expires | Low | Medium | Post error to Telegram with recovery steps |
| Unauthorized access | Very low | High | Hardcoded user ID + Telegram API auth |
| git/npm/node abuse | Very low | Medium | Accepted risk — single trusted user by design |

## Scope Estimate

**Medium — 2-3 days**

## What We Are NOT Doing

- No voice support
- No async task scheduling
- No multi-user support
- No web UI
- No dev team integration
- No write access to openclaw (read-only)
- No sudo or global installs

## Open Questions

None. All gaps resolved.
