---
# Feature: Plain text file support in document handler

## Status
RFC approved. Ready for implementation by TataNano Coder.

## Problem
When a .txt, .md, or .csv file is sent as a document in Telegram, it comes through as `[Document: filename.txt]` placeholder. The content is never extracted or passed to the agent.

## Location
`src/channels/telegram.ts` — inside the `message:document` handler (starts line 605). The early-return guard at lines 608–614 is where the new branch must be inserted, before the existing PDF/image handling.

## Proposed fix

Add a condition at the top of the document handler, before the PDF/image branch:

```typescript
if (mime.startsWith('text/')) {
  const file = await ctx.api.getFile(doc.file_id);
  if (!file.file_path) return;
  const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
  const raw = await fetch(fileUrl).then(r => r.text());
  const truncated = raw.length > 65_536
    ? raw.slice(0, 65_536) + '\n[...truncated]'
    : raw;
  const label = `[File: ${doc.file_name ?? 'document'}]\n\`\`\`\n${truncated}\n\`\`\``;
  const caption = ctx.message?.caption ? `\n${ctx.message.caption}` : '';
  await this.opts.onMessage({ ...ctx, message: { ...ctx.message, text: label + caption } });
  return;
}
```

- Uses same `ctx.api.getFile()` + `fetch()` pattern as lines 482, 551, 639
- `this.botToken` is accessible (private class member, line 158)
- No new dependencies, no temp files

## Mime scope
`mime.startsWith('text/')` covers: `text/plain`, `text/markdown`, `text/csv`, `text/html`, and any future text subtypes.

## Size limit
Cap at *64 KB* (65,536 chars). Files larger than this are truncated with `[...truncated]` appended. Telegram allows up to 20 MB via getFile — without a cap, large files would overflow the LLM context window.

## Known limitations (accepted risk)
- *Binary files mis-typed as text/plain:* Will decode to garbage UTF-8 characters. Won't crash, produces noise. Accepted as v1 limitation.
- *Non-UTF-8 encodings:* Will produce garbled output. Accepted as v1 limitation.
- *Prompt injection:* File content passed to onMessage is the same attack surface as regular text messages — not a new vector.

## What does NOT change
- PDF handling — unchanged
- Image handling — unchanged
- All other document types — unchanged (fall through to existing placeholder)

## Effort
Small — ~15 lines in `src/channels/telegram.ts`. No new dependencies, no new imports needed.

## Tests
- Unit test: mime `text/plain` → content extracted and passed to onMessage
- Unit test: file over 64 KB → truncated with `[...truncated]`
- Unit test: mime `application/pdf` → existing handler still fires (regression)
- Smoke test: send a `.txt` file in Telegram → agent receives and quotes the content
---
