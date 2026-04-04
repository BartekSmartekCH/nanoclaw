import fs from 'fs'
import path from 'path'
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { askBart, ensureBartConfig, type Message } from './claude.js'
import { textToVoice, cleanupVoiceFile } from './tts.js'

// ── Config ────────────────────────────────────────────────────────────────────
const ALLOWED_USER_ID = 8774386022
const RATE_LIMIT_PER_MINUTE = 10
const DAILY_CAP = 100
const ROLLING_WINDOW = 20
const MAX_VOICE_DURATION_SECONDS = 120
const POLL_TIMEOUT = 30

// ── State ─────────────────────────────────────────────────────────────────────
let botToken = ''
let fishApiKey = ''
let baseUrl = ''

const history: Message[] = []
let dailyCount = 0
let dailyReset = Date.now() + 86_400_000
const rateBucket: number[] = []

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function sendText(chatId: number, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 4000)
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
}

async function sendVoice(chatId: number, filePath: string): Promise<void> {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('voice', new Blob([fs.readFileSync(filePath)], { type: 'audio/ogg' }), 'voice.ogg')
  await fetch(`${baseUrl}/sendVoice`, { method: 'POST', body: form })
}

async function getFileUrl(fileId: string): Promise<string> {
  const res = await tg('getFile', { file_id: fileId }) as { result?: { file_path?: string } }
  const filePath = res.result?.file_path
  if (!filePath) throw new Error('Could not get file path')
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
function isRateLimited(): boolean {
  const now = Date.now()
  const windowStart = now - 60_000
  while (rateBucket.length > 0 && rateBucket[0] < windowStart) rateBucket.shift()
  if (rateBucket.length >= RATE_LIMIT_PER_MINUTE) return true
  rateBucket.push(now)
  return false
}

function isDailyCapped(): boolean {
  if (Date.now() > dailyReset) {
    dailyCount = 0
    dailyReset = Date.now() + 86_400_000
    log('INFO', 'Daily cap reset')
  }
  if (dailyCount >= DAILY_CAP) return true
  dailyCount++
  return false
}

// ── Conversation history ──────────────────────────────────────────────────────
function addToHistory(role: 'user' | 'assistant', content: string): void {
  history.push({ role, content })
  while (history.length > ROLLING_WINDOW) history.shift()
}

// ── Voice transcription ───────────────────────────────────────────────────────
async function transcribeVoice(fileUrl: string): Promise<string> {
  const res = await fetch(fileUrl)
  if (!res.ok) throw new Error(`Failed to download voice file: ${res.status}`)
  const buffer = await res.arrayBuffer()
  const tmpFile = path.join('/tmp', `bart-voice-${Date.now()}.ogg`)
  fs.writeFileSync(tmpFile, Buffer.from(buffer))

  // Use whisper for transcription
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  try {
    const whisper = '/opt/homebrew/bin/whisper'
    const { stdout } = await execFileAsync(whisper, [tmpFile, '--model', 'base', '--output_format', 'txt', '--output_dir', '/tmp'])
    fs.unlinkSync(tmpFile)
    const txtFile = tmpFile.replace('.ogg', '.txt')
    if (fs.existsSync(txtFile)) {
      const text = fs.readFileSync(txtFile, 'utf8').trim()
      fs.unlinkSync(txtFile)
      return text
    }
    return stdout.trim()
  } catch {
    fs.unlinkSync(tmpFile)
    throw new Error('Voice transcription failed')
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(chatId: number, userId: number, text?: string, voice?: { file_id: string; duration: number }): Promise<void> {
  if (userId !== ALLOWED_USER_ID) return

  if (isRateLimited()) {
    await sendText(chatId, "Ay caramba! Slow down, man! You're giving me a headache!")
    return
  }

  if (isDailyCapped()) {
    await sendText(chatId, "Don't have a cow, man — but I'm all talked out for today. Try again tomorrow!")
    return
  }

  let userMessage = text || ''

  if (voice) {
    if (voice.duration > MAX_VOICE_DURATION_SECONDS) {
      await sendText(chatId, "Eat my shorts! That voice message is way too long, dude.")
      return
    }
    try {
      const fileUrl = await getFileUrl(voice.file_id)
      userMessage = await transcribeVoice(fileUrl)
      log('INFO', 'Voice transcribed', { length: userMessage.length })
    } catch (err) {
      log('ERROR', 'Transcription failed', { err: String(err) })
      await sendText(chatId, "Ay caramba! I couldn't hear that. Try typing instead, man.")
      return
    }
  }

  if (!userMessage.trim()) return

  log('INFO', 'Processing message', { userId, length: userMessage.length })

  try {
    const reply = await askBart(history, userMessage)
    addToHistory('user', userMessage)
    addToHistory('assistant', reply)

    // Always send text first, then voice
    await sendText(chatId, reply)

    try {
      const oggPath = await textToVoice(fishApiKey, reply)
      await sendVoice(chatId, oggPath)
      cleanupVoiceFile(oggPath)
      log('INFO', 'Voice sent OK')
    } catch (ttsErr) {
      log('WARN', 'TTS failed, text-only', { err: String(ttsErr) })
      // Text already sent — no need to notify user
    }
  } catch (err) {
    log('ERROR', 'Reply failed', { err: String(err) })
    await sendText(chatId, "Ugh, something totally broke, man. Ay caramba!")
  }
}

// ── Polling loop ──────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  let offset = 0
  log('INFO', 'Bart Simpson bot started, polling...')

  while (true) {
    try {
      const res = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] }) as {
        result?: Array<{
          update_id: number
          message?: {
            from?: { id: number }
            chat: { id: number }
            text?: string
            voice?: { file_id: string; duration: number }
          }
        }>
      }

      for (const update of res.result ?? []) {
        offset = update.update_id + 1
        const msg = update.message
        if (!msg) continue
        const userId = msg.from?.id ?? 0
        await handleMessage(msg.chat.id, userId, msg.text, msg.voice)
      }
    } catch (err) {
      log('WARN', 'Poll error, retrying in 5s', { err: String(err) })
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  log('INFO', 'Loading credentials from Keychain...')

  try {
    botToken = await readKeychain('telegram-bot', 'Bart Simpson')
    fishApiKey = await readKeychain('fish-audio', 'api-key')
  } catch (err) {
    log('ERROR', 'Failed to load credentials', { err: String(err) })
    process.exit(1)
  }

  baseUrl = `https://api.telegram.org/bot${botToken}`
  ensureBartConfig()
  log('INFO', 'Credentials loaded OK')
  await poll()
}

main()
