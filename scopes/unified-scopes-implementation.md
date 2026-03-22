# Unified Scopes Folder — Implementation Instructions

**For:** CoderBot on Mac mini
**Repo:** ~/nanoclaw
**RFC:** scopes/unified-scopes-folder.md (update first per step 0)

---

## Step 0 — Update the RFC

Edit `scopes/unified-scopes-folder.md` on the Mac mini. Apply these fixes from the review:

1. In Change 2, add after the migration bullet points:
   > **After migration: delete the source directories** (`groups/telegram_main/scopes/` and `groups/telegram_dev/scopes/`) so they cannot become stale write targets.

2. Add `auth-recovery/SCOPE.md` to the migration tree (it exists at `groups/telegram_main/scopes/auth-recovery/SCOPE.md` but was missing from the RFC).

3. In Change 3, add Step A — `.gitignore` rule before the commit step:
   ```
   # Scopes: binary files not suitable for git
   scopes/**/*.pdf
   ```

4. Expand the smoke test to include:
   - Dev container write test (agent writes inside container → file appears on host)

5. Note that `lead-scraper.pdf` is NOT committed (excluded by .gitignore).

---

## Step 1 — Code change: `src/container-runner.ts`

Find the `if (getsProjectMount)` block. It currently ends with the `.env` shadow mount and a closing `}` around line 88-89.

Add the scopes mount **inside** that block, just before the closing `}`:

```typescript
    // Scopes directory — writable so agents can create/update scopes
    const scopesDir = path.join(projectRoot, 'scopes');
    fs.mkdirSync(scopesDir, { recursive: true });
    mounts.push({
      hostPath: scopesDir,
      containerPath: '/workspace/project/scopes',
      readonly: false,
    });
  }  // end of getsProjectMount block
```

No new imports needed — `path` and `fs` are already imported.

---

## Step 2 — .gitignore

Add to `.gitignore` (anywhere in the scopes section, or at the end):

```
# Scopes: binary files not suitable for git
scopes/**/*.pdf
```

---

## Step 3 — Migrate files

Run these commands from `~/nanoclaw`:

```bash
# Migrate telegram_dev scopes
cp -r groups/telegram_dev/scopes/* scopes/

# Migrate telegram_main scopes (subdirectory structure)
cp -r groups/telegram_main/scopes/linguaflow scopes/
cp -r groups/telegram_main/scopes/tatanano-guide scopes/
cp -r groups/telegram_main/scopes/tatanano-improvements scopes/
cp -r groups/telegram_main/scopes/auth-recovery scopes/

# Delete source dirs (prevent stale write targets)
rm -rf groups/telegram_dev/scopes
rm -rf groups/telegram_main/scopes
```

Verify no files were missed:
```bash
ls scopes/
```

Expected top-level contents (see RFC for full tree).

---

## Step 4 — Build and test

```bash
npm run build
```

Must compile with no errors.

---

## Step 5 — Smoke test (before commit)

Restart NanoClaw:
```bash
launchctl stop com.nanoclaw && sleep 2 && launchctl start com.nanoclaw
```

Then in Telegram (dev group), ask TataNano to create a test scope file. Verify:
1. File appears in `~/nanoclaw/scopes/` on Mac mini
2. `git status` shows it as untracked (not gitignored)
3. CoderBot can read it from `~/nanoclaw/scopes/`
4. `git status` does NOT show `lead-scraper.pdf` (gitignore working)

---

## Step 6 — Commit

```bash
cd ~/nanoclaw
git add scopes/ .gitignore src/container-runner.ts
git status  # review before committing
git commit -m "feat: unify all scopes into tracked scopes/ folder

Migrates scopes from groups/telegram_main/scopes/ and
groups/telegram_dev/scopes/ into the git-tracked scopes/ directory.
Adds writable container mount so TataNano can write scopes directly.
Adds .gitignore rule to exclude PDFs from git."
```

---

## Checklist

- [ ] RFC updated (step 0)
- [ ] `src/container-runner.ts` — scopes mount added
- [ ] `.gitignore` — PDF rule added
- [ ] Files migrated from both group scopes folders
- [ ] Source dirs deleted
- [ ] `npm run build` passes
- [ ] NanoClaw restarted
- [ ] Smoke test passed (container write + git visibility)
- [ ] Committed
