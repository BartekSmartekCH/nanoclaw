import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'mama.db')

let db: DatabaseSync

export function initDb(): void {
  db = new DatabaseSync(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS glucose_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value INTEGER NOT NULL,
      note TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      assessment TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS medication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_of_day TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

export function logGlucose(value: number, note?: string): void {
  db.prepare('INSERT INTO glucose_log (value, note) VALUES (?, ?)').run(value, note ?? null)
}

export function logMeal(description: string, assessment?: string): void {
  db.prepare('INSERT INTO meal_log (description, assessment) VALUES (?, ?)').run(description, assessment ?? null)
}

export function logMedication(timeOfDay: string): void {
  db.prepare('INSERT INTO medication_log (time_of_day) VALUES (?)').run(timeOfDay)
}

export function getGlucoseWeeklySummary(): { avg: number; min: number; max: number; count: number } {
  const row = db.prepare(`
    SELECT AVG(value) as avg, MIN(value) as min, MAX(value) as max, COUNT(*) as count
    FROM glucose_log WHERE recorded_at >= datetime('now', '-7 days')
  `).get() as { avg: number; min: number; max: number; count: number }
  return row
}

export function getRecentGlucose(limit = 5): Array<{ value: number; recorded_at: string }> {
  return db.prepare(
    'SELECT value, recorded_at FROM glucose_log ORDER BY recorded_at DESC LIMIT ?'
  ).all(limit) as Array<{ value: number; recorded_at: string }>
}
