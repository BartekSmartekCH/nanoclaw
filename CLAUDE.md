# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and [docs/SPEC.md](docs/SPEC.md) for architecture decisions.

## Quick Context

Single Node.js process (TypeScript, ESM, Node ≥20) with a skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup via `src/channels/registry.ts`. Incoming messages are stored in SQLite, matched against the `@<ASSISTANT_NAME>` trigger pattern, then routed to the Claude Agent SDK running inside isolated Linux containers (Docker or Apple Container). Each group gets an isolated filesystem and per-group memory under `groups/{name}/`.

Security model: secrets never enter containers. The host runs a local **credential proxy** (`src/credential-proxy.ts`) on `CREDENTIAL_PROXY_PORT` (default `3001`) that vends short-lived tokens to containers; mounts are constrained by a host-side allowlist at `~/.config/nanoclaw/mount-allowlist.json`.

## Key Files — Host Orchestrator (`src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Orchestrator: boot, state, message loop, agent invocation |
| `config.ts` | Env-driven config: trigger pattern, paths, timeouts, bot pool, timezone |
| `env.ts` | `.env` file reader (config values only — never secrets) |
| `db.ts` | SQLite (better-sqlite3): messages, groups, sessions, tasks, router state |
| `channels/registry.ts` | Channel registry with self-registration at import time |
| `channels/index.ts` | Imports side-effects that register built-in channels |
| `channels/telegram.ts` | Telegram channel + bot pool (agent swarm) |
| `router.ts` | Inbound message formatting and outbound delivery routing |
| `ipc.ts` | File-based IPC watcher for container → host messages/tasks |
| `container-runner.ts` | Spawns agent containers, mounts, snapshots groups/tasks |
| `container-runtime.ts` | Runtime abstraction (Docker / Apple Container), orphan cleanup |
| `credential-proxy.ts` | Local HTTP proxy that vends secrets to containers on demand |
| `credential-refresh.ts` | Refreshes OAuth/long-lived tokens before expiry |
| `mount-security.ts` | Validates container mounts against the host allowlist |
| `sender-allowlist.ts` | Per-sender trigger authorization |
| `group-queue.ts` | Per-group FIFO so one group can't block others |
| `group-folder.ts` | Resolves `groups/{name}/` paths safely |
| `task-scheduler.ts` | Cron/interval scheduler for background prompts |
| `remote-control.ts` | Control-channel commands (pause/resume/etc.) |
| `session-commands.ts` | In-chat `/commands` handled by the host (not the agent) |
| `image-processor.ts` | Vision preprocessing (Ollama by default) |
| `voice.ts` | Voice-note transcription hookup |
| `timezone.ts` | Timezone helpers for cron / scheduling |
| `logger.ts` | Pino logger |
| `types.ts` | Shared TypeScript types |

Tests live next to sources as `*.test.ts` and run under Vitest.

## Key Directories

| Path | Purpose |
|------|---------|
| `src/` | Host orchestrator (TypeScript) |
| `src/channels/` | Built-in channel implementations + registry |
| `setup/` | `npm run setup` wizard (platform detection, service install, group register) |
| `container/` | Agent container: `Dockerfile`, `build.sh`, `agent-runner/`, `skills/` |
| `container/skills/` | Runtime skills available to in-container agent (browser, calendar, memory-search, notes, remind, status, letter, pptx, dev, capabilities) |
| `.claude/skills/` | User-invocable Claude Code skills (`/setup`, `/customize`, `/add-*`, etc.) |
| `groups/{name}/` | Per-group isolated workspace + `CLAUDE.md` memory |
| `groups/global/` | Shared memory visible to all groups |
| `store/` | SQLite DB (`messages.db`) and runtime state |
| `docs/` | Architecture, security, requirements, debug checklist |
| `scripts/run-migrations.ts` | DB migrations runner |
| `launchd/` | macOS launchd plist template |
| `config-examples/` | Example env + allowlist configurations |

## User-invocable Skills (Claude Code `/commands`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing router behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/update-skills` | Pull upstream updates into installed skill branches |
| `/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail` | Add channels |
| `/add-telegram-swarm` | Multi-bot agent swarm on Telegram |
| `/add-voice-transcription`, `/use-local-whisper` | Voice message transcription |
| `/add-image-vision`, `/add-pdf-reader`, `/add-reactions`, `/add-compact` | Modality / UX add-ons |
| `/add-ollama-tool`, `/add-parallel`, `/x-integration` | External integrations |
| `/convert-to-apple-container` | Switch from Docker to Apple Container on macOS |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

Always invoke these via the Skill tool — they expand to full prompts.

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev           # Run orchestrator with tsx hot reload
npm run build         # Compile TypeScript to dist/
npm start             # Run compiled dist/index.js
npm run typecheck     # tsc --noEmit
npm run format        # Prettier write on src/**/*.ts
npm run format:check  # Prettier check
npm test              # Vitest (runs once)
npm run test:watch    # Vitest watch mode
npm run setup         # Interactive setup wizard
./container/build.sh  # Rebuild agent container image
```

Husky runs Prettier on pre-commit (`.husky/`).

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

## Conventions

- **ESM only** (`"type": "module"`). Use `.js` suffix on relative imports even in `.ts` source — required by NodeNext resolution.
- **No secrets in `config.ts`.** Only non-sensitive config values. Secrets go through `credential-proxy.ts`.
- **Tests colocated** as `foo.test.ts` next to `foo.ts`. Prefer pure unit tests; mock filesystem/DB via vitest.
- **Channels self-register** on import — new channels should export a side-effect registration call and be imported from `src/channels/index.ts`.
- **Per-group isolation is load-bearing.** Never read/write across `groups/{name}/` boundaries from the host except via `group-folder.ts` helpers.
- **Mount allowlist lives outside the repo** (`~/.config/nanoclaw/`) and must never be mounted into containers.
- **Trigger pattern** is `^@<ASSISTANT_NAME>\b` (case-insensitive), built in `config.ts`.
- **Logging:** use the pino logger from `src/logger.ts`, not `console.log`.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Container build cache staleness:** The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

**Orphaned containers:** `container-runtime.ts` exposes `cleanupOrphans()` which runs at boot. If containers accumulate, check `IDLE_TIMEOUT` and `MAX_CONCURRENT_CONTAINERS` envs.

**Apple Container networking quirks:** See [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md).

## New Group Checklist

After registering any new group, always add a weekly memory reindex scheduler entry to the DB:

```bash
sqlite3 /Users/tataadmin/nanoclaw/store/messages.db "
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
VALUES (
  'memory-reindex-{folder}',
  '{folder}',
  '{jid}',
  'Run the memory indexer to rebuild the conversation archive index. Execute: python3 /home/node/.claude/skills/memory-search/indexer.py --group {folder} --base /workspace/project',
  'cron',
  '0 3 * * 0',
  '{next_sunday_3am}',
  'pending',
  datetime(''now'')
);"
```

Replace `{folder}` with the group folder name (e.g. `telegram_main`) and `{jid}` with the group JID from `registered_groups`. Without this entry, the group's conversations are never indexed and agents cannot do semantic recall over past sessions.
