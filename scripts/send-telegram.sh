#!/usr/bin/env bash
# Send a file to Bartek's Telegram chat via the NanoClaw bot.
#
# Usage:
#   send-telegram.sh <file> [caption]
#   send-telegram.sh /path/to/report.pdf "Weekly report"
#   send-telegram.sh /path/to/image.png

set -euo pipefail

CHAT_ID="8774386022"
ENV_FILE="${ENV_FILE:-/Users/tataadmin/nanoclaw/.env}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <file> [caption]" >&2
  exit 1
fi

FILE_PATH="$1"
CAPTION="${2:-}"

if [ ! -f "$FILE_PATH" ]; then
  echo "Error: file not found: $FILE_PATH" >&2
  exit 1
fi

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')
if [ -z "$TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not found in $ENV_FILE" >&2
  exit 1
fi

FILE_NAME=$(basename "$FILE_PATH")

ARGS=(-s -X POST "https://api.telegram.org/bot${TOKEN}/sendDocument"
  -F "chat_id=${CHAT_ID}"
  -F "document=@${FILE_PATH};filename=${FILE_NAME}")

if [ -n "$CAPTION" ]; then
  ARGS+=(-F "caption=${CAPTION}")
fi

RESPONSE=$(curl "${ARGS[@]}" 2>/dev/null)
OK=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")

if [ "$OK" = "True" ]; then
  echo "Sent: ${FILE_NAME}"
else
  DESC=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description','unknown error'))" 2>/dev/null || echo "$RESPONSE")
  echo "Error: $DESC" >&2
  exit 1
fi
