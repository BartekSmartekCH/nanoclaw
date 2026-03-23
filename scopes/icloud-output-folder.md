# RFC: iCloud-Backed Output Folder for NanoClaw

**Status:** Proposed
**Date:** 2026-03-22
**Author:** CoderBot (on behalf of Bartek)

---

## 1. Problem

Bot-produced files (PDFs, Excel exports, scripts, scope documents) live in `groups/{name}/` — gitignored, local only, no cloud backup. If the Mac mini disk fails, all generated content is lost.

Scopes are now git-tracked, but other output types (PDFs, exports, generated scripts) don't belong in a git repo.

## 2. Proposed Solution

A shared `NanoClaw/` folder in iCloud Drive, mounted into containers as writable. Auto-syncs to iCloud, accessible from iPhone/iPad/Mac.

**Host path:** `~/Library/Mobile Documents/com~apple~CloudDocs/NanoClaw/`

**Container path:** `/workspace/cloud/`

### Folder structure

```
~/Library/Mobile Documents/com~apple~CloudDocs/NanoClaw/
├── scopes/              # Scope documents, RFCs (symlinked from project root)
├── exports/             # Excel, CSV, data exports
├── documents/           # PDFs, generated letters, reports
├── scripts/             # Shell scripts, utilities
├── ideas/               # Brainstorming, rough notes, concepts
└── archive/             # Completed or shelved items
```

Each subfolder can optionally have per-group subdirectories if isolation is needed:

```
exports/
├── lead-scraper/        # Lead scraper Excel exports
├── tutors/              # Tutor progress reports
└── ...
```

## 3. Prerequisites

**Enable iCloud Drive on Mac mini:**
1. System Settings > Apple ID > iCloud > iCloud Drive → ON
2. Wait for initial sync to complete
3. Verify: `ls ~/Library/Mobile\ Documents/com~apple~CloudDocs/`

## 4. Changes Required

### Change 1 — Create iCloud folder structure

One-time setup:

```bash
ICLOUD=~/Library/Mobile\ Documents/com~apple~CloudDocs/NanoClaw
mkdir -p "$ICLOUD"/{scopes,exports,documents,scripts,ideas,archive}
```

### Change 2 — Writable container mount

**File:** `src/container-runner.ts` (~8 lines)

Inside the `if (getsProjectMount)` block, after the scopes mount:

```typescript
// iCloud output — writable so agents can save exports, PDFs, scripts
const icloudDir = path.join(
  os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs/NanoClaw',
);
if (fs.existsSync(icloudDir)) {
  mounts.push({
    hostPath: icloudDir,
    containerPath: '/workspace/cloud',
    readonly: false,
  });
}
```

**Graceful:** If iCloud Drive isn't enabled or the folder doesn't exist, the mount is silently skipped. No crash.

### Change 3 — CLAUDE.md instruction

Add to `groups/global/CLAUDE.md`:

```markdown
## Cloud Storage

If `/workspace/cloud/` is available, save generated files there for iCloud backup:
- PDFs and documents → `/workspace/cloud/documents/`
- Excel/CSV exports → `/workspace/cloud/exports/`
- Scripts and utilities → `/workspace/cloud/scripts/`
- Ideas and brainstorming → `/workspace/cloud/ideas/`

If `/workspace/cloud/` is not mounted, fall back to `/workspace/group/`.
```

### Change 4 — Symlink scopes (optional)

Symlink the git-tracked scopes into iCloud so they're also browsable from iPhone:

```bash
ln -s ~/nanoclaw/scopes ~/Library/Mobile\ Documents/com~apple~CloudDocs/NanoClaw/scopes
```

Note: Symlinked content syncs to iCloud as real files. Changes on iPhone would NOT sync back to git — the symlink is one-way for convenience viewing only.

## 5. What Does NOT Change

- **Git repo** — no new tracked files, no binaries in the repo
- **Group folders** — still used for conversations, memory, sessions
- **Scopes workflow** — still written to `/workspace/project/scopes/`, just also visible in iCloud via symlink
- **Container security** — `.env` still shadowed, no credential exposure

## 6. Access Matrix

| Who | Path | Access |
|-----|------|--------|
| TataNano (main) | `/workspace/cloud/` | Read-write |
| Dev group agents | `/workspace/cloud/` | Read-write |
| Non-project groups | Not mounted | No access |
| CoderBot | Direct filesystem | Read-write |
| Bartek (iPhone) | iCloud Drive app > NanoClaw/ | Read (+ edit if needed) |

## 7. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| iCloud sync delay | Low — files appear within seconds-minutes | Not time-critical; exports aren't needed instantly on other devices |
| iCloud storage cost | Low — 50GB free, 200GB is $2.99/mo | Scope docs and exports are tiny |
| Bot writes large files | Medium — could fill iCloud | Add size check or quota warning in CLAUDE.md |
| iCloud Drive disabled | None — mount silently skips | Graceful degradation built in |
| Sync conflicts | Low — bots don't edit each other's files | Per-group subdirectories if needed |

## 8. Smoke Test

1. Enable iCloud Drive on Mac mini
2. Create the folder structure
3. Restart NanoClaw
4. Ask TataNano to save a test PDF to `/workspace/cloud/documents/test.pdf`
5. Check it appears on iPhone in Files app > iCloud Drive > NanoClaw > documents

## 9. Future

- **Backblaze B2** as a secondary backup (CLI-friendly, $5/TB/month) for cold storage
- **Scheduled archive** — move files older than 30 days to `archive/` automatically
- **Size monitoring** — alert via Telegram if iCloud NanoClaw folder exceeds threshold
