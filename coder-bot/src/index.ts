import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { promisify } from 'util'
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { runClaude, isRunning, abortCurrent, clearSession, ensureClaudeConfig, getModel, setModel } from './claude.js'
import { validatePrompt, requiresScriptConfirmation } from './validator.js'

const execFileAsync = promisify(execFile)
const BARTEK_USER_ID = 8774386022
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:7b'
const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'ollama']
let useOllama = false
const VOICE_TMP = path.join(os.tmpdir(), 'nanoclaw-voice')
const TOOL_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin'
const TOOL_ENV = { ...process.env, PATH: `${TOOL_PATH}:${process.env.PATH || ''}` }

function findTool(name: string): string | null {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}
const FFMPEG = findTool('ffmpeg')
const WHISPER = findTool('whisper')
let voiceEnabled = true

const POLL_TIMEOUT = 30
interface Update {
  update_id: number
  message?: {
    from?: { id: number }; chat: { id: number }; text?: string
    voice?: { file_id: string; duration: number }
  }
}
let botToken = '', baseUrl = ''
const pendingConfirmations = new Map<number, string>()

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return res.json()
}
async function send(chatId: number, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 4000)
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
}
async function runOllamaChat(chatId: number, prompt: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) { await send(chatId, `Ollama error: HTTP ${res.status}`); return }
    const data = (await res.json()) as { response?: string }
    const text = data.response?.trim()
    if (text) await send(chatId, text)
    else await send(chatId, 'Ollama returned an empty response.')
  } catch (err) {
    clearTimeout(timeout)
    await send(chatId, `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
}
async function executePrompt(chatId: number, prompt: string): Promise<void> {
  await send(chatId, '⏳ Working...')
  try {
    if (useOllama) await runOllamaChat(chatId, prompt)
    else await runClaude(prompt, async (chunk) => { await send(chatId, chunk) })
  }
  catch (err) { await send(chatId, `❌ ${err instanceof Error ? err.message : String(err)}`) }
}
async function handleMessage(chatId: number, userId: number, text: string): Promise<void> {
  if (userId !== BARTEK_USER_ID) { log('WARN', 'Unauthorized', { userId }); return }
  const input = text.trim()
  if (pendingConfirmations.has(chatId)) {
    const pending = pendingConfirmations.get(chatId)!
    pendingConfirmations.delete(chatId)
    if (input.toLowerCase() === 'yes' || input.toLowerCase() === 'y') await executePrompt(chatId, pending)
    else await send(chatId, '🛑 Cancelled.')
    return
  }
  if (input === '/start' || input === '/help') {
    await send(chatId, '🤖 CoderBot — direct Claude Code access\n\n/clear — new session\n/abort — cancel\n/status — state\n/model — switch AI model\n/ping — check if online\n/chatid ��� show chat ID\n/health — check Claude CLI\n/fix_auth — re-check credentials\n/text — toggle voice transcription')
    return
  }
  if (input === '/ping') { await send(chatId, '🤖 CoderBot is online.'); return }
  if (input === '/chatid') { await send(chatId, `Chat ID: ${chatId}\nType: private`); return }
  if (input === '/health') {
    try {
      await execFileAsync('claude', ['--version'], { timeout: 5000, env: { ...process.env, PATH: `${TOOL_PATH}:${process.env.PATH || ''}` } })
      await send(chatId, '✅ Claude CLI is available.')
    } catch (err) { await send(chatId, `❌ Claude CLI check failed: ${err instanceof Error ? err.message : String(err)}`) }
    return
  }
  if (input === '/fix_auth') {
    try {
      await readKeychain('NanoClaw-coder-credentials', 'bartek')
      await send(chatId, '✅ Credentials OK.')
    } catch (err) { await send(chatId, `❌ Credential check failed: ${err instanceof Error ? err.message : String(err)}`) }
    return
  }
  if (input === '/text') {
    if (!FFMPEG || !WHISPER) { await send(chatId, '⚠️ Voice tools not available.'); return }
    voiceEnabled = !voiceEnabled
    await send(chatId, voiceEnabled ? '���� Voice transcription on' : '💬 Voice transcription off')
    return
  }
  if (input === '/model' || input.startsWith('/model ')) {
    const arg = input.slice(7).trim().toLowerCase()
    if (!arg) { await send(chatId, `Current model: ${useOllama ? 'ollama' : getModel()}`); return }
    if (!VALID_MODELS.includes(arg)) { await send(chatId, `Valid models: ${VALID_MODELS.join(', ')}`); return }
    if (arg === 'ollama') { useOllama = true }
    else { useOllama = false; setModel(arg) }
    await send(chatId, `Switched to ${arg}`)
    return
  }
  if (input === '/clear') { clearSession(); await send(chatId, '✅ Session cleared.'); return }
  if (input === '/abort') {
    if (isRunning()) { abortCurrent(); await send(chatId, '🛑 Aborted.') }
    else await send(chatId, 'Nothing running.'); return
  }
  if (input === '/status') { await send(chatId, isRunning() ? '⚙️ Running.' : '✅ Idle.'); return }
  if (isRunning()) { await send(chatId, '⚙️ Still working. /abort to cancel.'); return }
  try { validatePrompt(input) } catch (err) { await send(chatId, `🚫 ${err instanceof Error ? err.message : String(err)}`); return }
  if (requiresScriptConfirmation(input)) {
    pendingConfirmations.set(chatId, input)
    await send(chatId, `⚠️ This runs scripts. Confirm? (yes/no)\n\n${input}`)
    return
  }
  await executePrompt(chatId, input)
}
async function transcribeVoice(fileId: string): Promise<string | null> {
  if (!FFMPEG || !WHISPER) { log('WARN', 'Voice tools missing', { ffmpeg: !!FFMPEG, whisper: !!WHISPER }); return null }
  fs.mkdirSync(VOICE_TMP, { recursive: true })
  const oggPath = path.join(VOICE_TMP, `${fileId}.ogg`)
  const wavPath = path.join(VOICE_TMP, `${fileId}.wav`)
  try {
    const fileData = await tg('getFile', { file_id: fileId }) as { ok: boolean; result?: { file_path: string } }
    if (!fileData.ok || !fileData.result?.file_path) return null
    const url = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`
    const res = await fetch(url)
    if (!res.ok) return null
    fs.writeFileSync(oggPath, Buffer.from(await res.arrayBuffer()))
    await execFileAsync(FFMPEG, ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath], { timeout: 30000, env: TOOL_ENV })
    await execFileAsync(WHISPER, [wavPath, '--language', 'en', '--model', 'base', '--fp16', 'False', '--output_format', 'txt', '--output_dir', VOICE_TMP], { timeout: 30000, env: TOOL_ENV })
    const txtPath = path.join(VOICE_TMP, `${fileId}.txt`)
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf-8').trim()
      try { fs.unlinkSync(txtPath) } catch {}
      return text || null
    }
    return null
  } catch (err) { log('ERROR', 'Voice transcription failed', { err: String(err) }); return null }
  finally { try { fs.unlinkSync(oggPath) } catch {} try { fs.unlinkSync(wavPath) } catch {} }
}
async function poll(): Promise<void> {
  let offset = 0
  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT }) as { ok: boolean; result: Update[] }
      log('INFO', 'Poll result', JSON.stringify(data))
      for (const u of data.result ?? []) {
        offset = u.update_id + 1
        const m = u.message
        log('INFO', 'Update', { id: u.update_id, from: m?.from?.id, text: m?.text })
        if (m?.text && m.from) await handleMessage(m.chat.id, m.from.id, m.text)
        else if (m?.voice && m.from) {
          log('INFO', 'Voice message', { fileId: m.voice.file_id, duration: m.voice.duration })
          if (m.from.id !== BARTEK_USER_ID) { log('WARN', 'Unauthorized voice', { userId: m.from.id }); continue }
          if (!voiceEnabled) { await send(m.chat.id, '💬 Voice transcription is off. Use /text to re-enable.'); continue }
          const text = await transcribeVoice(m.voice.file_id)
          if (text) { log('INFO', 'Transcribed', { length: text.length }); await handleMessage(m.chat.id, m.from.id, text) }
          else await send(m.chat.id, '⚠️ Could not transcribe voice message.')
        }
      }
    } catch (err) { log('ERROR', 'Poll error', { err: String(err) }); await new Promise(r => setTimeout(r, 5000)) }
  }
}
async function main(): Promise<void> {
  log('INFO', 'CoderBot starting')
  ensureClaudeConfig()
  botToken = await readKeychain('NanoClaw-coder-telegram-token', 'bartek')
  baseUrl = `https://api.telegram.org/bot${botToken}`
  await readKeychain('NanoClaw-coder-credentials', 'bartek')
  log('INFO', 'Tokens loaded')
  await tg('setMyCommands', { commands: [
    { command: 'help', description: 'List available commands' },
    { command: 'ping', description: 'Check if bot is online' },
    { command: 'chatid', description: 'Show chat ID' },
    { command: 'status', description: 'Current state' },
    { command: 'health', description: 'Check Claude CLI' },
    { command: 'fix_auth', description: 'Re-check credentials' },
    { command: 'model', description: 'Switch AI model (sonnet/opus/haiku/ollama)' },
    { command: 'text', description: 'Toggle voice transcription' },
    { command: 'abort', description: 'Cancel running task' },
    { command: 'clear', description: 'New session' },
  ]})
  log('INFO', 'Bot commands registered')
  process.on('SIGTERM', () => { log('INFO', 'Shutdown'); abortCurrent(); process.exit(0) })
  await poll()
}
main().catch(err => { log('ERROR', 'Fatal', { err: String(err) }); process.exit(1) })
