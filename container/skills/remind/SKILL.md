---
name: remind
description: Set, list, pause, resume, and cancel reminders or recurring tasks. Use /remind to create a one-time or recurring reminder. Manage with /remind list, /remind pause [id], /remind resume [id], /remind cancel [id].
triggers:
  - /remind
  - remind me
  - set a reminder
  - set reminder
  - alert me
  - don't let me forget
  - dont let me forget
  - schedule a reminder
  - wake me up
  - notify me
---

# /remind — Reminders & Scheduled Tasks

Schedule one-time or recurring reminders. The bot sends a message at the specified time.

## Commands

| Command | What it does |
|---------|-------------|
| `/remind [text] at [time]` | One-time reminder at a specific time |
| `/remind [text] in [duration]` | One-time reminder after a delay |
| `/remind [text] every [period]` | Recurring reminder |
| `/remind list` | Show all reminders for this group |
| `/remind pause [id]` | Pause a reminder (keeps it, won't fire) |
| `/remind resume [id]` | Resume a paused reminder |
| `/remind cancel [id]` | Delete a reminder permanently |
| `/remind edit [id] [new time]` | Change the schedule of an existing reminder |

## Creating a Reminder

### Step 1 — Parse the request

Extract from the user's message:
- **What** — the reminder text or action
- **When** — time expression (relative, absolute, recurring)
- **Frequency** — once, interval, or cron

**Time expression patterns:**

| User says | Schedule type | Schedule value |
|-----------|--------------|----------------|
| "in 30 minutes" | `interval` | `1800000` |
| "in 2 hours" | `once` | ISO timestamp = now + 2h |
| "at 3pm" / "at 15:00" | `once` | ISO timestamp today at 15:00 (tomorrow if past) |
| "tomorrow at 9am" | `once` | ISO timestamp tomorrow at 09:00 |
| "on Friday at 10am" | `once` | ISO timestamp next Friday at 10:00 |
| "every day at 9am" | `cron` | `0 9 * * *` |
| "every Monday at 9am" | `cron` | `0 9 * * 1` |
| "every hour" | `interval` | `3600000` |
| "every 30 minutes" | `interval` | `1800000` |
| "every weekday at 8am" | `cron` | `0 8 * * 1-5` |
| "every 1st of the month" | `cron` | `0 9 1 * *` |

Day-of-week mapping: Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6, Sun=0.

**Get current date and time to compute timestamps — always run this first:**
```bash
date '+%Y-%m-%dT%H:%M:%S'
```

For `once` with a specific clock time: construct `YYYY-MM-DDTHH:MM:SS` (no `Z`, no timezone suffix — the scheduler uses local system time).

**"tomorrow"** means the NEXT calendar day. Get today's date from the `date` command above, add 1 day:
```bash
date -d '+1 day' '+%Y-%m-%d' 2>/dev/null || date -v+1d '+%Y-%m-%d'
```
Then combine with the requested time: `YYYY-MM-27THH:MM:SS`.

If the specified time has already passed today, schedule for the same time tomorrow.

### Step 2 — Clarify if ambiguous

Before creating, ask the user if:
- Time is ambiguous ("9" → 9am or 9pm?)
- No time specified at all
- "remind me to X" with no when → ask "When would you like to be reminded?"

Do NOT ask for confirmation if the request is clear.

### Step 3 — Build the prompt

The task runs in `isolated` context — it has no access to chat history. The prompt must be self-contained:

```
Send this reminder to the user: "[verbatim reminder text]"
```

For reminders that summarize something (e.g. "remind me to check metrics"), add a short action:

```
Send this reminder to the user: "Check metrics now — this is your scheduled reminder."
```

### Step 4 — Call schedule_task

CRITICAL: ALWAYS pass `context_mode: "isolated"`. Never use `"group"`. Reminders are self-contained — they do not need chat history.

```
mcp__nanoclaw__schedule_task {
  prompt: "Send this reminder to the user: \"[text]\"",
  schedule_type: "once" | "interval" | "cron",
  schedule_value: "[ISO timestamp, ms as string, or cron expression]",
  context_mode: "isolated"
}
```

### Step 5 — Add to macOS Reminders app

REQUIRED for `once` and `cron` tasks. Skip only for `interval` tasks (no fixed due date).

Use Bash to write this IPC file — replace the placeholder values with the actual date/time:

```bash
cat > /workspace/ipc/tasks/remind-mac-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"do shell script \"open -a Reminders\"\ndelay 3\ntell application \"Reminders\"\ntell account \"iCloud\"\nset d to current date\nset year of d to YYYY\nset month of d to MM\nset day of d to DD\nset hours of d to HH\nset minutes of d to MIN\nset seconds of d to 0\nmake new reminder at end of list \"Reminders\" with properties {name:\"TITLE\", due date:d}\nend tell\nend tell"}
EOF
```

Replace: `YYYY` year, `MM` month (1–12), `DD` day, `HH` hour (0–23), `MIN` minutes (0–59), `TITLE` reminder text.

Example for March 27 at 15:00, title "Go to school":
```bash
cat > /workspace/ipc/tasks/remind-mac-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"do shell script \"open -a Reminders\"\ndelay 3\ntell application \"Reminders\"\ntell account \"iCloud\"\nset d to current date\nset year of d to 2026\nset month of d to 3\nset day of d to 27\nset hours of d to 15\nset minutes of d to 0\nset seconds of d to 0\nmake new reminder at end of list \"Reminders\" with properties {name:\"Go to school\", due date:d}\nend tell\nend tell"}
EOF
```

### Step 6 — Confirm to user

```
✅ Reminder set: "[text]"
   [Human-readable schedule, e.g. "Every Monday at 9:00 AM" or "In 30 minutes"]
   ID: [first 12 chars of task id]

Use /remind list to see all, /remind cancel [id] to remove.
```

---

## Listing Reminders

Call `mcp__nanoclaw__list_tasks` and format the result as:

```
📋 *Your Reminders*

1. [first 12 chars of id] — "[prompt excerpt]"
   Every Monday at 9:00 AM — active
   Next: 2026-03-30 09:00

2. [id] — "[prompt excerpt]"
   Once at 2026-03-27 15:00 — active

No reminders? → "No reminders set. Use /remind [text] at [time] to create one."
```

---

## Pausing / Resuming

- `/remind pause [id]` → `mcp__nanoclaw__pause_task { task_id: "[id]" }`
  Confirm: `⏸ Reminder [id] paused.`

- `/remind resume [id]` → `mcp__nanoclaw__resume_task { task_id: "[id]" }`
  Confirm: `▶️ Reminder [id] resumed.`

ID matching: accept partial IDs (first 8+ chars). If ambiguous, list matches and ask user to be more specific.

---

## Cancelling

`/remind cancel [id]` → `mcp__nanoclaw__cancel_task { task_id: "[id]" }`

Confirm: `🗑 Reminder [id] cancelled.`

---

## Editing

`/remind edit [id] [new time expression]` → parse the new time, then:

```
mcp__nanoclaw__update_task {
  task_id: "[id]",
  schedule_type: "[new type]",
  schedule_value: "[new value]"
}
```

Confirm: `✏️ Reminder [id] updated — [new human-readable schedule].`

---

## Edge Cases

- **Past time today** → schedule for same time tomorrow; tell the user.
- **"in X minutes" with small X (< 2)** → warn: "Minimum interval is ~1 minute (scheduler polls every 60s). Scheduling for 1 minute from now."
- **Cron validation** → if you generate a cron expression, verify it looks correct before calling schedule_task. Standard 5-field cron: `min hour dom month dow`.
- **Interval with human label** → store milliseconds as the schedule_value string (e.g. `"3600000"`).
- **No matching task for pause/cancel/edit** → call list_tasks first and show the user what's available.
