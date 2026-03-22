import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { log } from './logger.js'

const CLAUDE_CONFIG_DIR = '/Users/tataadmin/.claude-coder'
const WORKING_DIR = '/Users/tataadmin/nanoclaw'
const TIMEOUT_MS = 10 * 60 * 1000
let isFirstMessage = true
let activeProcess: ChildProcess | null = null

export function ensureClaudeConfig(): void {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { mode: 0o700, recursive: true })
  fs.writeFileSync(path.join(CLAUDE_CONFIG_DIR, 'CLAUDE.md'), `# CoderBot Constraint

You are CoderBot, direct coding assistant for Bartek.
Allowed dirs: /Users/tataadmin/nanoclaw (read/write), /Users/tataadmin/.openclaw/workspace (READ ONLY)
git clone: only from https://github.com/BartekSmartekCH/
npm install: always use --ignore-scripts
Never expose .env or Keychain contents. Keep responses concise.
`, { mode: 0o600 })
}
export function isRunning(): boolean { return activeProcess !== null }
export function abortCurrent(): void {
  if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null }
}
export function clearSession(): void { abortCurrent(); isFirstMessage = true; log('INFO', 'Session cleared') }

export async function runClaude(prompt: string, onChunk: (text: string) => Promise<void>): Promise<void> {
  if (activeProcess) throw new Error('Claude is already running. Send /abort to cancel.')
  const args = ['--print', '--dangerously-skip-permissions']
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
  proc.stdout.on('data', (chunk: Buffer) => { buffer += chunk.toString(); void flushBuffer() })
  proc.stderr.on('data', (chunk: Buffer) => { log('WARN', 'stderr', { text: chunk.toString().trim() }) })
  const timeout = setTimeout(() => { proc.kill(); log('WARN', 'Claude timed out') }, TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    proc.on('close', async (code) => {
      clearTimeout(timeout); activeProcess = null; isFirstMessage = false
      while (flushing) await new Promise(r => setTimeout(r, 50))
      if (buffer) await flushBuffer(true)
      log('INFO', 'Claude exited', { code })
      if (code === 0 || code === null) resolve()
      else reject(new Error(`Claude exited with code ${code}`))
    })
    proc.on('error', (err) => { clearTimeout(timeout); activeProcess = null; reject(err) })
  })
}
