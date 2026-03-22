import fs from 'fs'
import path from 'path'
const LOG_DIR = path.join(process.env.HOME!, 'Library/Logs/nanoclaw-coder')
const LOG_FILE = path.join(LOG_DIR, 'coder-bot.log')
const MAX_BYTES = 5_000_000
fs.mkdirSync(LOG_DIR, { recursive: true })
export function log(level: 'INFO'|'WARN'|'ERROR', msg: string, data?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}${data ? ' '+JSON.stringify(data) : ''}\n`
  process.stdout.write(line)
}
