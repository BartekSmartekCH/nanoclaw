# RFC: Per-Chat Manual Model Switch (`/model`)

**Status:** Draft
**Author:** Architect
**Date:** 2026-03-22

---

## 1. Problem — what happens today when Claude is down

When Claude is unavailable (auth failure, API outage, OAuth token expiry), every message to a registered group triggers the auth-error recovery path in `processGroupMessages()` (`src/index.ts` lines 358–408). The bot:

1. Detects the error pattern via `isAuthError()`.
2. Attempts one auto-refresh from Keychain.
3. If that also fails, sends the user a hard error and rolls back the cursor for a later retry.

There is no fallback. The chat goes silent until Claude is restored. Ollama is already running on the Mac mini (configured as `OLLAMA_HOST` / `OLLAMA_MODEL` in `src/config.ts` lines 85–86) but it is only used by the image processor, never as a chat backend.

---

## 2. Proposed Solution — `/model` command with per-chat state

### User-facing commands

| Command | Effect |
|---------|--------|
| `/model` | Reply with current backend for this chat: `claude` or `ollama` |
| `/model ollama` | Switch this chat to Ollama for all subsequent messages |
| `/model claude` | Switch back to Claude |

### State management

Mirror the existing `textOnlyChats` pattern exactly:

```ts
// src/index.ts — module-level, alongside voiceTriggered and textOnlyChats
const ollamaChats = new Set<string>(); // chatJids currently routed to Ollama
```

This is intentionally in-memory only. The set resets on process restart (see "What we are NOT doing").

### Request routing

In `processGroupMessages()`, after session-command interception and trigger check, branch on `ollamaChats.has(chatJid)`:

- `false` (default): existing path — call `runAgent()` → container → Claude.
- `true`: new path — call a new function `runOllamaChat()` directly from the host process, bypassing the container and the credential proxy entirely.

The branch sits at the same level as the current `runAgent()` call (around line 294 in `src/index.ts`), replacing it conditionally.

### Ollama call format

The existing image-processor uses `/api/generate` with `stream: false`, which is the Ollama-native endpoint and returns `{ response: string }`. For chat, two options exist:

**Option A — `/api/generate` (simpler, proven):**
```
POST {OLLAMA_HOST}/api/generate
{
  "model": "{OLLAMA_MODEL}",
  "prompt": "<formatted message text>",
  "stream": false
}
Response: { "response": "..." }
```
No history support; each request is stateless. Works today with zero new dependencies.

**Option B — `/api/chat` (OpenAI-compatible, supports history):**
```
POST {OLLAMA_HOST}/api/chat
{
  "model": "{OLLAMA_MODEL}",
  "messages": [{"role": "user", "content": "..."}],
  "stream": false
}
Response: { "message": { "role": "assistant", "content": "..." } }
```
Allows passing conversation history as a messages array. Requires the Coder to decide how history is sourced (see Open Questions).

*Recommendation: start with `/api/generate` (Option A) to keep scope minimal. History can be layered in later.*

### Credential proxy bypass

The credential proxy (`src/credential-proxy.ts`) only proxies traffic from containers to the Anthropic API. The new `runOllamaChat()` function runs on the host process and calls `OLLAMA_HOST` directly — no proxy involvement, no code change needed in `credential-proxy.ts`.

---

## 3. Files Affected

| File | Change |
|------|--------|
| `src/index.ts` | (1) Add `const ollamaChats = new Set<string>()` at module level near line 94–95. (2) Add `handleModelCommand()` that reads/writes the set and sends a reply. (3) In `processGroupMessages()`, branch on `ollamaChats.has(chatJid)` to call either `runAgent()` or `runOllamaChat()`. |
| `src/index.ts` | Add `async function runOllamaChat(group, prompt, chatJid)` — does a single `fetch` to `OLLAMA_HOST/api/generate`, sends the response text via `channel.sendMessage`. |
| `src/channels/telegram.ts` | (1) Register `/model` bot command handler alongside the existing `/text` handler (around line 318). (2) Add `switchModel?: (chatJid: string, target: string \| null) => string` to `TelegramChannelOpts`. (3) Add `'model'` to `TELEGRAM_BOT_COMMANDS` set so the message is not also stored. (4) Add `{ command: 'model', description: 'Switch AI backend (claude / ollama)' }` to the `defaultCommands` array. |
| `src/index.ts` (channelOpts) | Pass `switchModel` callback in the `channelOpts` object (around line 717) that reads `ollamaChats` and delegates to `handleModelCommand()`. |

No changes required in: `src/config.ts`, `src/credential-proxy.ts`, `src/session-commands.ts`, `container/agent-runner/`, any DB schema.

---

## 4. Ollama Call Format — Detail

```ts
async function runOllamaChat(
  prompt: string,
  chatJid: string,
  channel: Channel,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      await channel.sendMessage(chatJid, `Ollama error: HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { response?: string };
    const text = data.response?.trim();
    if (text) await channel.sendMessage(chatJid, text);
    else await channel.sendMessage(chatJid, 'Ollama returned an empty response.');
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    await channel.sendMessage(chatJid, `Ollama unreachable: ${msg}`);
  }
}
```

`OLLAMA_HOST` and `OLLAMA_MODEL` are already exported from `src/config.ts` — import them in `src/index.ts` alongside the existing imports.

---

## 5. What We Are NOT Doing

- **No automatic fallback.** The switch is always explicit, via `/model ollama`. If Claude fails and the user has not switched, they get the existing error message. This keeps behaviour predictable.
- **No persistent setting across restarts.** `ollamaChats` is a `Set<string>` in memory. After a process restart or deploy, all chats revert to Claude. If persistence is later needed, it can follow the same pattern as `lastAgentTimestamp` (stored in the DB via `setRouterState`).
- **No Ollama session/history.** The MVP sends only the current formatted prompt. Claude's multi-turn conversation state (session ID, CLAUDE.md, tool calls) is not replicated.
- **No streaming.** `stream: false` keeps the implementation simple and consistent with the image processor.
- **No container involvement.** Ollama runs on the Mac mini host; the call goes directly from the host Node process. No container spawning, no IPC, no session management.
- **No change to the credential proxy.** Ollama traffic never passes through it.

---

## 6. Open Questions

1. **Which Ollama model?** `OLLAMA_MODEL` currently defaults to `qwen2.5vl:7b` — a vision model chosen for image analysis. It can handle text chat, but a general-purpose model (e.g. `llama3.2:3b`, `mistral:7b`) may give better conversational quality. Should we add a separate `OLLAMA_CHAT_MODEL` env var, or reuse `OLLAMA_MODEL`?

2. **Should history be passed?** With `/api/generate` each request is stateless — the model has no memory of previous turns. For "Claude is down" emergency use this is probably fine. If Bartek wants continuity, we need to switch to `/api/chat` and decide how to source history: pull raw messages from the DB via `getMessagesSince()`, or keep a per-chat rolling buffer in memory?

3. **What if Ollama is also down?** `runOllamaChat()` will send an error message (timeout or HTTP error). Should we send a specific recovery hint (e.g. "check Ollama on the Mac mini")? And should the cursor still advance, or roll back so the message is retried when Ollama recovers?

4. **Who can use `/model`?** Same auth as `/text` (currently any chat member can call it) or restricted to `is_from_me` (Bartek only)? Recommend Bartek-only (`is_from_me`) since switching the backend is an admin operation.

5. **Should the typing indicator show during Ollama calls?** `runAgent()` manages `channel.setTyping()` around its execution. `runOllamaChat()` would need to do the same — straightforward, but worth confirming the expected UX.

---

## 7. Scope Estimate

| Item | Effort |
|------|--------|
| `ollamaChats` Set + `handleModelCommand()` in `src/index.ts` | ~30 lines |
| `runOllamaChat()` function in `src/index.ts` | ~40 lines |
| Branch in `processGroupMessages()` | ~10 lines |
| `switchModel` callback in `channelOpts` | ~5 lines |
| `/model` command handler + opts + command list in `telegram.ts` | ~25 lines |
| Unit tests (session-commands pattern; Ollama fetch mock) | ~60 lines |
| **Total** | **~170 lines** |

*Implementation risk: low. All patterns (Set for per-chat state, fetch to Ollama, bot command handler, channelOpts callback) already exist in the codebase. This is a straight composition of existing pieces.*

*The only novel risk is the Ollama call from inside `processGroupMessages()` — it runs on the same event loop as the message poller. If Ollama is slow, it will hold the group queue slot. Mitigation: the 120 s timeout in `runOllamaChat()` caps the worst case, same as the image processor.*
