---
name: send-pdf
description: Send files (PDF, documents, images, etc.) directly to the current Telegram chat. Converts HTML files to PDF using agent-browser before sending. Use when the user asks to "send me the file", "send PDF", "send the document", "share the file", etc.
---

# Send File / PDF to Telegram Chat

Send any file from the workspace to the current Telegram chat using the Telegram Bot API.

## When to use

- User asks to "send me" a file, PDF, document, etc.
- User asks to "share" or "send" a specific file
- User asks to convert an HTML file to PDF and send it

## How it works

### Step 1: Identify the file

Find the file the user wants sent. Look in `/workspace/group/` and its subdirectories.

If the file doesn't exist, tell the user and list available files.

### Step 2: Convert HTML to PDF if needed

If the target file is an HTML file and the user wants a PDF, convert it first using agent-browser:

```bash
agent-browser open "file:///workspace/group/path/to/file.html"
agent-browser pdf /tmp/output.pdf
agent-browser close
```

The file to send is now `/tmp/output.pdf`.

For non-HTML files (PDF, DOCX, ZIP, images, etc.), skip this step and send the file directly.

### Step 3: Get credentials

Read the bot token from the environment file:

```bash
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /workspace/project/data/env/env | cut -d= -f2)
```

Get the chat ID. The chat JID is available via the NANOCLAW_CHAT_JID environment variable (format: `tg:NNNNNN`). Extract the numeric part:

```bash
CHAT_ID=$(echo "$NANOCLAW_CHAT_JID" | sed 's/^tg://')
```

If NANOCLAW_CHAT_JID is empty, fall back to the known main chat ID:

```bash
if [ -z "$CHAT_ID" ]; then
  # Query from database
  CHAT_ID=$(python3 -c "
import sqlite3
conn = sqlite3.connect('/workspace/project/store/messages.db')
row = conn.execute(\"SELECT jid FROM registered_groups WHERE is_main=1\").fetchone()
print(row[0].replace('tg:','') if row else '')
")
fi
```

### Step 4: Send the file

Use curl to call the Telegram sendDocument API:

```bash
FILE_PATH="/path/to/file"
CAPTION="Here is your file"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@${FILE_PATH}" \
  -F "caption=${CAPTION}")

echo "$RESPONSE"
```

Check the response for `"ok":true` to confirm success.

### Step 5: Report to user

If successful, confirm the file was sent. If it failed, show the error from the Telegram API response.

## Complete example: sending an existing file

```bash
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /workspace/project/data/env/env | cut -d= -f2)
CHAT_ID=$(echo "$NANOCLAW_CHAT_JID" | sed 's/^tg://')
if [ -z "$CHAT_ID" ]; then
  CHAT_ID=$(python3 -c "import sqlite3; conn=sqlite3.connect('/workspace/project/store/messages.db'); row=conn.execute(\"SELECT jid FROM registered_groups WHERE is_main=1\").fetchone(); print(row[0].replace('tg:','') if row else '')")
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@/workspace/group/myfile.pdf" \
  -F "caption=Here is your file"
```

## Complete example: converting HTML to PDF and sending

```bash
# Convert
agent-browser open "file:///workspace/group/tatanano-guide/GUIDE.html"
agent-browser pdf /tmp/guide.pdf
agent-browser close

# Send
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /workspace/project/data/env/env | cut -d= -f2)
CHAT_ID=$(echo "$NANOCLAW_CHAT_JID" | sed 's/^tg://')
if [ -z "$CHAT_ID" ]; then
  CHAT_ID=$(python3 -c "import sqlite3; conn=sqlite3.connect('/workspace/project/store/messages.db'); row=conn.execute(\"SELECT jid FROM registered_groups WHERE is_main=1\").fetchone(); print(row[0].replace('tg:','') if row else '')")
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@/tmp/guide.pdf" \
  -F "caption=Here is the guide as PDF"
```

## Supported file types

Any file type works with sendDocument. For specific media types, you can also use:
- `sendPhoto` for images (shows inline)
- `sendAudio` for audio files
- `sendVideo` for video files

But `sendDocument` works universally for all file types.

## Troubleshooting

- If the bot token is missing, check `/workspace/project/data/env/env`
- If the chat ID is empty, query the database as shown above
- File size limit: Telegram allows up to 50MB for bot uploads
- If curl fails, check network connectivity
