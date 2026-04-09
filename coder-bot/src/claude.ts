import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { log } from './logger.js'

const NANOCLAW_DIR = '/Users/tataadmin/nanoclaw'
const CODER_CONVERSATIONS_DIR = path.join(NANOCLAW_DIR, 'groups', 'coder', 'conversations')
const CODER_INDEX_DIR = path.join(NANOCLAW_DIR, 'groups', 'coder', 'memory-index')
const INDEXER_PATH = path.join(NANOCLAW_DIR, 'container', 'skills', 'memory-search', 'indexer.py')

function archiveSession(prompt: string, response: string): void {
  try {
    fs.mkdirSync(CODER_CONVERSATIONS_DIR, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const timestamp = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Zurich' })
    const file = path.join(CODER_CONVERSATIONS_DIR, `${date}.md`)
    const entry = `\n---\n\n# Conversation\n\nArchived: ${timestamp}\n\n**User**: ${prompt}\n\n**CoderBot**: ${response}\n`
    fs.appendFileSync(file, entry, 'utf-8')
    log('INFO', 'Session archived', { file, chars: entry.length })
  } catch (err) {
    log('WARN', 'Archive write failed', { err: String(err) })
  }
}

function triggerIndexer(): void {
  try {
    const proc = spawn('python3', [
      INDEXER_PATH,
      '--group', 'coder',
      '--base', NANOCLAW_DIR,
      '--index-dir', CODER_INDEX_DIR,
    ], { detached: true, stdio: 'ignore' })
    proc.unref()
    log('INFO', 'Indexer triggered (background)')
  } catch (err) {
    log('WARN', 'Indexer trigger failed', { err: String(err) })
  }
}

const CLAUDE_CONFIG_DIR = '/Users/tataadmin/.claude-coder'
const SESSION_FILE = path.join(CLAUDE_CONFIG_DIR, 'coder-session')
const WORKING_DIR = '/Users/tataadmin/nanoclaw'
const TIMEOUT_MS = 60 * 60 * 1000
let isFirstMessage = !fs.existsSync(SESSION_FILE)
let activeProcess: ChildProcess | null = null
let currentModel = 'opus'

export function getModel(): string { return currentModel }
export function setModel(m: string): void { currentModel = m }

export function ensureClaudeConfig(): void {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { mode: 0o700, recursive: true })
  fs.writeFileSync(path.join(CLAUDE_CONFIG_DIR, 'CLAUDE.md'), `# CoderBot Constraint

You are CoderBot, direct coding assistant for Bartek.
Allowed dirs: /Users/tataadmin/nanoclaw (read/write), /Users/tataadmin/.openclaw/workspace (READ ONLY)
git clone: only from https://github.com/BartekSmartekCH/
npm install: always use --ignore-scripts
Never expose .env or Keychain contents. Keep responses concise.

## Knowledge

Before starting non-trivial tasks, check these files for context on past decisions and project state:
- /Users/tataadmin/nanoclaw/groups/global/knowledge.md — merged knowledge from all groups
- /Users/tataadmin/nanoclaw/groups/coder/knowledge.md — CoderBot session history

To search conversation memory semantically:
  python3 /Users/tataadmin/nanoclaw/container/skills/memory-search/search.py --group coder "your query" --base /Users/tataadmin/nanoclaw
`, { mode: 0o600 })
}
export function isRunning(): boolean { return activeProcess !== null }
export function abortCurrent(): void {
  if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null }
}
export function clearSession(): void { abortCurrent(); isFirstMessage = true; try { fs.unlinkSync(SESSION_FILE) } catch {} log('INFO', 'Session cleared') }

export async function runClaude(prompt: string, onChunk: (text: string) => Promise<void>): Promise<void> {
  if (activeProcess) throw new Error('Claude is already running. Send /abort to cancel.')
  const args = ['--dangerously-skip-permissions', '--model', currentModel, '--output-format', 'text']
  if (!isFirstMessage) args.push('--continue')
  args.push(prompt)
  log('INFO', 'Spawning claude', { args: args.slice(0, -1) })
  const proc = spawn('claude', args, { cwd: WORKING_DIR, env: { ...process.env, CLAUDE_CONFIG_DIR }, stdio: ['ignore', 'pipe', 'pipe'] })
  activeProcess = proc
  let buffer = '', lastFlush = Date.now(), flushing = false
  const flushBuffer = async (force = false) => {
    if (!buffer || flushing) return
    if (force || buffer.length > 3800 || Date.now() - lastFlush > 5000) {
      flushing = true; const toSend = buffer; buffer = ''; lastFlush = Date.now()
      log('INFO', 'Sending chunk', { length: toSend.length })
      try { await onChunk(toSend) } finally { flushing = false }
    }
  }
  let fullResponse = ''
  proc.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); buffer += text; fullResponse += text; void flushBuffer() })
  proc.stderr.on('data', (chunk: Buffer) => { log('WARN', 'stderr', { text: chunk.toString().trim() }) })
  const timeout = setTimeout(() => { proc.kill(); log('WARN', 'Claude timed out') }, TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    proc.on('close', async (code) => {
      clearTimeout(timeout); activeProcess = null
      while (flushing) await new Promise(r => setTimeout(r, 50))
      if (buffer) await flushBuffer(true)
      log('INFO', 'Claude exited', { code })
      if (code === 0 || code === null) {
        if (isFirstMessage) { isFirstMessage = false; fs.writeFileSync(SESSION_FILE, '') }
        archiveSession(prompt, fullResponse.trim())
        triggerIndexer()
        resolve()
      } else {
        // On failure/timeout, reset session so next message starts fresh
        isFirstMessage = true; try { fs.unlinkSync(SESSION_FILE) } catch {}
        reject(new Error(`Claude exited with code ${code}`))
      }
    })
    proc.on('error', (err) => { clearTimeout(timeout); activeProcess = null; reject(err) })
  })
}
