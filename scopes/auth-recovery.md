# Auth Recovery — NanoClaw

## Problem

When the OAuth token expires or gets corrupted:
1. Telegram connection stays alive (bot receives messages)
2. Agent containers fail with 401 (can't call Claude API)
3. User sees "401 authentication error" from the bot
4. User has NO way to fix it from Telegram — stuck until someone SSHs into the Mac mini

## Current Token Flow

- `.env` has `CLAUDE_CODE_OAUTH_TOKEN`
- Claude Code stores the live (auto-refreshed) token in macOS Keychain under `Claude Code-credentials`
- These can drift apart — `.env` becomes stale while keychain has a fresh one
- Container reads token from `.env` via credential proxy on port 3001

## Proposed Solution

### 1. Auto-refresh on 401

When agent container returns a 401 error:
1. NanoClaw detects the 401 in agent output
2. Reads fresh token from macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`)
3. Updates `.env` with the fresh token
4. Retries the agent invocation
5. If retry also fails → notify user in Telegram: "Auth failed. Token may be fully expired. Re-run `claude` on the Mac mini to re-authenticate."

### 2. Telegram `/health` command

Add a `/health` bot command that:
- Checks credential proxy status
- Tests API auth (lightweight call)
- Reports token age/status
- No agent container needed — runs in NanoClaw core

### 3. Telegram `/fix-auth` command (main group only)

Add a `/fix-auth` command that:
- Reads fresh token from keychain
- Updates `.env`
- Restarts credential proxy
- Reports success/failure
- Only works from main (admin) group

### 4. Proactive monitoring

On every agent 401 failure:
- Send a warning to the main Telegram chat: "⚠️ API auth failed. Attempting auto-fix..."
- Attempt keychain refresh
- Report result

## Implementation

| File | Change |
|------|--------|
| `src/index.ts` | Detect 401 in agent output, trigger auto-refresh |
| `src/channels/telegram.ts` | Add `/health` and `/fix-auth` commands |
| `src/credential-refresh.ts` | NEW: keychain reader + .env updater |

## What This Doesn't Solve

- If the keychain token is also expired (user hasn't run Claude Code in weeks) → need SSH access or physical access to re-authenticate
- Could add a push notification (email/Telegram) as last resort alert
