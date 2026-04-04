import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { askZofia, type Message } from './claude.js'
import { textToVoice, cleanupVoiceFile } from './tts.js'
import { initDb, logGlucose, logMeal, logMedication } from './db.js'
import { startScheduler } from './scheduler.js'

const execFileAsync = promisify(execFile)

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = JSON.parse(fs.readFileSync(
  new URL('../config.json', import.meta.url),
  'utf8'
))

const MAMA_ID: number = CONFIG.mama_chat_id
const BARTEK_ID: number = CONFIG.bartek_chat_id
const GROUP_CHAT_ID: number = CONFIG.group_chat_id
const ALLOWED_IDS = new Set([MAMA_ID, BARTEK_ID])

const GLUCOSE_THRESHOLDS = CONFIG.glucose_thresholds
const RATE_LIMIT_PER_MINUTE = 10
const DAILY_CAP = 100
const ROLLING_WINDOW = 20
const MAX_VOICE_DURATION_SECONDS = 120
const POLL_TIMEOUT = 30

// ── State ─────────────────────────────────────────────────────────────────────
let botToken = ''
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

async function sendBoth(chatId: number, text: string): Promise<void> {
  await sendText(chatId, text)
  try {
    const oggPath = await textToVoice(text)
    await sendVoice(chatId, oggPath)
    cleanupVoiceFile(oggPath)
    log('INFO', 'Voice sent OK')
  } catch (err) {
    log('WARN', 'TTS failed, text only', { err: String(err) })
  }
}

async function getFileUrl(fileId: string): Promise<string> {
  const res = await tg('getFile', { file_id: fileId }) as { result?: { file_path?: string } }
  const filePath = res.result?.file_path
  if (!filePath) throw new Error('Could not get file path')
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`
}

// ── Limits ────────────────────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Failed to download voice: ${res.status}`)
  const buffer = await res.arrayBuffer()
  const tmpFile = path.join('/tmp', `mama-voice-${Date.now()}.ogg`)
  fs.writeFileSync(tmpFile, Buffer.from(buffer))

  try {
    const { stdout } = await execFileAsync('/opt/homebrew/bin/whisper', [
      tmpFile, '--model', 'base', '--language', 'pl',
      '--output_format', 'txt', '--output_dir', '/tmp',
    ])
    fs.unlinkSync(tmpFile)
    const txtFile = tmpFile.replace('.ogg', '.txt')
    if (fs.existsSync(txtFile)) {
      const text = fs.readFileSync(txtFile, 'utf8').trim()
      fs.unlinkSync(txtFile)
      return text
    }
    return stdout.trim()
  } catch (err) {
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    throw new Error(`Transcription failed: ${err}`)
  }
}

// ── Glucose detection ─────────────────────────────────────────────────────────
function parseGlucose(text: string): number | null {
  const match = text.match(/\b(\d{2,3})\b/)
  if (!match) return null
  const val = parseInt(match[1])
  if (val < 30 || val > 600) return null
  return val
}

async function handleGlucoseAlert(value: number): Promise<void> {
  if (value < GLUCOSE_THRESHOLDS.critical_low || value > GLUCOSE_THRESHOLDS.critical_high) {
    const alertMsg = value < GLUCOSE_THRESHOLDS.critical_low
      ? `⚠️ UWAGA: Mama zmierzyła cukier ${value} mg/dL — to bardzo niski poziom! Proszę działaj natychmiast.`
      : `⚠️ UWAGA: Mama zmierzyła cukier ${value} mg/dL — to bardzo wysoki poziom!`
    await sendText(BARTEK_ID, alertMsg)
    log('WARN', 'Glucose alert sent to Bartek', { value })
  }
}

function glucoseComment(value: number): string {
  if (value < GLUCOSE_THRESHOLDS.critical_low)
    return `Mierzysz ${value} mg/dL — to jest bardzo niski cukier! Zjedz lub wypij coś słodkiego natychmiast i powiedz Bartkowi!`
  if (value < GLUCOSE_THRESHOLDS.low)
    return `Mierzysz ${value} mg/dL — trochę nisko. Zjedz coś małego.`
  if (value <= GLUCOSE_THRESHOLDS.high)
    return `Mierzysz ${value} mg/dL — to jest dobry wynik! Brawo! 👏`
  if (value <= GLUCOSE_THRESHOLDS.critical_high)
    return `Mierzysz ${value} mg/dL — trochę wysoko. Postaraj się nie jeść słodyczy i trochę się poruszaj.`
  return `Mierzysz ${value} mg/dL — to jest bardzo wysoki cukier! Bartek już wie. Zadzwoń do lekarza jeśli nie czujesz się dobrze.`
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(
  chatId: number,
  userId: number,
  firstName: string,
  text?: string,
  voice?: { file_id: string; duration: number },
): Promise<void> {
  if (!ALLOWED_IDS.has(userId)) return

  if (isRateLimited()) {
    await sendText(chatId, 'Chwileczkę, za dużo wiadomości naraz. Spróbuj za chwilę.')
    return
  }
  if (isDailyCapped()) {
    await sendText(chatId, 'Na dziś to już wszystko. Do jutra!')
    return
  }

  let userMessage = text || ''

  // Transcribe voice
  if (voice) {
    if (voice.duration > MAX_VOICE_DURATION_SECONDS) {
      await sendText(chatId, 'Głosówka za długa. Nagraj krótszą lub napisz.')
      return
    }
    try {
      const fileUrl = await getFileUrl(voice.file_id)
      userMessage = await transcribeVoice(fileUrl)
      log('INFO', 'Voice transcribed', { text: userMessage.slice(0, 50) })
    } catch (err) {
      log('ERROR', 'Transcription failed', { err: String(err) })
      await sendText(chatId, 'Przepraszam, nie słyszę wyraźnie. Napisz proszę.')
      return
    }
  }

  if (!userMessage.trim()) return

  // Medication confirmation
  const lowerMsg = userMessage.toLowerCase()
  if (lowerMsg.includes('wzięłam') || lowerMsg.includes('wzialem') || lowerMsg.includes('wziełam')) {
    const hour = new Date().getHours()
    const timeOfDay = hour < 12 ? 'poranne' : 'wieczorne'
    logMedication(timeOfDay)
    await sendBoth(chatId, `Świetnie! Zapisałam, że wzięłaś leki ${timeOfDay}. Tak trzymać! 💪`)
    return
  }

  // Glucose reading (number only message)
  const glucoseValue = parseGlucose(userMessage)
  if (glucoseValue !== null && userMessage.trim().match(/^\d+\s*(mg)?$/)) {
    logGlucose(glucoseValue)
    await handleGlucoseAlert(glucoseValue)
    const comment = glucoseComment(glucoseValue)
    logMeal(userMessage, comment)
    await sendBoth(chatId, comment)
    return
  }

  // Meal log detection
  if (lowerMsg.includes('jadłam') || lowerMsg.includes('zjadłam') || lowerMsg.includes('piłam') ||
      lowerMsg.includes('jadlem') || lowerMsg.includes('zjadlem')) {
    logMeal(userMessage)
  }

  // General conversation via Claude
  const senderName = firstName || (userId === MAMA_ID ? 'Mama' : 'Bartek')

  log('INFO', 'Processing message', { userId, length: userMessage.length })

  try {
    const reply = await askZofia(history, senderName, userMessage)
    addToHistory('user', userMessage)
    addToHistory('assistant', reply)
    await sendBoth(chatId, reply)
  } catch (err) {
    log('ERROR', 'Reply failed', { err: String(err) })
    await sendText(chatId, 'Przepraszam, coś nie działa. Spróbuj za chwilę.')
  }
}

// ── Polling loop ──────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  let offset = 0
  log('INFO', 'MamaZdrowie bot started, polling...')

  while (true) {
    try {
      const res = await tg('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      }) as {
        result?: Array<{
          update_id: number
          message?: {
            from?: { id: number; first_name?: string }
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
        const firstName = msg.from?.first_name ?? ''
        await handleMessage(msg.chat.id, userId, firstName, msg.text, msg.voice)
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
    botToken = await readKeychain('MamaZdrowie-telegram-token', 'bartek')
  } catch (err) {
    log('ERROR', 'Failed to load credentials', { err: String(err) })
    process.exit(1)
  }

  baseUrl = `https://api.telegram.org/bot${botToken}`
  initDb()
  log('INFO', 'Database initialized')

  startScheduler(GROUP_CHAT_ID, BARTEK_ID, async (chatId, text, voiceAlso = false) => {
    if (voiceAlso) {
      await sendBoth(chatId, text)
    } else {
      await sendText(chatId, text)
    }
  })

  log('INFO', `MamaZdrowie bot ready — group: ${GROUP_CHAT_ID}, mama: ${MAMA_ID}, bartek: ${BARTEK_ID}`)
  await poll()
}

main()
