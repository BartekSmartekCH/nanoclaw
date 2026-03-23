# Telegram Bot Commands — NanoClaw

## Problem

The bot has 6 working commands but zero discoverability:
- No `/help` command
- Telegram's command menu shows 3 stale entries (`/capabilities`, `/status`, `/send_pdf`) that aren't implemented
- Working commands (`/chatid`, `/ping`, `/health`, `/fix_auth`, `/compact`, `/remote-control`) aren't in the menu
- Users have no way to know what the bot can do or why it's ignoring them

## Current State

### Registered in Telegram menu (not implemented):
| Command | Description |
|---------|-------------|
| `/capabilities` | "Show what TataNano can do" |
| `/status` | "Quick health check of the system" |
| `/send_pdf` | "Send a file as PDF to this chat" |

### Implemented in code (not in menu):
| Command | Where | Access | What it does |
|---------|-------|--------|--------------|
| `/chatid` | telegram.ts | Anyone | Show chat registration ID |
| `/ping` | telegram.ts | Anyone | Check bot is alive |
| `/health` | telegram.ts | Main group | Test API auth |
| `/fix_auth` | telegram.ts | Main group | Refresh OAuth token from Keychain |
| `/compact` | session-commands.ts | Main group / trusted sender | Compact agent context |
| `/remote-control` | index.ts | Main group | Start Claude Code bridge |
| `/remote-control-end` | index.ts | Main group | Stop Claude Code bridge |

## Proposed Changes

### 1. Add `/help` command

Lists all available commands with descriptions. Context-aware:
- In main group: show all commands including admin ones
- In other groups: show only user-facing commands
- In unregistered chats: show `/chatid` and setup instructions

### 2. Add `/status` command (replaces stale menu entry)

Quick system overview (main group only):
- Bot uptime
- Number of registered groups
- Queue status (idle / processing group X / N groups queued)
- Auth status (OK / expired)

Lightweight — no container needed, reads from in-memory state.

### 3. Register command menu with Telegram

Call `setMyCommands` on bot startup so the `/` autocomplete works:

**Default menu (all chats):**
| Command | Description |
|---------|-------------|
| `/ping` | Check if bot is online |
| `/chatid` | Show this chat's registration ID |
| `/help` | List available commands |

**Main group menu** (via `scope: { type: 'chat', chat_id }`):
| Command | Description |
|---------|-------------|
| `/ping` | Check if bot is online |
| `/help` | List available commands |
| `/status` | System health and queue status |
| `/health` | Test API authentication |
| `/fix_auth` | Refresh OAuth token from Keychain |
| `/compact` | Compact agent context window |

### 4. Drop stale commands

- `/capabilities` — replaced by `/help`
- `/send_pdf` — not implemented, no current need (agent can generate files via container)
- Old `/status` menu entry — replaced by the real implementation

## Implementation

| File | Action | Purpose |
|------|--------|---------|
| `src/channels/telegram.ts` | MODIFY | Add `/help`, `/status`, `setMyCommands` on startup |
| `src/index.ts` | MODIFY | Export queue/uptime state for `/status` to read |

### `/help` output (main group)

```
TataNano commands:

/ping — Check if bot is online
/status — System health and queue status
/health — Test API authentication
/fix_auth — Refresh OAuth token
/compact — Compact agent context
/remote-control — Start Claude Code bridge
/chatid — Show chat registration ID
/help — This message

Send a message starting with @TataNano to talk to the agent.
```

### `/status` output

```
TataNano status:
Uptime: 3d 14h 22m
Groups: 4 registered
Queue: idle (0 pending)
Auth: OK
```

## What This Doesn't Cover

- `/send_pdf` — not building it (agent handles files natively)
- Per-chat command scoping for non-main groups (grammy supports this but adds complexity — defer)
- `/retry` — useful but needs more design around cursor rollback; separate scope
- `/logs` — useful but needs log buffering; separate scope
