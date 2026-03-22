import fs from 'fs'
import path from 'path'
export const ALLOWED_PATHS = [
  '/Users/tataadmin/nanoclaw',
  '/Users/tataadmin/.openclaw/workspace',
]
const DANGEROUS_PATTERNS = [
  /\bsecurity\s+find/i,
  /\bsecurity\s+add/i,
  /\bcurl\b.*\|\s*bash/i,
  /\bwget\b.*\|\s*bash/i,
  /\brm\s+-rf\s+~/i,
  /git\s+clone\s+(?!https:\/\/github\.com\/BartekSmartekCH\/|git@github\.com:BartekSmartekCH\/)/i,
]
const SCRIPT_PATTERNS = [
  /\bnpm\s+run\b/i,
  /\bnpm\s+test\b/i,
  /\bnpx\s+vitest\b/i,
  /\bnpx\s+jest\b/i,
]
export function validatePrompt(prompt: string): void {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(prompt)) throw new Error(`Prompt blocked: contains potentially dangerous pattern`)
  }
}
export function requiresScriptConfirmation(prompt: string): boolean {
  return SCRIPT_PATTERNS.some(p => p.test(prompt))
}
export function validatePath(userPath: string, isWrite: boolean): string {
  let canonical: string
  try { canonical = fs.realpathSync(userPath) } catch {
    const parent = path.dirname(userPath)
    canonical = path.join(fs.realpathSync(parent), path.basename(userPath))
  }
  if (!ALLOWED_PATHS.some(p => canonical === p || canonical.startsWith(p + '/')))
    throw new Error(`Access denied: ${canonical}`)
  if (isWrite && canonical.startsWith('/Users/tataadmin/.openclaw/workspace'))
    throw new Error(`Write access denied: openclaw workspace is read-only`)
  return canonical
}
