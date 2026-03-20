---
name: letter
description: Read and reply to foreign-language letters. Send a photo or PDF scan of a letter to analyse it — the bot will extract the text, summarise the content, and help you draft a reply.
triggers:
  - /letter
  - letter
---

# Letter Skill

## What this skill does

When a user sends a photo or document (PDF / scanned image) of a letter, the bot:

1. Extracts the text using Apple Vision OCR (fast, on-device)
2. Analyses the letter with Ollama (local vision model — no data leaves the Mac mini)
3. Returns a structured summary: sender, date, reference number, tone, required action, deadline
4. Offers to draft a reply in the detected language

## Trigger conditions

- User sends a **photo** of a document
- User sends a **PDF** or image file as a document attachment
- User types `/letter` (manual trigger for a letter already in context)

## Response format

### After processing a letter

```
📄 **Letter analysed**

**From:** {sender or "Unknown"}
**Date:** {date or "Not stated"}
**Reference:** {reference or "—"}
**Tone:** {tone}  |  **Action:** {action}

**Summary:** {one-line summary}

{if deadline} ⚠️ **Deadline:** {deadline}

---
Would you like me to draft a reply? If yes, let me know:
- Language for the reply (detected: {language})
- Any specific points to include
```

### When OCR is unavailable

```
📎 I received your document but OCR is not available on this system right now.
Please make sure Ollama is running (`ollama serve`) and try again.
```

### When image processor is disabled

```
[Photo - OCR unavailable]
```

## Draft reply flow

When the user asks for a draft reply:

1. Use the extracted OCR text and analysis from the IPC file (`[letter]: /path/to/file.json`)
2. Read the JSON file to get `ocrText` and `analysis`
3. Detect the original language from the OCR text
4. Draft a polite, appropriately-toned reply in that language
5. Present the draft with a note: *"Here is a draft reply in {language}. Let me know if you'd like any changes."*

## Tone → reply tone mapping

| Letter tone | Reply tone |
|-------------|-----------|
| routine     | Friendly, clear |
| formal      | Formal, professional |
| urgent      | Prompt, direct, acknowledges urgency |
| legal       | Formal, careful — recommend user reviews with a lawyer |
| junk        | Suggest ignoring; offer to draft an opt-out if needed |

## IPC file format

Letters processed by the host are stored at `data/ipc/files/letter-{msgId}-{timestamp}.json`:

```json
{
  "processedAt": "2026-03-21T00:00:00.000Z",
  "ocrText": "Full extracted text...",
  "analysis": {
    "sender": "Stadtwerke München",
    "date": "15. März 2026",
    "reference": "KD-2026-88234",
    "summary": "Annual gas contract renewal — reply required by 31 March",
    "deadline": "31. März 2026",
    "tone": "formal",
    "action": "reply_needed"
  }
}
```

## Notes

- All processing is **local** — no data sent to external APIs
- Works for any language Apple Vision and Ollama can read (German, French, Spanish, Polish, etc.)
- Large PDFs (multi-page) are processed page by page; OCR text is concatenated
- If Ollama analysis fails, the raw OCR text is still returned so the user can read it
