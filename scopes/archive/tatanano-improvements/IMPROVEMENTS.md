# TataNano — Future Improvements Scope

_Created: March 20, 2026_

---

## 1. Bake `send-pdf` Skill into Docker Image ⭐ PRIORITY

**Status:** Skill is working and live. Needs to be made permanent.

**What to do:**
Copy `send-pdf-SKILL.md` (in this folder) to your NanoClaw project:

```
[nanoclaw folder]/container/skills/send-pdf/SKILL.md
```

Then rebuild the Docker image:
```bash
cd [nanoclaw folder]
docker build -f container/Dockerfile -t nanoclaw-agent .
docker restart <container_name>
```

**Why:** Currently the skill lives only in the container's writable layer. If the container is recreated it will be lost. Baking it into the image makes it permanent.

---

## 2. Fix `global/` Folder Write Permissions

**Status:** Currently read-only from inside the container.

**What to do:**
Run once on Mac Mini terminal:
```bash
chmod 777 [nanoclaw folder]/groups/global
```

**Why:** Enables TataNano to save files to `/workspace/global/` — accessible from ALL chats and bots, not just the main chat.

---

## 3. LinguaFlow Tutoring Bot — Separate Telegram Bot

**Status:** Scoped. Not yet implemented.

**What it is:** A dedicated Telegram bot with a language teacher persona, powered by TataNano/NanoClaw, using the LinguaFlow scope as its knowledge base.

**Steps:**
1. Create new bot via [@BotFather](https://t.me/botfather) → get token
2. Add to NanoClaw config as a new group
3. Create custom CLAUDE.md with language tutor persona
4. Wire up LinguaFlow scope as context

**Reference:** `/workspace/group/scopes/linguaflow/SCOPE.md`

---

## 4. Telegram Command Menu — Keep Updated

**Status:** Live ✅

**Current commands registered:**
- `/capabilities` — Show what TataNano can do
- `/status` — Quick health check
- `/send_pdf` — Send a file as PDF

**Future commands to add as new skills are built:**
- `/update` — Update NanoClaw to latest version
- `/customize` — Customize TataNano settings
- `/remember` — Save something to memory
- `/scopes` — List all saved scopes

---

## 5. `/update-nanoclaw` Skill

**Status:** Identified as needed. NanoClaw has an `update-nanoclaw` skill in the project but it runs on the HOST (Claude Code), not inside the container.

**What to build:** A Telegram-friendly update guide skill that walks Bartek through the update process step by step via chat — since he has no terminal access.

---

## 6. `/customize` Skill

**Status:** Identified as needed.

**What it should do:**
- View/edit TataNano's name and personality (CLAUDE.md)
- Create new skills directly from Telegram chat
- Manage scheduled tasks interactively
- Set group memory

---

## 7. Group Memory Setup

**Status:** Currently disabled (`Group memory: no` in /status).

**What to do:** Create `/workspace/group/CLAUDE.md` with persistent context about Bartek's preferences, projects, and TataNano customizations.

---

## 8. `/send-image`, `/send-audio` Skills

**Status:** Foundation exists (send-pdf uses Telegram sendDocument API).

**What to build:** Extend the send-pdf skill to also handle:
- `sendPhoto` for images (shows inline in Telegram)
- `sendAudio` for audio files
- `sendVideo` for video clips

---

## Summary Table

| # | Improvement | Priority | Effort |
|---|-------------|----------|--------|
| 1 | Bake send-pdf skill | 🔴 High | Low |
| 2 | Fix global/ permissions | 🔴 High | Low (one command) |
| 3 | LinguaFlow tutoring bot | 🟡 Medium | High |
| 4 | Telegram command menu updates | 🟢 Low | Low |
| 5 | /update-nanoclaw skill | 🟡 Medium | Medium |
| 6 | /customize skill | 🟡 Medium | Medium |
| 7 | Group memory setup | 🟡 Medium | Low |
| 8 | send-image/audio skills | 🟢 Low | Low |
