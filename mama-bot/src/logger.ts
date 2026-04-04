export function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString()
  const line = data ? `[${ts}] ${level} ${msg} ${JSON.stringify(data)}` : `[${ts}] ${level} ${msg}`
  console.log(line)
}
