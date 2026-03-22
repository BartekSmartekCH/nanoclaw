# CoderBot — Implementation Instructions for Mac Mini Coder

**Date:** 2026-03-21
**Status:** Stage 3 approved — ready to implement

---

## Step 1: Create directory structure

```bash
cd ~/nanoclaw
mkdir -p coder-bot/src coder-bot/launchd
```

---

## Step 2: `coder-bot/package.json`

```json
{
  "name": "coder-bot",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## Step 3: `coder-bot/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true
  },
  "include": ["src"]
}
```

---

## Step 4: `coder-bot/src/keychain.ts`

```typescript
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export async function readKeychain(service: string, account: string): Promise<string> {
  const { stdout } = await execFileAsync('security', [
    'find-generic-password', '-s', service, '-a', account, '-w'
  ])
  const value = stdout.trim()
  if (!value) throw new Error(`Empty Keychain value for: ${service}`)
  return value
}
```

---

## Step 5: `coder-bot/src/logger.ts`

```typescript
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.join(process.env.HOME!, 'Library/Logs/nanoclaw-coder')
const LOG_FILE = path.join(LOG_DIR, 'coder-bot.log')
const MAX_BYTES = 5_000_000

fs.mkdirSync(LOG_DIR, { recursive: true })

export function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`
  process.stdout.write(line)
  try {
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.writeFileSync(LOG_FILE, '')
    } catch {}
    fs.writeFileSync(LOG_FILE, line, { flag: 'a' })
    fs.chmodSync(LOG_FILE, 0o600)
  } catch {}
}
```

---

## Step 6: `coder-bot/src/validator.ts`

```typescript
import fs from 'fs'
import path from 'path'

export const ALLOWED_PATHS = [
  '/Users/bartek/nanoclaw',
  '/Users/bartek/openclaw',
]

const DANGEROUS_PATTERNS = [
  /\bsecurity\s+find/i,
  /\bsecurity\s+add/i,
  /\bcurl\b.*\|\s*bash/i,
  /\bwget\b.*\|\s*bash/i,
  /\brm\s+-rf\s+~/i,
  /git\s+clone\s+(?!https:\/\/github\.com\/BartekSmartekCH\/|git@github\.com:BartekSmartekCH\/)/i,
]

const SCRIPT_PATTERNS = [
  /\bnpm\s+run\b/i,
  /\bnpm\s+test\b/i,
  /\bnpx\s+vitest\b/i,
  /\bnpx\s+jest\b/i,
]

export function validatePrompt(prompt: string): void {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(prompt)) {
      throw new Error(`Prompt blocked: contains potentially dangerous pattern`)
    }
  }
}

export function requiresScriptConfirmation(prompt: string): boolean {
  return SCRIPT_PATTERNS.some(p => p.test(prompt))
}

export function validatePath(userPath: string, isWrite: boolean): string {
  let canonical: string
  try {
    canonical = fs.realpathSync(userPath)
  } catch {
    const parent = path.dirname(userPath)
    const canonicalParent = fs.realpathSync(parent)
    canonical = path.join(canonicalParent, path.basename(userPath))
  }
  const isAllowed = ALLOWED_PATHS.some(
    p => canonical === p || canonical.startsWith(p + '/')
  )
  if (!isAllowed) throw new Error(`Access denied: ${canonical}`)
  if (isWrite && canonical.startsWith('/Users/bartek/openclaw')) {
    throw new Error(`Write access denied: openclaw is read-only`)
  }
  return canonical
}
```

---

## Step 7: `coder-bot/src/claude.ts`

```typescript
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { log } from './logger.js'

const CLAUDE_CONFIG_DIR = '/Users/bartek/.claude-coder'
const WORKING_DIR = '/Users/bartek/nanoclaw'
const TIMEOUT_MS = 10 * 60 * 1000

let isFirstMessage = true
let activeProcess: ChildProcess | null = null

export function ensureClaudeConfig(): void {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { mode: 0o700, recursive: true })
  const claudeMd = path.join(CLAUDE_CONFIG_DIR, 'CLAUDE.md')
  fs.writeFileSync(claudeMd, `# CoderBot Security Constraints

You are CoderBot, a direct coding assistant for Bartek.

## Allowed working directories
- /Users/bartek/nanoclaw (read/write)
- /Users/bartek/openclaw (READ ONLY — never write here)

## Command restrictions
- git clone: only from https://github.com/BartekSmartekCH/ repos
- npm install: always use --ignore-scripts flag
- Never run: security, curl | bash, wget | bash, rm -rf ~

## Behaviour
- Never read or expose .env files or Keychain contents
- Never log tokens or credentials
- Keep responses concise — this is a Telegram chat
`, { mode: 0o600 })
}

export function isRunning(): boolean { return activeProcess !== null }

export function abortCurrent(): void {
  if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null }
}

export function clearSession(): void {
  abortCurrent()
  isFirstMessage = true
  log('INFO', 'Session cleared')
}

export async function runClaude(
  prompt: string,
  onChunk: (text: string) => Promise<void>
): Promise<void> {
  if (activeProcess) throw new Error('Claude is already running. Send /abort to cancel.')

  const args = ['--print', '--no-container', '--dangerously-skip-permissions']
  if (!isFirstMessage) args.push('--continue')
  args.push(prompt)

  const proc = spawn('claude', args, {
    cwd: WORKING_DIR,
    env: { ...process.env, CLAUDE_CONFIG_DIR },
  })
  activeProcess = proc

  let buffer = ''
  let lastFlush = Date.now()
  let flushing = false

  const flushBuffer = async (force = false) => {
    if (!buffer || flushing) return
    if (force || buffer.length > 3800 || Date.now() - lastFlush > 5000) {
      flushing = true
      const toSend = buffer
      buffer = ''
      lastFlush = Date.now()
      try { await onChunk(toSend) } finally { flushing = false }
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    void flushBuffer()
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    log('WARN', 'Claude stderr', { text: chunk.toString().trim() })
  })

  const timeout = setTimeout(() => {
    proc.kill()
    log('WARN', 'Claude timed out after 10 minutes')
  }, TIMEOUT_MS)

  return new Promise((resolve, reject) => {
    proc.on('close', async (code) => {
      clearTimeout(timeout)
      activeProcess = null
      isFirstMessage = false
      while (flushing) await new Promise(r => setTimeout(r, 50))
      if (buffer) await flushBuffer(true)
      if (code === 0 || code === null) resolve()
      else reject(new Error(`Claude exited with code ${code}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      activeProcess = null
      reject(err)
    })
  })
}
```

---

## Step 8: `coder-bot/src/index.ts`

> ⚠️ Before saving this file, replace `123456789` with your real Telegram user ID.
> Get it by messaging `@userinfobot` on Telegram.

```typescript
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { runClaude, isRunning, abortCurrent, clearSession, ensureClaudeConfig } from './claude.js'
import { validatePrompt, requiresScriptConfirmation } from './validator.js'

// ⚠️  Replace with your real Telegram user ID (message @userinfobot)
const BARTEK_USER_ID = 123456789

const POLL_TIMEOUT = 30
interface Update {
  update_id: number
  message?: { from?: { id: number }; chat: { id: number }; text?: string }
}

let botToken = ''
let baseUrl = ''
const pendingConfirmations = new Map<number, string>()

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function send(chatId: number, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 4000) {
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
  }
}

async function executePrompt(chatId: number, prompt: string): Promise<void> {
  await send(chatId, '⏳ Working...')
  try {
    await runClaude(prompt, async (chunk) => { await send(chatId, chunk) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Claude error', { msg })
    await send(chatId, `❌ ${msg}`)
  }
}

async function handleMessage(chatId: number, userId: number, text: string): Promise<void> {
  if (userId !== BARTEK_USER_ID) { log('WARN', 'Unauthorized', { userId }); return }

  const input = text.trim()

  if (pendingConfirmations.has(chatId)) {
    const pending = pendingConfirmations.get(chatId)!
    pendingConfirmations.delete(chatId)
    if (input.toLowerCase() === 'yes' || input.toLowerCase() === 'y') {
      await executePrompt(chatId, pending)
    } else {
      await send(chatId, '🛑 Cancelled.')
    }
    return
  }

  if (input === '/start' || input === '/help') {
    await send(chatId, '🤖 CoderBot\n\nType any coding request and Claude Code will handle it.\n\n/clear — new conversation\n/abort — cancel task\n/status — current state')
    return
  }
  if (input === '/clear') { clearSession(); await send(chatId, '✅ Session cleared.'); return }
  if (input === '/abort') {
    if (isRunning()) { abortCurrent(); await send(chatId, '🛑 Aborted.') }
    else await send(chatId, 'Nothing running.')
    return
  }
  if (input === '/status') { await send(chatId, isRunning() ? '⚙️ Running.' : '✅ Idle.'); return }
  if (isRunning()) { await send(chatId, '⚙️ Still working. Send /abort to cancel.'); return }

  try { validatePrompt(input) } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await send(chatId, `🚫 ${msg}`); return
  }

  if (requiresScriptConfirmation(input)) {
    pendingConfirmations.set(chatId, input)
    await send(chatId, `⚠️ This will run scripts. Confirm? (yes/no)\n\n${input}`)
    return
  }

  await executePrompt(chatId, input)
}

async function poll(): Promise<void> {
  let offset = 0
  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT }) as { result: Update[] }
      for (const update of data.result ?? []) {
        offset = update.update_id + 1
        const msg = update.message
        if (msg?.text && msg.from) await handleMessage(msg.chat.id, msg.from.id, msg.text)
      }
    } catch (err) {
      log('ERROR', 'Poll error', { err })
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

async function main(): Promise<void> {
  log('INFO', 'CoderBot starting')
  ensureClaudeConfig()
  botToken = await readKeychain('NanoClaw-coder-telegram-token', 'bartek')
  if (!botToken) throw new Error('Empty Telegram token')
  baseUrl = `https://api.telegram.org/bot${botToken}`
  const oauth = await readKeychain('NanoClaw-coder-credentials', 'bartek')
  if (!oauth) throw new Error('Empty OAuth token')
  log('INFO', 'Tokens loaded')
  process.on('SIGTERM', () => { log('INFO', 'Shutdown'); abortCurrent(); process.exit(0) })
  await poll()
}

main().catch(err => { log('ERROR', 'Fatal', { err: String(err) }); process.exit(1) })
```

---

## Step 9: `coder-bot/launchd/com.nanoclaw.coder.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nanoclaw.coder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/Users/bartek/nanoclaw/coder-bot/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/bartek/nanoclaw</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/bartek</string>
    <key>CLAUDE_CONFIG_DIR</key><string>/Users/bartek/.claude-coder</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>StartInterval</key><integer>10</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/bartek/Library/Logs/nanoclaw-coder/coder-bot.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/bartek/Library/Logs/nanoclaw-coder/coder-bot.log</string>
</dict>
</plist>
```

---

## Step 10: Set your Telegram user ID

Message `@userinfobot` on Telegram. It replies with your numeric user ID.
Open `coder-bot/src/index.ts` and replace `123456789` with that number.

---

## Step 11: Store tokens in Keychain

```bash
# 1. Create a new bot via @BotFather on Telegram, copy the token
security add-generic-password -U \
  -s "NanoClaw-coder-telegram-token" -a bartek -w "YOUR_BOT_TOKEN_HERE"

# 2. Copy Claude OAuth token from TataNano's existing Keychain entry
OAUTH=$(security find-generic-password -s "Claude Code-credentials" -w)
security add-generic-password -U \
  -s "NanoClaw-coder-credentials" -a bartek -w "$OAUTH"
```

---

## Step 12: Build and install

```bash
cd ~/nanoclaw/coder-bot
npm install
npm run build

mkdir -p ~/.claude-coder
cp launchd/com.nanoclaw.coder.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.coder.plist
```

---

## Step 13: Verify

```bash
launchctl list | grep com.nanoclaw.coder
tail -f ~/Library/Logs/nanoclaw-coder/coder-bot.log
```

---

## Smoke checklist (run after install)

1. Message the new bot: `"What files are in ~/nanoclaw/src?"` → should list files
2. Message: `"npm run build"` → bot asks for confirmation → reply `yes` → build runs
3. From a different Telegram account → bot should not respond at all

---

## Uninstall (if needed)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.coder.plist
rm -f ~/Library/LaunchAgents/com.nanoclaw.coder.plist
security delete-generic-password -s "NanoClaw-coder-credentials"
security delete-generic-password -s "NanoClaw-coder-telegram-token"
rm -rf ~/nanoclaw/coder-bot/dist
rm -rf ~/.claude-coder
```
