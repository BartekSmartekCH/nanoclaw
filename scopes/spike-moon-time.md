# SPIKE: Moon Time Checker

**Date:** 2026-03-22
**Status:** Draft
**Scope:** Small — 1–2 hours

---

## Problem

No current way to check the current lunar phase, moonrise/moonset times, or next full/new moon from within the bot.

---

## Solution

Add a `/moon` command that returns:
- Current lunar phase (e.g. Waxing Crescent, Full Moon)
- Moonrise and moonset times for today (based on user location or a default timezone)
- Days until next full moon and next new moon

---

## Implementation Options

### Option A — API (simplest)
Use a free moon phase API (e.g. [FarmSense](https://farmsense.net/api) or [ipgeolocation.io](https://ipgeolocation.io/astronomy-api.html)).
- Pros: accurate, no math required
- Cons: external dependency, needs API key

### Option B — Local calculation (no API)
Use an npm library like `suncalc` — calculates moon phase, moonrise, moonset from lat/long + date.
- Pros: offline, no API key, already has TypeScript types
- Cons: requires a default location (or Bartek provides one)

**Recommendation: Option B — `suncalc`**. Lightweight, no external dependency, works offline.

---

## Files to change

| File | Change |
|------|--------|
| `container/skills/moon/SKILL.md` | New skill — trigger: `/moon` |
| `src/channels/telegram.ts` | Register `/moon` command |

---

## Acceptance Criteria

- [ ] `/moon` returns current phase
- [ ] `/moon` returns moonrise + moonset times for today
- [ ] `/moon` returns days until next full moon
- [ ] Works offline (no API key required)
