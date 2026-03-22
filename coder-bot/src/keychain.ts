import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
export async function readKeychain(service: string, account: string): Promise<string> {
  const { stdout } = await execFileAsync('security', [
    'find-generic-password', '-s', service, '-a', account, '-w'
  ])
  const value = stdout.trim()
  if (!value) throw new Error(`Empty Keychain value for: ${service}`)
  return value
}
