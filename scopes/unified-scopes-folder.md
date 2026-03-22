# RFC: Unified Scopes Folder

**Status:** Proposed
**Date:** 2026-03-22
**Author:** CoderBot (on behalf of Bartek)

---

## 1. Problem

Scopes are scattered across three locations:

| Location | Who writes | Git tracked | Count |
|----------|-----------|-------------|-------|
| `scopes/` (project root) | CoderBot | Yes | 5 files |
| `groups/telegram_main/scopes/` | TataNano (main) | No (`groups/*` gitignored) | 12 files |
| `groups/telegram_dev/scopes/` | TataNano (dev) | No | 7 files |

Problems:
- TataNano's scopes are **not backed up** to GitHub (gitignored under `groups/`)
- No single place to find all scopes
- CoderBot and TataNano can't see each other's scopes easily
- Risk of duplicate or conflicting scopes across locations

## 2. Proposed Solution

**One folder: `scopes/` at project root** (`/Users/tataadmin/nanoclaw/scopes/`)

- Git tracked, backed up to GitHub
- All bots write here — TataNano, CoderBot, dev group agents
- Already partially in use (5 files there today)

## 3. Changes Required

### Change 1 — Writable mount for containers

**File:** `src/container-runner.ts` (~5 lines)

Add a writable mount for `scopes/` after the read-only project root mount (line 89). This overrides the read-only project mount for just the `scopes/` subdirectory:

```typescript
// Scopes directory — writable so agents can create/update scopes
const scopesDir = path.join(projectRoot, 'scopes');
fs.mkdirSync(scopesDir, { recursive: true });
mounts.push({
  hostPath: scopesDir,
  containerPath: '/workspace/project/scopes',
  readonly: false,
});
```

**Who gets it:** All containers that have `getsProjectMount` (main + devAccess groups). Non-project groups don't need scopes access.

**Container path:** `/workspace/project/scopes/` — already visible as read-only, this just makes it writable.

### Change 2 — Migrate existing group scopes

One-time move of files from group folders to project root:

```
groups/telegram_main/scopes/ → scopes/
groups/telegram_dev/scopes/  → scopes/
```

Delete the source directories after migration so they can't be accidentally written to later:

```bash
rm -rf groups/telegram_dev/scopes && rm -rf groups/telegram_main/scopes
```

Proposed directory structure after migration:

```
scopes/
├── auth-recovery.md              (existing)
├── auth-recovery/                (from telegram_main)
│   └── SCOPE.md
├── lead-scraper.md               (existing, untracked)
├── lead-scraper.pdf              (existing, untracked)
├── telegram-commands.md          (existing)
├── unified-scopes-folder.md      (this RFC)
├── voice-pipeline.md             (existing)
├── linguaflow/                   (from telegram_main)
│   ├── SCOPE.md
│   └── SCOPE.html
├── tatanano-guide/               (from telegram_main)
│   └── GUIDE.html
├── tatanano-improvements/        (from telegram_main)
│   ├── IMPROVEMENTS.md
│   ├── BACKUP-SCOPE.html
│   ├── KEYCHAIN-CONVENTION.html
│   ├── LETTER-VISION-SCOPE-FINAL.html
│   ├── LETTER-VISION-SCOPE.html
│   ├── SECRETS-FLOW-SCOPE.html
│   ├── backup-SKILL.md
│   ├── check-secrets-SKILL.md
│   ├── send-pdf-SKILL.md
│   └── validate-keychain.sh
├── scrapenano-rfc.md             (from telegram_dev)
├── spike-auth-recovery.md        (from telegram_dev)
├── tts-text-cleaning.md          (from telegram_dev)
├── txt-file-support.md           (from telegram_dev)
└── archive/                      (from telegram_dev)
    ├── coder-bot-implementation.md
    ├── coder-bot-rfc.md
    └── option-b-coder-bot.md
```

### Change 3 — Commit to git

Stage and commit all migrated scopes + lead-scraper files so everything is tracked and backed up on GitHub.

## 4. What Does NOT Change

- **Non-container bots** (CoderBot) — already write to `scopes/` directly, no change needed
- **`.gitignore`** — `scopes/` is already tracked; add `scopes/**/*.pdf` to keep PDFs out of the repo (binary bloat)
- **Group folders** — still exist for conversations, memory, and runtime data
- **Container security** — `.env` shadow mount unchanged, only `scopes/` gets write access

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent writes junk to scopes/ | Low — scopes are reviewed by Bartek | Git tracks all changes, easy to revert |
| Mount order conflict with project root | None — Docker uses most-specific mount | Scopes mount is more specific than project root |
| Large files bloating repo | Low | `scopes/**/*.pdf` added to `.gitignore` to keep binaries out of the repo |

### Change 4 — `.gitignore`

Add to `.gitignore`:

```
scopes/**/*.pdf
```

This keeps PDF binaries (generated scope documents) out of the git repo while tracking all `.md` and `.html` scope files.

## 6. Smoke Test

1. TataNano creates a scope via Telegram → file appears in `scopes/` on host
2. `git status` shows the new file as untracked (not hidden by gitignore)
3. CoderBot reads the same file directly
4. Existing scopes still readable at `/workspace/project/scopes/` in container
5. Inside the dev container, create a file at `/workspace/project/scopes/test.md` — verify it appears on the host at `~/nanoclaw/scopes/test.md`
