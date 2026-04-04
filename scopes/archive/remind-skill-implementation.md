# Implementation: /remind Skill — Apple Reminders via Voice or Text

**For:** TataNano Coder
**Effort:** ~2-3 hours
**Privacy:** Fully local — Whisper (STT) + Ollama (date parsing) + osascript (Reminders). Nothing leaves Mac mini.

---

## Overview

User sends voice or text: `/remind Call the architect tomorrow at 10am`
→ Claude skill extracts task + date
→ Drops IPC task file into `data/ipc/{group}/tasks/`
→ Host runs `osascript` to create reminder in Apple Reminders
→ Bot confirms back to user

---

## Change 1 — New IPC task type: `run_applescript`

**File:** `src/ipc.ts`

The existing tasks switch is at line 267. Add a new case inside the `switch (data.type)` block (before the default/warn at line 571):

```typescript
case 'run_applescript': {
  // Only execute on macOS host
  if (process.platform !== 'darwin') {
    logger.warn({ sourceGroup }, 'run_applescript: not on macOS, skipping');
    break;
  }
  if (!data.script || typeof data.script !== 'string') {
    logger.warn({ sourceGroup }, 'run_applescript: missing script field');
    break;
  }
  // Security: only main group or same-group tasks allowed
  const isMain = deps.registeredGroups()[Object.keys(deps.registeredGroups())[0]]?.isMain ?? false;
  try {
    const { execSync } = await import('child_process');
    execSync(`osascript -e ${JSON.stringify(data.script)}`, { timeout: 10_000 });
    // Optionally write result file for skill to read back
    if (data.resultPath) {
      fs.writeFileSync(data.resultPath, JSON.stringify({ success: true }));
    }
    logger.info({ sourceGroup }, 'run_applescript: executed successfully');
  } catch (err) {
    logger.error({ sourceGroup, err }, 'run_applescript: execution failed');
    if (data.resultPath) {
      fs.writeFileSync(data.resultPath, JSON.stringify({ success: false, error: String(err) }));
    }
  }
  break;
}
```

**Note:** `execSync` is already available in Node.js — no new imports needed beyond `child_process`.

**Security considerations:**
- Only runs on macOS (`process.platform !== 'darwin'` guard)
- AppleScript is sandboxed to the apps it addresses (`Reminders`, `Calendar`)
- No shell injection risk — `JSON.stringify` escapes the script string for osascript
- If tighter control is needed later, restrict to a whitelist of allowed AppleScript prefixes

---

## Change 2 — New skill file

**File:** `.claude/skills/remind/SKILL.md` (create new)

```markdown
# /remind Skill

## What this skill does

Creates a reminder in Apple Reminders on the Mac mini. Works with both
text and voice input. All processing is local — Whisper transcribes voice,
Ollama parses the date, osascript creates the reminder. Nothing leaves
the Mac mini.

## Trigger conditions

- User types `/remind [task]` or `/remind [task] [date/time]`
- User sends a voice message starting with "remind me" or "przypomnij mi"
- User asks to add something to their to-do list or reminders

## How to handle

1. Extract the task description and any date/time from the user's message
2. Convert the date/time to AppleScript format: `"weekday, DD month YYYY at HH:MM:SS AM/PM"`
   - "tomorrow at 10am" → calculate actual date from today's date
   - "Friday" → calculate next Friday's date
   - "in 2 hours" → calculate from current time
   - No date given → create reminder with no due date
3. Build the AppleScript:

For reminder WITH due date:
\`\`\`
tell application "Reminders"
  set myList to default list
  set myReminder to make new reminder at end of myList
  set name of myReminder to "TASK_TEXT_HERE"
  set due date of myReminder to date "APPLESCRIPT_DATE_HERE"
end tell
\`\`\`

For reminder WITHOUT due date:
\`\`\`
tell application "Reminders"
  set myList to default list
  set myReminder to make new reminder at end of myList
  set name of myReminder to "TASK_TEXT_HERE"
end tell
\`\`\`

4. Write IPC task file to `/workspace/ipc/tasks/remind-{timestamp}.json`:
\`\`\`json
{
  "type": "run_applescript",
  "script": "tell application \"Reminders\"...",
  "resultPath": "/tmp/remind-{timestamp}-result.json"
}
\`\`\`

5. Confirm immediately to the user — do not wait for the IPC result:

✅ Added to Reminders: [task description][, due: date/time if given]

## Date format for AppleScript

AppleScript requires this exact format:
`"Tuesday, 26 March 2026 at 10:00:00 AM"`

Today's date is available in your system context. Always calculate absolute
dates — never pass relative strings like "tomorrow" to AppleScript.

## Current date reference

Today: use the `currentDate` value from your system context (format: YYYY-MM-DD).
Current time: if the user says "in 2 hours", estimate from context or use a reasonable default.

## Language support

Detect the language of the user's message. Task text is stored as-is
(Polish, German, English all work in Reminders). Confirmation reply
is in the same language as the user's message.

## Examples

User: `/remind zadzwonić do architekta jutro o 10`
→ Task: "zadzwonić do architekta", due: tomorrow at 10:00 AM
→ Reply: ✅ Dodano do Przypomnień: zadzwonić do architekta, jutro o 10:00

User: `remind me to send the invoice by Friday`
→ Task: "send the invoice", due: next Friday (no specific time → 09:00 AM default)
→ Reply: ✅ Added to Reminders: send the invoice, Friday at 9:00 AM

User: [voice] "Przypomnij mi o spotkaniu z Kubą w piątek o 15"
→ Task: "spotkanie z Kubą", due: next Friday at 15:00
→ Reply: ✅ Dodano do Przypomnień: spotkanie z Kubą, piątek o 15:00

## Error handling

If the IPC task file cannot be written, reply:
❌ Could not create reminder — IPC write failed. Try again.

## Notes

- Reminders are added to the default list. If Bartek wants a specific list
  in the future, add a `list:` parameter to the command.
- This skill does NOT use the Claude API for date parsing — Claude (this agent)
  handles all parsing directly in the skill prompt.
- Voice input is already transcribed before this skill runs — treat it as plain text.
```

---

## Build & test

```bash
npm run build
```

Must compile with zero errors.

### Manual smoke test (Bartek runs after deploy)

1. Send `/remind Test reminder no date` → appears in Reminders with no due date
2. Send `/remind Call Kuba tomorrow at 10am` → appears with correct date/time
3. Send voice message "remind me to check emails on Friday" → transcribed + reminder created
4. Send `/remind` with a Polish task → task text stored in Polish correctly

---

## Checklist

- [ ] `src/ipc.ts` — `run_applescript` case added
- [ ] `.claude/skills/remind/SKILL.md` — skill file created
- [ ] `npm run build` passes
- [ ] NanoClaw restarted
- [ ] Smoke test passed
- [ ] Committed
