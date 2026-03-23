---
name: backup
description: Automated backup of TataNano workspace to GitHub. Manual trigger via /backup now, or scheduled daily auto-backup. Commits workspace files and sends confirmation to Telegram.
---

# /backup — Automated Workspace Backup to GitHub

Backup your TataNano workspace to GitHub with a single command or automated daily schedule. Keeps your work safe, version-controlled, and recoverable.

## When to use

- User asks to "backup my work", "save to GitHub", "commit my workspace"
- Scheduled daily task auto-runs (e.g., 2am UTC) — no user action needed
- Recovery: restore `/workspace/group/` from GitHub if container is lost

## How it works

### Prerequisites

Before the `/backup` skill can run, you need:

1. **GitHub repo for workspace backup** (e.g., `nanoclaw-workspace`)
   - Create empty repo on GitHub
   - Clone to local: `git clone https://github.com/BartekSmartekCH/nanoclaw-workspace.git`
   - Add to NanoClaw project at `/backup-repo/` with git credentials stored

2. **GitHub credentials** in `/workspace/project/data/env/env`
   ```
   GITHUB_USERNAME=BartekSmartekCH
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxx
   ```

3. **.gitignore** in the workspace backup repo
   ```
   # Secrets — NEVER backup these
   /workspace/project/data/env/env
   .env
   *.secrets

   # Logs
   *.log

   # OS files
   .DS_Store
   ```

### Manual Backup Trigger

When user runs `@Claude /backup now`:

**Step 1: Prepare the repo**

```bash
cd /workspace/group
git init  # if not already a git repo
git remote add origin https://github.com/BartekSmartekCH/nanoclaw-workspace.git
git fetch origin main 2>/dev/null || echo "First push"
```

**Step 2: Stage and commit**

```bash
git add -A
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S UTC')
git commit -m "Auto-backup: $TIMESTAMP" --allow-empty
```

**Step 3: Get credentials**

```bash
GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' /workspace/project/data/env/env | cut -d= -f2)
GITHUB_USERNAME=$(grep '^GITHUB_USERNAME=' /workspace/project/data/env/env | cut -d= -f2)
```

**Step 4: Push to GitHub**

```bash
git push -u origin main \
  --force \
  -c http.extraheader="Authorization: Bearer $GITHUB_TOKEN"
```

**Step 5: Report to Telegram**

Use the `send-pdf` skill to send a confirmation:

```bash
cat > /tmp/backup_report.txt << EOF
✅ Backup Complete

📦 Backed up: /workspace/group/
📍 Repository: nanoclaw-workspace
⏰ Timestamp: $TIMESTAMP
📊 Files: $(find /workspace/group -type f | wc -l) files

🔐 Secrets: NOT backed up (safe)
🏷️ Branch: main

Recovery procedure:
1. Clone: git clone https://github.com/BartekSmartekCH/nanoclaw-workspace.git
2. Restore: cp -r nanoclaw-workspace/* /workspace/group/
3. Fetch secrets from vault (separate process)
EOF

# Send via send-pdf skill
@Claude /send_pdf /tmp/backup_report.txt "Backup Report"
```

### Scheduled Auto-Backup Task

The `/backup` skill is registered as a scheduled task that runs daily:

**Configuration:**

```javascript
{
  "prompt": "Run the backup skill: commit /workspace/group/ to GitHub and send Telegram confirmation",
  "schedule_type": "cron",
  "schedule_value": "0 2 * * *",  // 2am UTC daily
  "context_mode": "isolated"
}
```

**What it does:**

1. Runs the same backup process as manual trigger (Steps 1-5 above)
2. Sends Telegram notification of success/failure
3. Logs to `/workspace/group/logs/backup.log` for audit trail
4. Re-runs every 24 hours automatically

**Adjusting the schedule:**

To change backup time (e.g., 6am UTC instead of 2am):

```bash
# Update the cron expression in the scheduled task
# Schedule format: minute hour day month weekday
# "0 6 * * *" = 6am UTC daily
# "0 */4 * * *" = every 4 hours
```

## Secrets Handling

**CRITICAL: The backup skill NEVER backs up secrets**

Secrets (API keys, tokens, passwords) are stored in `/workspace/project/data/env/env` and:
- NOT included in GitHub backups
- Must be backed up separately via vault (AWS Secrets Manager, etc.)
- Can be restored via separate `/fetch-secrets` command

The `.gitignore` file in the workspace repo ensures this:

```
/workspace/project/data/env/env
.env
*.secrets
```

## Recovery Procedure

If your TataNano container is lost or corrupted:

### Step 1: Restore workspace from GitHub

```bash
git clone https://github.com/BartekSmartekCH/nanoclaw-workspace.git /workspace/group-restored
cp -r /workspace/group-restored/* /workspace/group/
```

### Step 2: Restore custom skills

```bash
git clone https://github.com/BartekSmartekCH/tatanano-skills.git /home/node/.claude/skills
```

### Step 3: Restore secrets from vault

```bash
# Separate command via Telegram
@Claude /fetch-secrets
```

This restores `/workspace/project/data/env/env` from AWS Secrets Manager (or your vault).

### Step 4: Verify recovery

```bash
@Claude /status
```

Check that workspace, skills, and environment look correct.

## Troubleshooting

### Git push fails with auth error

**Problem:** `fatal: Authentication failed`

**Solution:**
1. Check GITHUB_TOKEN in `/workspace/project/data/env/env` is correct
2. Token must have `repo` scope (full control of private repositories)
3. If token expired, regenerate on GitHub.com and update env file

### Nothing to commit (working tree clean)

**Problem:** "nothing to commit, working tree clean"

**Solution:**
- This is normal if no files changed since last backup
- Skill still succeeds and reports "No changes"
- Commit message has `--allow-empty` flag to handle this

### Backup repo not initialized

**Problem:** `fatal: Not a git repository`

**Solution:**
1. Ensure `nanoclaw-workspace` repo exists on GitHub
2. Clone it once: `git clone https://github.com/BartekSmartekCH/nanoclaw-workspace.git`
3. Manual backup will handle initialization on first run

### File size too large

**Problem:** `error: File X is too large (100MB+)`

**Solution:**
- Git has a 100MB per-file soft limit
- Add large files to `.gitignore`:
  ```
  # Large files
  *.mp4
  *.iso
  node_modules/
  ```
- Clean git history if needed: `git rm --cached <large-file>`

## Architecture Diagram

```
┌─────────────────────┐
│  TataNano Container │
│                     │
│  /workspace/group/  │ ← User's work (scopes, documents, etc.)
│  /home/node/.claude/skills/  ← Custom skills (send-pdf, etc.)
│  /workspace/project/data/env/env  ← SECRETS (never backed up)
└──────────┬──────────┘
           │
           │ /backup skill
           │
    ┌──────▼────────┐
    │  Git Commit   │
    │  + Push       │
    └──────┬────────┘
           │
    ┌──────▼──────────────────────────┐
    │      GitHub                     │
    │                                 │
    │  tatanano-workspace repo        │
    │  ├── scopes/                    │
    │  ├── logs/                      │
    │  ├── .gitignore                 │
    │  └── (NO /workspace/project/)   │
    └─────────────────────────────────┘
           │
           │ Recovery: git clone
           │
    ┌──────▼──────────────────┐
    │ AWS Secrets Manager     │
    │ (separate backup)       │
    │ env file restored here  │
    └─────────────────────────┘
```

## Related Skills

- `/send_pdf` — Send files to Telegram (used for backup reports)
- `/fetch-secrets` — Restore secrets from vault (separate skill)
- `/status` — Quick health check (verify backup completed)

## Complete Example: Manual Backup + Scheduled Task

**Manual backup:**
```
User: @Claude /backup now
Claude: ✅ Backing up your workspace...
[git commit, push, send report]
Claude: ✅ Backup complete! Files: 427, Timestamp: 2026-03-20 14:30 UTC
```

**Scheduled auto-backup at 2am UTC:**
```
[2:00 AM UTC] Backup task runs automatically
[2:05 AM UTC] Telegram notification: ✅ Daily backup complete
[No user action needed]
```

**Recovery scenario:**
```
User: @Claude help, my container crashed
Claude: No problem! Your workspace is safe in GitHub.

1. Restore workspace: git clone nanoclaw-workspace
2. Restore skills: git clone tatanano-skills
3. Restore secrets: /fetch-secrets

Your work is ready to go!
```

## Implementation Notes

- Backup skill uses `git` CLI (installed in container)
- GitHub credentials stored in env file (loaded via source)
- Telegram notifications via existing `send-pdf` skill
- Scheduled task runs via `mcp__nanoclaw__schedule_task` MCP
- All timestamps in UTC for consistency
- Backup log at `/workspace/group/logs/backup.log` for audit trail
