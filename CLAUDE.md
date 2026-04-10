# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Session Startup

On first interaction of a new session, read the last 3 entries from `groups/global/knowledge.md` to catch up on recent decisions, builds, fixes, and open items across all groups. This is the same shared knowledge baseline that CoderBot and container agents read — keeps all agents aligned.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

**Gmail tool availability (as of 2026-04-10):** Gmail is available as an MCP **tool** to Claude Code on host and to CoderBot via local MCP `@gongrzhe/server-gmail-autoauth-mcp` (account `bart70895@gmail.com`, OAuth at `~/.gmail-mcp/`). It is **not** available to container agents in `telegram_main`/`telegram_dev`/language groups — that's deferred Phase 2. To use Gmail from Telegram, use the dedicated CoderBot chat. The hosted `claude.ai Gmail` MCP cannot download attachments; the local one can. 7-day token expiry caveat — re-auth weekly with `npx @gongrzhe/server-gmail-autoauth-mcp auth`. See `system-manifest.md` Capabilities & Roadmap for full details.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop (2s poll), trigger matching, container invocation, idle timeout |
| `src/group-queue.ts` | Concurrency control: max 5 containers, task priority over messages, exponential backoff |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/telegram.ts` | Telegram channel: bot pool, voice handling, image forwarding |
| `src/ipc.ts` | IPC watcher: file-based input/output between host and containers |
| `src/router.ts` | Message formatting and outbound routing |
| `src/voice.ts` | Voice pipeline: Whisper STT + edge-tts TTS + ffmpeg conversion |
| `src/config.ts` | All paths, intervals, container limits, assistant name |
| `src/container-runner.ts` | Spawns agent containers with 10+ volume mounts, credential proxy |
| `src/task-scheduler.ts` | Runs scheduled tasks (cron-based) |
| `src/db.ts` | SQLite: 7 tables (messages, chats, sessions, registered_groups, scheduled_tasks, task_run_logs, router_state) |
| `groups/{name}/CLAUDE.md` | Per-group personality and instructions (isolated) |
| `groups/{name}/voice.json` | Per-group TTS voice config |
| `groups/{name}/conversations/` | Conversation archives (markdown) |
| `groups/{name}/memory-index/` | Vector index + knowledge.md for semantic search |
| `groups/global/CLAUDE.md` | Shared instructions for all non-main groups |
| `container/skills/` | Skills loaded inside agent containers at runtime |

## Active Groups

| Group Folder | Channel | Purpose |
|-------------|---------|---------|
| `telegram_main` | Telegram | Primary chat group |
| `telegram_dev` | Telegram | Development/testing |
| `telegram_deutschflow` | Telegram | German language practice |
| `telegram_linguaflow` | Telegram | Spanish language practice |
| `coder` | Internal | CoderBot sessions |
| `global` | Shared | Global instructions for non-main groups |
| `main` | WhatsApp | Original channel (legacy) |

## Standalone Bots

Separate Node.js processes outside the main NanoClaw router. Each has its own launchd service.

| Bot | Path | Purpose |
|-----|------|---------|
| `bart-bot/` | Telegram bot | Bart Simpson persona with Fish Audio TTS |
| `mama-bot/` | Telegram bot | MamaZdrowie health assistant (Polish, CGM educator) |
| `coder-bot/` | Internal | CoderBot coding assistant |
| `crawler-bot/` | Telegram bot | Web crawling agent |

## Memory System

Three-phase memory pipeline runs per group (weekly cron + on container idle):

1. **Vector indexing** — chunks conversation archives, embeds via Ollama (`nomic-embed-text`), stores in `memory-index/index.json`
2. **Synthesis** — Ollama (`gemma4:e2b`) extracts structured facts (decisions, built, fixed, discussed, open, preferences) into `knowledge.md`
3. **Knowledge indexing** — re-embeds `knowledge.md` with `source: "knowledge"` for higher-rank search results

Files: `container/skills/memory-search/indexer.py` (build), `container/skills/memory-search/search.py` (query)

## Container Architecture

Containers get these volume mounts:
- **Project root** (read-only) at `/workspace/project` (`.env` shadowed with `/dev/null`)
- **Group folder** (writable) at `/workspace/group`
- **Global memory** (read-only, non-main only) at `/workspace/global`
- **IPC directory** (writable) at `/workspace/ipc`
- **Container skills** synced to `/home/node/.claude/`

Credentials injected via credential proxy on `localhost:3001` — no API keys in containers.

## Voice / TTS Pipeline

| Stage | Tool | Details |
|-------|------|---------|
| STT | Whisper (`/opt/homebrew/bin/whisper`) | OGG → WAV (16kHz mono) → transcription with language hint |
| TTS | edge-tts (`/opt/homebrew/bin/edge-tts`) | Text → MP3 → OGG/opus @ 64k (Telegram-compatible) |
| Convert | ffmpeg (`/opt/homebrew/bin/ffmpeg`) | Format conversion for both pipelines |

Mirror mode: if user sends voice, reply is also voice (when TTS enabled and text < `max_tts_chars`).

## Secrets / Credentials

Credentials are managed via macOS Keychain + a native credential proxy (`src/credential-proxy.ts` on port 3001).

| Component | Source |
|-----------|--------|
| Container agents | `.env` → credential proxy injects headers per-request; `.env` shadowed with `/dev/null` inside containers |
| Standalone bots (mama-bot, bart-bot) | macOS Keychain (`security find-generic-password`) |
| Coder-bot | Claude CLI's own auth (Keychain/OAuth) |
| VirusTotal | Keychain → mounted as secret file in IPC dir |

OAuth token refresh: `src/credential-refresh.ts` reads fresh token from Keychain, updates `.env` if changed. Containers never see raw credentials.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run test         # Run vitest
npm run lint         # ESLint
npm run format       # Prettier
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Key Config Values

| Config | Default | Source |
|--------|---------|--------|
| `POLL_INTERVAL` | 2000ms | `src/config.ts` |
| `IDLE_TIMEOUT` | 30 min | `src/config.ts` |
| `CONTAINER_TIMEOUT` | 30 min | `src/config.ts` |
| `MAX_CONCURRENT_CONTAINERS` | 5 | `src/config.ts` |
| `CREDENTIAL_PROXY_PORT` | 3001 | `src/config.ts` |
| `MAX_MESSAGES_PER_PROMPT` | 10 | `src/config.ts` |
| `ASSISTANT_NAME` | "TataNano" | `src/config.ts` |
| `CONTAINER_IMAGE` | "nanoclaw-agent:latest" | `src/config.ts` |

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## New Group Checklist

After registering any new container group, decide whether it needs memory indexing:

- **Language-practice / ephemeral groups** (e.g. `telegram_linguaflow`, `telegram_deutschflow`): skip indexing entirely. They don't benefit from semantic recall.
- **Real assistant groups** (e.g. `telegram_main`, `telegram_dev`): add a **host-side launchd reindex job**, never a DB-scheduled in-container task.

### Why host-side, not in-container

`container/skills/memory-search/indexer.py` only talks to **Ollama** — it never calls the Claude API. Wrapping it in a Claude agent container (via `scheduled_tasks`) burns Claude tokens for nothing and trips OAuth rate limits when multiple groups fire on the same minute. The host script `scripts/memory-reindex.sh` runs the same indexer directly with zero Claude involvement.

### How to add a host reindex job

1. Copy an existing plist as a template:
   ```bash
   cp ~/Library/LaunchAgents/com.nanoclaw.reindex-main.plist \
      ~/Library/LaunchAgents/com.nanoclaw.reindex-{folder}.plist
   ```
2. Edit the new plist: change the `Label`, the second `ProgramArguments` string to `{folder}`, and the `StartCalendarInterval` hours so they **don't collide** with existing reindex jobs (`reindex-main` runs at 03/09/15/21, `reindex-dev` at 00:30/06:30/12:30/18:30). Pick a different hour offset for each new group.
3. Load it:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.reindex-{folder}.plist
   ```
4. Verify the next run writes to `~/Library/Logs/nanoclaw-reindex/reindex.log` with `Done. Errors: 0`.

Without a reindex job the group's conversations are never indexed and agents cannot do semantic recall over past sessions.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
