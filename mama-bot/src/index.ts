import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readKeychain } from './keychain.js'
import { log } from './logger.js'
import { askZofia, analyzeFood, type Message } from './claude.js'
import { textToVoice, cleanupVoiceFile } from './tts.js'
import { initDb, logGlucose, logMeal, logMedication } from './db.js'
import { startScheduler, onMedicationConfirmed } from './scheduler.js'

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
const MEDICATIONS: Array<{ name: string; times: string[]; dose: string }> = CONFIG.medications ?? []
const RATE_LIMIT_PER_MINUTE = 10
const DAILY_CAP = 100
const ROLLING_WINDOW = 20
const MAX_VOICE_DURATION_SECONDS = 120
const POLL_TIMEOUT = 30
const PHOTOS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'photos')
const PHOTO_RETENTION_DAYS = 90

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

async function downloadFile(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
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

// ── Medication detection ──────────────────────────────────────────────────────

// Fuzzy match: general confirmation words
const GENERAL_CONFIRM = ['tak', 'yes', 'wzięłam', 'wzialem', 'wziełam', 'brałam', 'bralAM', 'już', 'juz', 'wzielam', 'ok', 'okay']

function detectMedicationConfirmation(text: string): { confirmed: boolean; specific: string | null } {
  const lower = text.toLowerCase().trim()

  // Check for general confirmation
  const isGeneral = GENERAL_CONFIRM.some(word => {
    const w = word.toLowerCase()
    return lower === w || lower.startsWith(w + ' ') || lower.endsWith(' ' + w) || lower.includes(' ' + w + ' ')
  })

  if (isGeneral) return { confirmed: true, specific: null }

  // Check for specific medication name mention
  for (const med of MEDICATIONS) {
    const name = med.name.toLowerCase()
    if (lower.includes(name) && (
      lower.includes('wzięłam') || lower.includes('wzialem') || lower.includes('wziełam') ||
      lower.includes('brałam') || lower.includes('wzielam') || lower.includes('wzielam') ||
      lower.includes('biorę') || lower.includes('biore') || lower.includes('już') || lower.includes('juz')
    )) {
      return { confirmed: true, specific: med.name }
    }
  }

  return { confirmed: false, specific: null }
}

// ── Food photo handler ────────────────────────────────────────────────────────

async function handleFoodPhoto(
  chatId: number,
  fileId: string,
  mimeType: string,
): Promise<void> {
  log('INFO', 'Processing food photo', { fileId })

  let photoBuffer: Buffer
  let fileUrl: string
  try {
    fileUrl = await getFileUrl(fileId)
    photoBuffer = await downloadFile(fileUrl)
  } catch (err) {
    log('ERROR', 'Photo download failed', { err: String(err) })
    await sendBoth(chatId, 'Mamo, nie mogę odczytać zdjęcia. Spróbuj wysłać ponownie.')
    return
  }

  // Save photo locally
  fs.mkdirSync(PHOTOS_DIR, { recursive: true })
  const photoFileName = `photo-${Date.now()}.jpg`
  const photoPath = path.join(PHOTOS_DIR, photoFileName)
  fs.writeFileSync(photoPath, photoBuffer)

  let analysisText: string
  let glycemicAssessment: 'low' | 'medium' | 'high' = 'medium'
  try {
    const result = await analyzeFood(photoBuffer, mimeType)
    analysisText = result.text
    glycemicAssessment = result.glycemicAssessment
  } catch (err) {
    log('ERROR', 'Food analysis failed', { err: String(err) })
    await sendBoth(chatId, 'Mamo, nie mogę przeanalizować tego zdjęcia. Napisz mi co jesz, to powiem Ci co myślę.')
    return
  }

  logMeal('(zdjęcie posiłku)', analysisText, photoPath, glycemicAssessment)
  await sendBoth(chatId, analysisText)
}

// ── Photo cleanup (90-day retention) ─────────────────────────────────────────

function cleanupOldPhotos(): void {
  if (!fs.existsSync(PHOTOS_DIR)) return
  const cutoff = Date.now() - PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const file of fs.readdirSync(PHOTOS_DIR)) {
    const filePath = path.join(PHOTOS_DIR, file)
    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
        removed++
      }
    } catch { /* ignore */ }
  }
  if (removed > 0) log('INFO', `Cleaned up ${removed} old photo(s)`)
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(
  chatId: number,
  userId: number,
  firstName: string,
  text?: string,
  voice?: { file_id: string; duration: number },
  photo?: Array<{ file_id: string; width: number; height: number }>,
  photoMimeType?: string,
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

  // Food photo
  if (photo && photo.length > 0) {
    const largest = photo[photo.length - 1]
    await handleFoodPhoto(chatId, largest.file_id, photoMimeType ?? 'image/jpeg')
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

  // Medication confirmation (fuzzy)
  const { confirmed, specific } = detectMedicationConfirmation(userMessage)
  if (confirmed) {
    if (specific) {
      const med = MEDICATIONS.find(m => m.name === specific)
      logMedication(specific, med?.dose)
      onMedicationConfirmed()
      await sendBoth(chatId, `Świetnie! Zapisałam ${specific}. Tak trzymać! 💊`)
    } else {
      // General confirmation — log all medications for current time window
      const hour = new Date().getHours()
      const isMorning = hour < 14
      const medsForNow = MEDICATIONS.filter(m =>
        m.times.some(t => {
          const h = parseInt(t.split(':')[0])
          return isMorning ? h < 14 : h >= 14
        })
      )
      for (const med of medsForNow) {
        logMedication(med.name, med.dose)
      }
      onMedicationConfirmed()
      await sendBoth(chatId, `Świetnie! Zapisałam leki. Tak trzymać! 💊`)
    }
    return
  }

  // Glucose reading (number only message)
  const glucoseValue = parseGlucose(userMessage)
  if (glucoseValue !== null && userMessage.trim().match(/^\d+\s*(mg)?$/)) {
    logGlucose(glucoseValue)
    await handleGlucoseAlert(glucoseValue)
    const comment = glucoseComment(glucoseValue)
    await sendBoth(chatId, comment)
    return
  }

  // Meal log detection
  const lowerMsg = userMessage.toLowerCase()
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
            photo?: Array<{ file_id: string; width: number; height: number }>
            document?: { file_id: string; mime_type?: string }
          }
        }>
      }

      for (const update of res.result ?? []) {
        offset = update.update_id + 1
        const msg = update.message
        if (!msg) continue
        const userId = msg.from?.id ?? 0
        const firstName = msg.from?.first_name ?? ''

        // Handle document sent as photo (some clients send JPEG as document)
        let photo = msg.photo
        let photoMimeType = 'image/jpeg'
        if (!photo && msg.document?.mime_type?.startsWith('image/')) {
          photo = [{ file_id: msg.document.file_id, width: 0, height: 0 }]
          photoMimeType = msg.document.mime_type
        }

        await handleMessage(msg.chat.id, userId, firstName, msg.text, msg.voice, photo, photoMimeType)
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

  // Clean up old photos on startup
  cleanupOldPhotos()

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
