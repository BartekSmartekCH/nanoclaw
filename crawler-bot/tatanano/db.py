"""
ScrapeNano — Database Layer
SQLite-based storage for jobs, pages scraped, and extracted leads.
"""
import sqlite3
import json
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager
from typing import Optional
from . import config

# ── Schema ────────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,          -- job description / extraction prompt context
    created_at  TEXT NOT NULL,
    status      TEXT DEFAULT 'active'   -- active | archived
);

CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER NOT NULL REFERENCES jobs(id),
    url         TEXT NOT NULL,
    scraped_at  TEXT NOT NULL,
    markdown    TEXT,                   -- raw Firecrawl output
    status      TEXT DEFAULT 'scraped', -- scraped | extracted | failed
    error       TEXT
);

CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          INTEGER NOT NULL REFERENCES jobs(id),
    page_id         INTEGER REFERENCES pages(id),
    extracted_at    TEXT NOT NULL,
    data            TEXT NOT NULL,      -- JSON blob (flexible schema)
    -- common flattened fields for quick querying:
    name            TEXT,
    email           TEXT,
    phone           TEXT,
    company         TEXT,
    title           TEXT,
    location        TEXT,
    source_url      TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_job    ON leads(job_id);
CREATE INDEX IF NOT EXISTS idx_leads_email  ON leads(email);
CREATE INDEX IF NOT EXISTS idx_pages_job    ON pages(job_id);
CREATE INDEX IF NOT EXISTS idx_pages_url    ON pages(url);
"""

# ── Connection ─────────────────────────────────────────────────────────────────
@contextmanager
def get_conn():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)

# ── Jobs ──────────────────────────────────────────────────────────────────────
def create_job(name: str, description: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO jobs (name, description, created_at) VALUES (?,?,?)",
            (name, description, _now())
        )
        return cur.lastrowid

def get_job(job_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None

def list_jobs() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

def get_active_job() -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE status='active' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

def archive_job(job_id: int):
    with get_conn() as conn:
        conn.execute("UPDATE jobs SET status='archived' WHERE id=?", (job_id,))

# ── Pages ─────────────────────────────────────────────────────────────────────
def add_page(job_id: int, url: str, markdown: str = None, status: str = "scraped", error: str = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO pages (job_id, url, scraped_at, markdown, status, error) VALUES (?,?,?,?,?,?)",
            (job_id, url, _now(), markdown, status, error)
        )
        return cur.lastrowid

def update_page_status(page_id: int, status: str, error: str = None):
    with get_conn() as conn:
        conn.execute("UPDATE pages SET status=?, error=? WHERE id=?", (status, error, page_id))

def get_pages(job_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM pages WHERE job_id=?", (job_id,)).fetchall()
        return [dict(r) for r in rows]

def url_already_scraped(job_id: int, url: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM pages WHERE job_id=? AND url=? AND status != 'failed'",
            (job_id, url)
        ).fetchone()
        return row is not None

# ── Leads ─────────────────────────────────────────────────────────────────────
def add_lead(job_id: int, page_id: int, data: dict) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO leads
               (job_id, page_id, extracted_at, data, name, email, phone, company, title, location, source_url)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                job_id, page_id, _now(),
                json.dumps(data),
                data.get("name"), data.get("email"), data.get("phone"),
                data.get("company"), data.get("title"), data.get("location"),
                data.get("source_url")
            )
        )
        return cur.lastrowid

def get_leads(job_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM leads WHERE job_id=? ORDER BY extracted_at DESC",
            (job_id,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["data"] = json.loads(d["data"])
            result.append(d)
        return result

def count_leads(job_id: int) -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) FROM leads WHERE job_id=?", (job_id,)).fetchone()
        return row[0]

def count_pages(job_id: int) -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) FROM pages WHERE job_id=?", (job_id,)).fetchone()
        return row[0]

# ── Helpers ───────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.utcnow().isoformat()
