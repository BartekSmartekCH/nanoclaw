import cron from 'node-cron'
import { log } from './logger.js'
import {
  getGlucoseWeeklySummary,
  getHighGlucoseWithContext,
  getMealWeeklySummary,
  getMedicationWeeklyCounts,
} from './db.js'
import { generateWeeklyReport } from './claude.js'

export type SendFn = (chatId: number, text: string, voiceAlso?: boolean) => Promise<void>

// ── Medication confirmation state ─────────────────────────────────────────────

interface MedSession {
  timeOfDay: 'morning' | 'evening'
  reminderTimer: ReturnType<typeof setTimeout> | null
  alertTimer: ReturnType<typeof setTimeout>
}

let activeMedSession: MedSession | null = null

/**
 * Called from index.ts when medication confirmation is detected.
 * Clears pending timers so Bartek doesn't get a false alert.
 */
export function onMedicationConfirmed(): void {
  if (!activeMedSession) return
  if (activeMedSession.reminderTimer) clearTimeout(activeMedSession.reminderTimer)
  clearTimeout(activeMedSession.alertTimer)
  activeMedSession = null
  log('INFO', 'Medication confirmed — cleared pending alert timers')
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startScheduler(
  groupChatId: number,
  bartekChatId: number,
  send: SendFn,
): void {
  log('INFO', 'Scheduler started')

  const sendMedicationReminder = async (timeOfDay: 'morning' | 'evening') => {
    const isMorning = timeOfDay === 'morning'
    const medsText = isMorning
      ? 'berberynę, omega 3 i sitagliptynę 💊'
      : 'berberynę 💊'
    const greeting = isMorning ? 'Dzień dobry Mamo!' : 'Dobry wieczór Mamo!'
    const msg = `${greeting} Czas na ${medsText}\nNapisz "tak" gdy weźmiesz.`

    await send(groupChatId, msg, true)
    log('INFO', `Medication reminder sent (${timeOfDay})`)

    // Clear any previous session first
    if (activeMedSession) {
      if (activeMedSession.reminderTimer) clearTimeout(activeMedSession.reminderTimer)
      clearTimeout(activeMedSession.alertTimer)
    }

    // 15-min re-reminder
    const reminderTimer = setTimeout(async () => {
      if (!activeMedSession) return
      log('INFO', `15-min re-reminder (${timeOfDay})`)
      await send(groupChatId, msg, false)
    }, 15 * 60 * 1000)

    // 2-hour Bartek alert
    const alertTimer = setTimeout(async () => {
      if (!activeMedSession) return
      const alertText = isMorning
        ? 'Mama nie potwierdziła porannych leków (berberyna, omega 3, sitagliptyna).'
        : 'Mama nie potwierdziła wieczornej berberyny.'
      log('WARN', `2h medication alert to Bartek (${timeOfDay})`)
      await send(bartekChatId, alertText, false)
      activeMedSession = null
    }, 2 * 60 * 60 * 1000)

    activeMedSession = { timeOfDay, reminderTimer, alertTimer }
  }

  // 07:30 — Good morning
  cron.schedule('30 7 * * *', async () => {
    log('INFO', 'Scheduler: morning greeting')
    await send(groupChatId, 'Dzień dobry! 🌞 Jak się czujesz dziś rano? Czy dobrze spałaś?', true)
  }, { timezone: 'Europe/Warsaw' })

  // 08:00 — Morning medication (Berberyna + Omega 3 + Sitagliptyna)
  cron.schedule('0 8 * * *', async () => {
    log('INFO', 'Scheduler: morning medication')
    await sendMedicationReminder('morning')
  }, { timezone: 'Europe/Warsaw' })

  // 13:00 — Lunch prompt
  cron.schedule('0 13 * * *', async () => {
    log('INFO', 'Scheduler: lunch')
    await send(groupChatId, 'Dobry obiad! 🍽️ Co dziś jadłaś? Możesz mi przysłać zdjęcie talerza albo napisać co jadłaś.', true)
  }, { timezone: 'Europe/Warsaw' })

  // 20:00 — Evening medication (Berberyna only)
  cron.schedule('0 20 * * *', async () => {
    log('INFO', 'Scheduler: evening medication')
    await sendMedicationReminder('evening')
  }, { timezone: 'Europe/Warsaw' })

  // 21:30 — Evening glucose + goodnight
  cron.schedule('30 21 * * *', async () => {
    log('INFO', 'Scheduler: evening glucose')
    await send(groupChatId, 'Dobranoc! 🌙 Jak był dzień? Zmierzyłaś cukier wieczorny? Jeśli tak — napisz mi wynik.', true)
  }, { timezone: 'Europe/Warsaw' })

  // Sunday 18:00 — Weekly report to Bartek only
  cron.schedule('0 18 * * 0', async () => {
    log('INFO', 'Scheduler: weekly report')
    try {
      const glucose = getGlucoseWeeklySummary()
      if (glucose.count === 0) {
        await send(bartekChatId, 'Raport tygodniowy: brak pomiarów glukozy w tym tygodniu.', false)
        return
      }
      const reportData = {
        glucose,
        highReadings: getHighGlucoseWithContext(),
        medicationCounts: getMedicationWeeklyCounts(),
        meals: getMealWeeklySummary(),
      }
      const report = await generateWeeklyReport(reportData)
      await send(bartekChatId, report, false)
      log('INFO', 'Weekly report sent to Bartek')
    } catch (err) {
      log('ERROR', 'Weekly report failed', { err: String(err) })
      await send(bartekChatId, 'Nie mogłem wygenerować raportu tygodniowego. Sprawdź logi.', false)
    }
  }, { timezone: 'Europe/Warsaw' })

  log('INFO', 'All reminders scheduled (Europe/Warsaw timezone)')
}
