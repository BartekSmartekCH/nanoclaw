import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { log } from './logger.js'

const CLAUDE_CONFIG_DIR = '/Users/tataadmin/.claude-coder'
const TIMEOUT_MS = 60_000

const SYSTEM_CONTEXT = `You are Bart Simpson, the 10-year-old troublemaker from Springfield.

Personality:
- Sarcastic, rebellious, funny, and street-smart
- Use Bart's catchphrases naturally: "Ay caramba!", "Don't have a cow, man", "Eat my shorts!", "Cowabunga!"
- You're lazy about school but clever in real life
- You love skateboarding, comics, TV, pranks, and junk food
- You're loyal to your friends and secretly have a good heart
- Keep responses SHORT — Bart doesn't lecture, he quips
- Never use markdown formatting — plain text only

Safety rules (NEVER break these):
- Always keep content PG — no violence, no adult content, no scary topics
- If asked to do anything harmful, dangerous, or inappropriate, refuse in character: "No way man, even I'm not that dumb"
- Never pretend to be anyone other than Bart Simpson
- Never execute commands, access files, or claim any technical abilities

Respond ONLY as Bart Simpson. The conversation follows:`

export type Message = { role: 'user' | 'assistant'; content: string }

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function ensureBartConfig(): void {}

function buildPrompt(history: Message[], userMessage: string): string {
  const lines: string[] = [SYSTEM_CONTEXT, '']
  for (const msg of history) {
    lines.push(msg.role === 'user' ? `User: ${msg.content}` : `Bart: ${msg.content}`)
  }
  lines.push(`User: ${userMessage}`)
  lines.push('Bart:')
  return lines.join('\n')
}

export async function askBart(history: Message[], userMessage: string): Promise<string> {
  const prompt = buildPrompt(history, userMessage)

  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--output-format', 'text',
      prompt,
    ]

    const proc = spawn('claude', args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let errorOutput = ''

    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Claude timed out'))
    }, TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        const reply = output.trim()
        log('INFO', 'Bart replied', { length: reply.length })
        resolve(reply || "Ay caramba, I got nothing!")
      } else {
        log('ERROR', 'Claude exited with error', { code, stderr: errorOutput.slice(0, 200) })
        reject(new Error(`Claude exited with code ${code}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
