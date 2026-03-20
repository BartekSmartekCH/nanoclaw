# Voice Pipeline — NanoClaw

## Overview

Add voice-in/voice-out support to NanoClaw over Telegram. User sends voice note → bot transcribes, processes, replies with text + voice. Runs at the NanoClaw core level so every group/bot gets it automatically.

## Setup

- **One bot, one user per chat** (Bartek or kids' bots)
- **Shared tools on Mac mini (M1, 16GB):** `whisper` (base model), `edge-tts`, `ffmpeg` — all already installed
- **Channel:** Telegram only

## STT Pipeline (incoming voice)

1. User sends voice note in Telegram
2. NanoClaw downloads `.ogg` from Telegram API → `/tmp/{msg-id}.ogg`
3. `ffmpeg` converts `.ogg` → `.wav`
4. `whisper --model base --language {group_lang}` transcribes → text
5. Text sent to agent prefixed with `[voice]:` so agent knows it was spoken
6. Temp files deleted after transcription (`.ogg` + `.wav`)
7. **Timeout:** 30 seconds — kill whisper if it hangs
8. **Fallback:** if transcription fails → send `[Voice message — transcription failed]` to agent, log warning

## TTS Pipeline (outgoing voice)

Triggered only when the incoming message was a voice note (mirror mode).

1. Agent replies with text
2. **Text sent to Telegram first** (user gets instant response)
3. `edge-tts --voice {group_voice} --text "..." --write-media /tmp/{msg-id}.mp3`
4. `ffmpeg -i /tmp/{msg-id}.mp3 -c:a libopus -b:a 64k /tmp/{msg-id}.ogg`
5. Send `.ogg` as Telegram voice note
6. Short delay, then delete temp files (`.mp3` + `.ogg`)
7. **Timeout:** 30 seconds for edge-tts
8. **TTS cap:** skip voice for replies over 2000 characters (configurable) — text-only
9. **Fallback:** if TTS fails → text was already sent, log warning, no crash

## Typing Indicator

Show typing while transcribing and while generating TTS.

## Config Per Group

In each group's config (e.g., `groups/{name}/voice.json` or in CLAUDE.md):

```
voice:
  enabled: true
  language: es              # whisper language hint
  tts_voice: es-ES-ElviraNeural  # edge-tts voice
  reply_mode: voice+text    # voice+text | text-only
  provider: edge-tts        # future: elevenlabs
  max_tts_chars: 2000       # skip voice above this
```

## Known Voices (from OpenClaw)

| Language | Voice | Notes |
|----------|-------|-------|
| English | `en-IE-EmilyNeural` | Irish female, default |
| Swiss German | `de-CH-LeniNeural` | Swiss female |
| Spanish | `es-ES-ElviraNeural` | Spanish female (tutors) |
| Italian | `it-IT-ElsaNeural` | Italian female (Latin tutor TTS) |

## Startup Checks

On NanoClaw boot, verify `whisper`, `edge-tts`, `ffmpeg` exist in PATH.
- If any missing → disable voice feature, log clear warning
- Don't crash — text-only mode continues working

## Graceful Degradation

| Failure | Behavior |
|---------|----------|
| whisper not installed | Voice disabled at startup |
| edge-tts not installed | Voice disabled at startup |
| ffmpeg not installed | Voice disabled at startup |
| whisper hangs/fails | Send `[transcription failed]` to agent, text flow continues |
| edge-tts fails (MS servers down) | Text already sent, skip voice reply, log warning |
| Telegram send voice fails | Text already sent, log warning |

## Temp Files

- Location: `/tmp/nanoclaw-voice/`
- Naming: `{message-id}.{ext}`
- Cleanup: immediately after use, small delay for TTS send
- Startup sweep: delete stale files in `/tmp/nanoclaw-voice/` older than 1 hour

## Future: ElevenLabs

Swap `voice.provider` from `edge-tts` to `elevenlabs`. Same interface:
- Input: text + voice ID
- Output: audio file
- Config: API key in `.env`, voice ID per group

## New Bots

No per-bot wiring. Voice pipeline is in NanoClaw core. New group → set `voice.enabled: true` + language → done.

## Not In Scope

- Continuous listening / auto-send (Telegram limitation)
- Streaming TTS to user (Telegram needs complete file)
- Web UI for voice (separate project, shelved)
- WhatsApp voice (Telegram only for now)
