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
      source TEXT DEFAULT 'manual',
      note TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT,
      assessment TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS medication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_of_day TEXT,
      confirmed INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Migrations — safe to run repeatedly, ignore if column already exists
  const migrations = [
    `ALTER TABLE medication_log ADD COLUMN medication TEXT`,
    `ALTER TABLE medication_log ADD COLUMN dose TEXT`,
    `ALTER TABLE meal_log ADD COLUMN photo_path TEXT`,
    `ALTER TABLE meal_log ADD COLUMN glycemic_assessment TEXT`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }
}

export function logGlucose(value: number, note?: string): void {
  db.prepare('INSERT INTO glucose_log (value, note) VALUES (?, ?)').run(value, note ?? null)
}

export function logMeal(description: string, assessment?: string, photoPath?: string, glycemicAssessment?: string): void {
  db.prepare(
    'INSERT INTO meal_log (description, assessment, photo_path, glycemic_assessment) VALUES (?, ?, ?, ?)'
  ).run(description, assessment ?? null, photoPath ?? null, glycemicAssessment ?? null)
}

export function logMedication(medication: string, dose?: string): void {
  // time_of_day kept for backward compat (NOT NULL in existing schema)
  db.prepare('INSERT INTO medication_log (time_of_day, medication, dose) VALUES (?, ?, ?)').run('', medication, dose ?? null)
}

// ── Weekly report queries ──────────────────────────────────────────────────────

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

export function getMedicationWeeklyCounts(): Array<{ medication: string; count: number }> {
  return db.prepare(`
    SELECT medication, COUNT(*) as count
    FROM medication_log
    WHERE medication IS NOT NULL AND recorded_at >= datetime('now', '-7 days')
    GROUP BY medication
    ORDER BY medication
  `).all() as Array<{ medication: string; count: number }>
}

export function getMealWeeklySummary(): Array<{ description: string; glycemic_assessment: string | null; recorded_at: string }> {
  return db.prepare(`
    SELECT description, glycemic_assessment, recorded_at
    FROM meal_log
    WHERE recorded_at >= datetime('now', '-7 days')
    ORDER BY recorded_at DESC
    LIMIT 20
  `).all() as Array<{ description: string; glycemic_assessment: string | null; recorded_at: string }>
}

export function getHighGlucoseWithContext(): Array<{ value: number; recorded_at: string }> {
  return db.prepare(`
    SELECT value, recorded_at FROM glucose_log
    WHERE value > 180 AND recorded_at >= datetime('now', '-7 days')
    ORDER BY value DESC LIMIT 5
  `).all() as Array<{ value: number; recorded_at: string }>
}
