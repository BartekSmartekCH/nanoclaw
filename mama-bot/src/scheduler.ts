import cron from 'node-cron'
import { log } from './logger.js'
import { getGlucoseWeeklySummary } from './db.js'

export type SendFn = (chatId: number, text: string, voiceAlso?: boolean) => Promise<void>

export function startScheduler(
  groupChatId: number,
  bartekChatId: number,
  send: SendFn,
): void {
  log('INFO', 'Scheduler started')

  // 07:30 — Good morning
  cron.schedule('30 7 * * *', async () => {
    log('INFO', 'Scheduler: morning greeting')
    await send(groupChatId, 'Dzień dobry! 🌞 Jak się czujesz dziś rano? Czy dobrze spałaś?', true)
  }, { timezone: 'Europe/Warsaw' })

  // 08:00 — Morning medication
  cron.schedule('0 8 * * *', async () => {
    log('INFO', 'Scheduler: morning medication')
    await send(groupChatId, 'Czas na poranne leki! 💊 Pamiętasz? Napisz "wzięłam" gdy je weźmiesz.', true)
  }, { timezone: 'Europe/Warsaw' })

  // 13:00 — Lunch
  cron.schedule('0 13 * * *', async () => {
    log('INFO', 'Scheduler: lunch')
    await send(groupChatId, 'Dobry obiad! 🍽️ Co dziś jadłaś? Możesz mi powiedzieć, a ja ocenię czy to dobre dla cukru.', true)
  }, { timezone: 'Europe/Warsaw' })

  // 20:00 — Evening medication
  cron.schedule('0 20 * * *', async () => {
    log('INFO', 'Scheduler: evening medication')
    await send(groupChatId, 'Wieczorna pora na leki! 💊 Nie zapomnij. Napisz "wzięłam" gdy je weźmiesz.', true)
  }, { timezone: 'Europe/Warsaw' })

  // 21:30 — Evening glucose + goodnight
  cron.schedule('30 21 * * *', async () => {
    log('INFO', 'Scheduler: evening glucose')
    await send(groupChatId, 'Dobranoc! 🌙 Jak był dzień? Zmierzyłaś cukier wieczorny? Jeśli tak — napisz mi wynik.', true)
  }, { timezone: 'Europe/Warsaw' })

  // Sunday 10:00 — Weekly report to Bartek
  cron.schedule('0 10 * * 0', async () => {
    log('INFO', 'Scheduler: weekly report')
    const summary = getGlucoseWeeklySummary()
    if (summary.count === 0) {
      await send(bartekChatId, '📊 Raport tygodniowy: brak pomiarów glukozy w tym tygodniu.', false)
      return
    }
    const text = `📊 Raport tygodniowy mamy:\n` +
      `• Pomiary: ${summary.count}\n` +
      `• Średnia: ${Math.round(summary.avg)} mg/dL\n` +
      `• Min: ${summary.min} mg/dL\n` +
      `• Max: ${summary.max} mg/dL`
    await send(bartekChatId, text, false)
  }, { timezone: 'Europe/Warsaw' })

  log('INFO', 'All reminders scheduled (Europe/Warsaw timezone)')
}
