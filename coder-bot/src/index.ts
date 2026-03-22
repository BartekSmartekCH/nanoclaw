import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { promisify } from 'util'
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { runClaude, isRunning, abortCurrent, clearSession, ensureClaudeConfig } from './claude.js'
import { validatePrompt, requiresScriptConfirmation } from './validator.js'

const execFileAsync = promisify(execFile)
const BARTEK_USER_ID = 8774386022
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
async function executePrompt(chatId: number, prompt: string): Promise<void> {
  await send(chatId, '⏳ Working...')
  try { await runClaude(prompt, async (chunk) => { await send(chatId, chunk) }) }
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
    await send(chatId, '🤖 CoderBot — direct Claude Code access\n\n/clear — new session\n/abort — cancel\n/status — state')
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
  process.on('SIGTERM', () => { log('INFO', 'Shutdown'); abortCurrent(); process.exit(0) })
  await poll()
}
main().catch(err => { log('ERROR', 'Fatal', { err: String(err) }); process.exit(1) })
