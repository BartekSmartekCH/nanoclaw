import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { log } from './logger.js'

const execFileAsync = promisify(execFile)

const VOICE_ID = '55bef2337e5a4d6888eeac7f4bd01146'
const FISH_API_URL = 'https://api.fish.audio/v1/tts'
const TMP_DIR = path.join(os.tmpdir(), 'bart-bot-tts')
const FETCH_TIMEOUT_MS = 20_000

export async function textToVoice(apiKey: string, text: string): Promise<string> {
  fs.mkdirSync(TMP_DIR, { recursive: true })

  const ts = Date.now()
  const mp3Path = path.join(TMP_DIR, `tts-${ts}.mp3`)
  const oggPath = path.join(TMP_DIR, `tts-${ts}.ogg`)

  log('INFO', 'TTS: calling Fish Audio API', { chars: text.length })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(FISH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: VOICE_ID,
        format: 'mp3',
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Fish Audio API error ${res.status}: ${err}`)
  }

  log('INFO', 'TTS: Fish Audio responded OK, reading buffer', { status: res.status })
  const buffer = await res.arrayBuffer()
  fs.writeFileSync(mp3Path, Buffer.from(buffer))
  log('INFO', 'TTS: MP3 written', { bytes: buffer.byteLength })

  log('INFO', 'TTS: converting MP3 to OGG via ffmpeg')
  await execFileAsync('/opt/homebrew/bin/ffmpeg', [
    '-y', '-i', mp3Path,
    '-c:a', 'libopus', '-b:a', '64k',
    oggPath,
  ])

  fs.unlinkSync(mp3Path)
  log('INFO', 'TTS: OGG ready', { path: oggPath })
  return oggPath
}

export function cleanupVoiceFile(filePath: string): void {
  try { fs.unlinkSync(filePath) } catch { /* ignore */ }
}
