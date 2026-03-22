# Auth Recovery — NanoClaw

> Updated after team review (Architect + Security + QA), 2026-03-20

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
- In OAuth mode the container exchanges the placeholder token for a **temp API key** at startup; subsequent requests use that temp key, not the OAuth token directly

> ⚠️ A mid-run 401 may be **temp-key expiry**, not OAuth token expiry. The refresh flow must distinguish these before retrying.

---

## Proposed Solution

### Architecture Overview

All four features share a common foundation: a new `credential-manager.ts` module.

```
credential-manager.ts
├── readKeychainToken()     — execFile('security', [...args]) — never shell string interpolation
├── refreshCredentials()    — keychain read → .env atomic write → proxy hot-swap
├── validateToken()         — lightweight API probe before retrying containers
├── getTokenStatus()        — age, source, validity (for /health)
└── state: lastRefreshTime, refreshMutex  (prevents concurrent refresh stampede)
```

**Key design decisions vs original scope:**

| Original | Revised |
|---|---|
| Detect 401 in `index.ts` from container output | Detect 401 in credential proxy (it sees HTTP status directly) |
| Update `.env` then restart proxy | Update `.env` + hot-swap via `setToken()` — no restart, no dropped connections |
| `credential-refresh.ts` | `credential-manager.ts` — broader scope, owns all token logic |
| Each feature does its own refresh | Single `refreshCredentials()` with mutex — concurrent 401s collapse to one refresh |

---

### Feature 1 — Auto-refresh on 401

**Flow:**
1. Credential proxy detects upstream 401 → emits `auth-failure` event
2. `credential-manager` acquires mutex (drops duplicate concurrent triggers)
3. Reads fresh token from macOS Keychain:
   `execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])`
4. If keychain token == current `.env` token → token is truly expired; skip refresh, notify user immediately
5. Writes fresh token to `.env` atomically (write to temp file → rename; `chmod 0600`)
6. Hot-swaps token in proxy via `setToken(newToken)` — no restart
7. Validates token with lightweight API probe (not a model invocation)
8. If valid → retry agent invocation (max 1 retry)
9. If retry also fails → Telegram: *"Auth failed. Token may be fully expired. Re-run `claude` on the Mac mini."*
10. Enter cooldown — no further auto-refresh for N minutes

**Rate limits:** Max 1 refresh per N min. After M consecutive failures → degraded state, stop auto-retry, periodic reminders only.

---

### Feature 2 — `/health` command

Read-only, available to all registered groups:
- Checks credential proxy is running and reachable
- Tests API auth via lightweight probe (not a model invocation)
- Reports: auth mode, proxy status, token age / last-refresh time, probe result
- Does **NOT** expose token value or any prefix
- Rate-limited: max 1 call / 30 sec / group
- No agent container needed — runs in NanoClaw core

---

### Feature 3 — `/fix-auth` command (main group only)

Manual override with elevated privilege:
- **Authorization:** `isMain` group check **AND** sender must be in admin allowlist (not just group membership)
- Calls `refreshCredentials()` — same path as auto-refresh
- Logs every invocation: sender ID, timestamp, result
- Returns success/failure only — never the token value
- Rate-limited: cooldown between invocations to prevent proxy churn

---

### Feature 4 — Proactive monitoring

Notification wrapper around the auto-refresh flow:
- On 401 detection: *"⚠️ API auth failed. Attempting auto-fix..."*
- On successful refresh: *"✅ Auth refreshed automatically."*
- On failed refresh: *"❌ Auth refresh failed. Run `/fix-auth` or re-authenticate on Mac mini."*
- Rate-limited: max 1 alert / hour per failure type
- After N consecutive failures → periodic reminder mode (not per-failure spam)

---

## Implementation Plan

### File Changes

| File | Change |
|---|---|
| `src/credential-manager.ts` | **NEW** — keychain read, atomic `.env` write, refresh mutex, token status, validation probe |
| `src/credential-proxy.ts` | Add `setToken()` hot-swap + `auth-failure` event emitter |
| `src/channels/telegram.ts` | Add `/health` and `/fix-auth` commands |
| `src/index.ts` | Subscribe to proxy `auth-failure` events; wire refresh + Telegram notifications |

### Build Order

```
① credential-manager.ts + proxy hot-swap   — foundation, nothing else works without this
② /health command                           — independent; useful for debugging during dev
③ Auto-refresh + proactive monitoring       — depends on ①; monitoring = notification wrapper
④ /fix-auth command                         — depends on ①; trivial once manager exists
```

---

## Security Requirements

- Keychain access: `execFile` with args as array — never string interpolation into shell
- `.env` writes: atomic (temp file → rename), enforce `0600` after every write
- Token logging: **NEVER** log token values; mask to last 4 chars in error context only
- `/fix-auth`: sender auth required beyond `isMain` group check
- Refresh mutex: prevent thundering herd from concurrent 401s
- Rate-limits on all user-facing commands and auto-refresh
- No token in CLI arguments (visible in `ps`), no temp files, no log buffers

---

## Testing Requirements

### New test infrastructure

| Mock/Fixture | Purpose |
|---|---|
| Keychain mock | `execFile` for `security` cmd: success / not-found / locked / malformed |
| Upstream 401 mock server | Extend `upstreamServer` in `credential-proxy.test.ts` to return 401 on demand |
| Container 401 fixture | Extend `createFakeProcess()` in `container-runner.test.ts` to emit 401 output |
| Proxy hot-reload harness | Verify `setToken()` takes effect on next request without restart |
| Telegram bot mock | Simulate incoming commands, capture responses |

### Unit tests

- 401 event emission from proxy on upstream 401
- `readKeychainToken()`: success, not-found, locked, malformed
- `refreshCredentials()`: happy path; no-op when tokens match; mutex serialises concurrent calls
- `validateToken()`: 200 → pass, 401 → fail
- `.env` atomic write: correct quoting for tokens with `=`/`+`/`/`, permissions `0600`
- `/health`: proxy up/down, API probe pass/fail, rate-limit gate
- `/fix-auth`: `isMain` gate, sender auth gate, keychain failure, `.env` write failure

### Integration / E2E scenarios

1. Proxy detects 401 → refresh → hot-swap → retry → success
2. Retry also 401s → user notified to re-authenticate
3. `/fix-auth` from Telegram → refresh → hot-swap → confirmation message
4. Hot-reload: after `setToken()`, new requests use fresh token (not startup token)

### Edge cases

- Keychain unavailable (not macOS / locked / item missing) → graceful error + notification
- `.env` write fails (permissions / disk full) → no partial write, graceful error
- Stale keychain token (same as `.env`) → skip retry, notify immediately
- Two concurrent 401s → only one refresh runs, second waits on mutex
- Proxy mid-restart while agent in-flight → document / test behaviour
- OAuth tokens with special chars (`=`, `+`, `/`) → correct `.env` quoting
- N consecutive failures → degraded state, no further auto-retry

---

## What This Doesn't Solve

- Fully expired keychain token (user hasn't run Claude Code in weeks) → SSH/physical access required
- Could add last-resort push notification (email) if Telegram itself is also broken

---

## Open Questions

1. **Long-lived API key vs OAuth?** If `ANTHROPIC_API_KEY` (non-expiring) is viable, the entire keychain/token-drift problem disappears. Investigation needed — see below.
2. **Temp key vs OAuth 401 distinction:** What does the 401 response body contain in each case? Must test against real Anthropic API before finalising Feature 1 detection logic.
