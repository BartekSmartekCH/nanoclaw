import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { log } from './logger.js'

const execFileAsync = promisify(execFile)

const VOICE = 'pl-PL-ZofiaNeural'
const TMP_DIR = path.join(os.tmpdir(), 'mama-bot-tts')
const EDGE_TTS = '/opt/homebrew/bin/edge-tts'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'

export async function textToVoice(text: string): Promise<string> {
  fs.mkdirSync(TMP_DIR, { recursive: true })

  const ts = Date.now()
  const mp3Path = path.join(TMP_DIR, `tts-${ts}.mp3`)
  const oggPath = path.join(TMP_DIR, `tts-${ts}.ogg`)

  log('INFO', 'TTS: generating speech', { chars: text.length })

  await execFileAsync(EDGE_TTS, [
    '--voice', VOICE,
    '--text', text,
    '--write-media', mp3Path,
  ])

  log('INFO', 'TTS: converting to OGG')
  await execFileAsync(FFMPEG, [
    '-y', '-i', mp3Path,
    '-c:a', 'libopus', '-b:a', '64k',
    oggPath,
  ])

  fs.unlinkSync(mp3Path)
  log('INFO', 'TTS: OGG ready')
  return oggPath
}

export function cleanupVoiceFile(filePath: string): void {
  try { fs.unlinkSync(filePath) } catch { /* ignore */ }
}
