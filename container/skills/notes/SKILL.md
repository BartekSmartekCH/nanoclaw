---
name: notes
description: Create and append to notes in macOS Notes app. Syncs via iCloud. Use /note, "note this", "save this", "remember this" or "add to notes".
triggers:
  - /note
  - /notes
  - note this
  - save this to notes
  - add to notes
  - jot this down
  - write this down
  - remember this
  - make a note
---

# /note — Notes

Creates or appends to notes in macOS Notes app (syncs via iCloud).

## Commands

| Command | What it does |
|---------|-------------|
| `/note [title]: [content]` | Create new note with title and content |
| `/note [content]` | Create quick note with auto-title (date + first few words) |
| `/note append [title]: [content]` | Append to existing note (creates if not found) |

## Creating a Note

### Step 1 — Parse the request

Extract:
- **Title** — explicit if user provided `title: content` format; otherwise auto-generate from first 5 words + date
- **Content** — the note body
- **Mode** — `create` (new note) or `append` (add to existing)
- **Folder** — default: "Notes"; ask if user specifies a different folder

### Step 2 — Create or append via AppleScript IPC

**Create new note:**
```bash
cat > /workspace/ipc/tasks/notes-mac-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"do shell script \"open -a Notes\"\ndelay 3\ntell application \"Notes\"\ntell account \"iCloud\"\nmake new note at folder \"Notes\" with properties {name:\"NOTE_TITLE\", body:\"NOTE_BODY\"}\nend tell\nend tell"}
EOF
```

**Append to existing note (creates if not found):**
```bash
cat > /workspace/ipc/tasks/notes-mac-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"do shell script \"open -a Notes\"\ndelay 3\ntell application \"Notes\"\ntell account \"iCloud\"\nset matchedNote to missing value\nrepeat with n in notes of folder \"Notes\"\nif name of n is \"NOTE_TITLE\" then\nset matchedNote to n\nexit repeat\nend if\nend repeat\nif matchedNote is missing value then\nmake new note at folder \"Notes\" with properties {name:\"NOTE_TITLE\", body:\"NOTE_BODY\"}\nelse\nset body of matchedNote to (body of matchedNote) & \"\n\" & \"NOTE_BODY\"\nend if\nend tell\nend tell"}
EOF
```

Replace:
- `NOTE_TITLE` — note title (escape any double quotes as `\\"`)
- `NOTE_BODY` — note content (escape any double quotes as `\\"`, newlines as `\\n`)

### Step 3 — Confirm to user

```
📝 Note saved: "[title]"
   [first 60 chars of content]...
   (syncs to iCloud)
```

## Edge Cases

- **Long content** — no length limit, AppleScript handles it
- **Special characters** — escape `"` as `\\"` and newlines as `\n` in the JSON script string
- **iCloud not configured** — fall back to `account "On My Mac"` folder `"Notes"`
- **Same permission as Reminders** — if it fails, user needs to grant node Automation access to Notes in System Settings → Privacy & Security → Automation
