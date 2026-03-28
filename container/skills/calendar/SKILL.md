---
name: calendar
description: Create, list, and manage macOS Calendar events. Adds events to Calendar app (syncs via iCloud). Use /calendar or natural language like "add to calendar" or "schedule a meeting".
triggers:
  - /calendar
  - add to calendar
  - add event
  - schedule a meeting
  - put on my calendar
  - calendar event
  - book a meeting
  - block time
---

# /calendar — Calendar Events

Creates events in macOS Calendar app (syncs via iCloud to all your devices).

## Commands

| Command | What it does |
|---------|-------------|
| `/calendar [title] on [date] at [time]` | Create a one-time event |
| `/calendar [title] on [date] at [time] for [duration]` | Create event with duration |
| `/calendar list` | List upcoming events (today + next 7 days) |

## Creating an Event

### Step 1 — Parse the request

Extract:
- **Title** — event name
- **Date** — when (absolute or relative: "tomorrow", "Friday", "March 27")
- **Time** — start time
- **Duration** — optional (default: 1 hour)
- **Calendar** — optional (default: first available calendar)

### Step 2 — Compute timestamps

**Always run this first to get current date:**
```bash
date '+%Y-%m-%dT%H:%M:%S'
```

**For "tomorrow":**
```bash
date -d '+1 day' '+%Y-%m-%d' 2>/dev/null || date -v+1d '+%Y-%m-%d'
```

**For day names ("Friday"):** calculate the next occurrence of that weekday.

Default duration: 1 hour (end time = start time + 3600 seconds).

### Step 3 — Create the Calendar event via AppleScript IPC

Write an IPC file to `/workspace/ipc/tasks/calendar-mac-[timestamp].json`:

```bash
cat > /workspace/ipc/tasks/calendar-mac-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"do shell script \"open -a Calendar\"\ndelay 3\ntell application \"Calendar\"\nset startDate to current date\nset year of startDate to YYYY\nset month of startDate to MM\nset day of startDate to DD\nset hours of startDate to HH\nset minutes of startDate to MIN\nset seconds of startDate to 0\nset endDate to startDate + (DURATION_SECONDS) * seconds\ntell calendar \"CALENDAR_NAME\"\nmake new event with properties {summary:\"EVENT_TITLE\", start date:startDate, end date:endDate}\nend tell\nend tell"}
EOF
```

Replace:
- `YYYY`, `MM` (1–12), `DD`, `HH`, `MIN` — start date/time
- `DURATION_SECONDS` — duration in seconds (default: 3600)
- `CALENDAR_NAME` — use `"Home"` by default; ask user if unsure
- `EVENT_TITLE` — verbatim event title

### Step 4 — Confirm to user

```
📅 Event added: "[title]"
   [Date], [Start time] – [End time]
   Calendar: [calendar name]
   (syncs to iCloud)
```

## Listing Events

Use AppleScript to fetch upcoming events:

```bash
cat > /workspace/ipc/tasks/calendar-list-$(date +%s).json << 'EOF'
{"type":"run_applescript","script":"tell application \"Calendar\"\nset output to \"\"\nset startDate to current date\nset endDate to startDate + 7 * days\nrepeat with cal in calendars\ntry\nrepeat with ev in (every event of cal whose start date >= startDate and start date <= endDate)\nset output to output & summary of ev & \" — \" & (start date of ev as string) & \"\n\"\nend repeat\nend try\nend repeat\nreturn output\nend tell","resultPath":"/tmp/calendar-list-result.json"}
EOF
```

Then read `/tmp/calendar-list-result.json` and format the result.

## Edge Cases

- **No time given** → ask "What time?" before creating
- **Calendar not found** → fall back to the first available calendar
- **Recurring events** → not supported via this skill; tell user to add manually in Calendar app
- **Same permission as Reminders** — if it fails, user needs to grant node Automation access to Calendar in System Settings → Privacy & Security → Automation
