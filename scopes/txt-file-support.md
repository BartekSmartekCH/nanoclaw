---
# Feature: Plain text file support in document handler

## Status
Not started. Implement via /dev in the development group.

## Problem
When a .txt file is sent as a document in Telegram, it comes through as [Document: filename.txt] placeholder. The content is never extracted.

## Location
src/channels/telegram.ts line 595 — document handler
Line 596 reads mime_type. Line 602 falls back to placeholder for anything that is not application/pdf or image/*.
text/plain hits the fallback and is never read.

## Proposed fix
Add a condition before the PDF/image branch:
- If mime_type === "text/plain": download the file, read as UTF-8, pass content directly to onMessage — no OCR needed.
- Keep existing PDF and image/* handling unchanged.

## Effort
Small — ~20 lines in telegram.ts. No new dependencies.
---
