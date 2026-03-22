# TTS Text Cleaning — Coder Instructions

## Problem

`src/index.ts:313` passes raw agent output directly to `synthesize()`. Markdown symbols, emoji, bullet points, and URLs are read aloud by edge-tts verbatim.

The text message sent to the user (`sendMessage` at line 304) must remain untouched — all emoji and formatting kept.

## Files to change

1. `src/voice.ts` — add `cleanForTTS()` export
2. `src/index.ts` — call `cleanForTTS()` before `synthesize()`

---

## Step 1 — Add `cleanForTTS()` to `src/voice.ts`

Add this function just above the `export async function synthesize(...)` at line 279:

```typescript
/**
 * Strip markdown and symbols that edge-tts would read aloud literally.
 * The original text (with emoji, formatting) is sent as the text companion — untouched.
 */
export function cleanForTTS(text: string): string {
  return text
    // Remove markdown bold/italic: **word** *word* __word__ _word_
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    // Remove inline code: `code`
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks: ```...```
    .replace(/```[\s\S]*?```/g, '')
    // Remove markdown headings: ## Heading
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bullet points: • or - or *
    .replace(/^[•\-\*]\s+/gm, '')
    // Remove URLs (http/https)
    .replace(/https?:\/\/\S+/g, '')
    // Remove markdown links: [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove emoji (Unicode ranges)
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Remove remaining stray symbols: #, |, ~, >
    .replace(/[#|~>]/g, '')
    // Collapse multiple blank lines / whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

---

## Step 2 — Update `src/index.ts` line 313

Import `cleanForTTS` at the top of the file alongside the existing `synthesize` import:

```typescript
import { synthesize, cleanForTTS } from './voice.js';
```

Then at line 313, change:

```typescript
synthesize(text, voiceConfig.tts_voice, `reply-${Date.now()}`)
```

to:

```typescript
synthesize(cleanForTTS(text), voiceConfig.tts_voice, `reply-${Date.now()}`)
```

`text` at line 304 (`channel.sendMessage`) remains unchanged — full emoji and markdown preserved for the text companion.

---

## Verification

After `npm run build` and restart:

1. Send a voice message. Reply should come back as audio + text.
2. Audio: clean speech, no "asterisk", "bullet", "hashtag", no emoji sounds
3. Text companion: full formatting, emoji all present
4. Send a text message — text-only reply, no regression

## Scope

~25 lines, two files, no new dependencies, no migrations.
