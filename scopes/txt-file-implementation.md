# Implementation Instructions: Plain Text File Support
**For:** TataNano Coder
**File to edit:** `src/channels/telegram.ts`
**Effort:** ~30 lines, one file, no new imports

---

## Context

The `message:document` handler starts at line 605. Currently, any document that is not an image or PDF hits an early-return fallback and is stored as `[Document: filename]`. We need to intercept `text/*` mime types before that guard.

Current code at lines 605-614:
```typescript
this.bot.on('message:document', async (ctx) => {
  const mime = ctx.message.document?.mime_type || '';
  const name = ctx.message.document?.file_name || 'file';
  if (
    !IMAGE_PROCESSOR_AVAILABLE ||
    (!mime.startsWith('image/') && mime !== 'application/pdf')
  ) {
    storeNonText(ctx, `[Document: ${name}]`);
    return;
  }
```

---

## The change

Insert the text file branch **after line 607** (after `const name = ...`) and **before line 608** (before the `if (!IMAGE_PROCESSOR_AVAILABLE` guard).

Add this block:

```typescript
    if (mime.startsWith('text/')) {
      const doc = ctx.message.document!;
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      try {
        const file = await ctx.api.getFile(doc.file_id);
        if (!file.file_path) {
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const raw = await fetch(fileUrl).then(r => r.text());
        const MAX = 65_536;
        const truncated = raw.length > MAX
          ? raw.slice(0, MAX) + '\n[...truncated]'
          : raw;
        const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
        const content = `[File: ${name}]\n\`\`\`\n${truncated}\n\`\`\`${caption}`;
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
        logger.info({ chatJid, msgId, mime }, 'Text document extracted');
      } catch (err) {
        logger.error({ err }, 'Error reading text document');
        storeNonText(ctx, `[Document: ${name}]`);
      }
      return;
    }
```

Nothing else changes. The existing `if (!IMAGE_PROCESSOR_AVAILABLE ...)` guard immediately follows and handles PDF/image as before.

---

## Build

```
npm run build
```

Must compile with zero errors.

---

## Tests to write

Add to the test file for `telegram.ts` (or create one if absent):

1. `text/plain` mime → `onMessage` called with file content
2. `text/markdown` mime → `onMessage` called (mime.startsWith covers it)
3. `text/csv` mime → `onMessage` called
4. File exactly 65,536 chars → content passed as-is, no truncation marker
5. File exactly 65,537 chars → content truncated with `[...truncated]`
6. `file_path` missing → falls back to `storeNonText`
7. `fetch()` throws → falls back to `storeNonText`, does not crash
8. Binary file with `text/plain` mime → does not throw (garbled output accepted)
9. Caption present → appended to content after the code block
10. `application/pdf` → existing handler still fires (regression)

---

## Smoke test (Bartek runs after deploy)

1. Send a `.txt` file in Telegram → bot reads and quotes the content in its reply
2. Send a text file larger than 64 KB → reply ends with `[...truncated]`
3. Send a PDF → existing PDF handler still fires (no regression)
