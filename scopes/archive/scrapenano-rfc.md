# RFC: ScrapeNano — Contact Data Mining Bot

**Date:** 2026-03-22
**Status:** Draft — pending expert review (marketing + scraping)

---

## Problem

Bartek needs to collect contact data (name, phone, email, address, website) from business directories and individual company websites at scale. Manual collection is too slow. A two-stage automated pipeline is needed.

## Proposed Solution

A standalone Telegram bot (`ScrapeNano`) running natively on the Mac mini. Controlled via Telegram commands. Uses a local LLM (Ollama) for structured contact extraction. Stores results in SQLite. Exports to CSV.

---

## Two-Stage Workflow

### Stage 1 — Directory Scrape

Bartek sends: `scrape https://directory-url.com`

1. Scout crawls the directory page(s)
2. Finds all business profile links (e.g. 400 architect profiles)
3. Extractor visits each profile, extracts contact data using local LLM
4. Results stored in database with `status: pending_deep_scrape`

### Stage 2 — Deep Scrape (website visit)

Bartek sends: `deepen`

1. For each record in the database with a website URL
2. Scout visits that company's own website
3. Extractor looks for: contact page, footer, mailto links, structured data
4. Fills in missing fields (especially email)
5. Updates database record, marks `status: done`

---

## Telegram Commands

| Command | Action |
|---|---|
| `scrape <url>` | Stage 1 — scrape directory at URL |
| `deepen` | Stage 2 — visit all websites in database |
| `status` | Show counts: done / pending / failed |
| `export` | Send CSV file of all contacts |
| `search <query>` | Search contacts by name, city, etc. |
| `clear` | Reset database (with confirmation) |

---

## Architecture

```
Bartek → Telegram → ScrapeNano bot (Mac mini)
                          ↓
                    Scout (Playwright)
                    — crawls URLs
                    — follows links
                    — downloads HTML
                          ↓
                    Extractor (Ollama local LLM)
                    — strips HTML to visible text
                    — outputs JSON only
                    — validated against schema
                          ↓
                    Cleaner
                    — validates email regex
                    — normalises phone format
                    — deduplicates records
                          ↓
                    SQLite database
                    — FTS5 full-text search
                    — export to CSV
```

---

## Database Schema

```sql
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  website TEXT,
  source_url TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  website_scraped_at TEXT,
  status TEXT DEFAULT 'pending' -- pending / done / failed
);

CREATE VIRTUAL TABLE contacts_fts USING fts5(
  name, phone, email, address, website, content='contacts'
);
```

---

## Data Sources

| Source | Data available | Method |
|---|---|---|
| Business directory pages | Name, phone, address, website | Playwright + Ollama |
| Google Places API | Name, phone, address, website (no email) | Official API ($100/mo or free tier 10k) |
| Company own website | Email, contact details | Playwright + Ollama |
| Brave Search API | Website discovery, directory URLs | REST API (Bartek has API key + credits) |

**Brave Search use cases:**
- Search for business directories: `"architects directory" site:ch` → seed URLs for Stage 1
- Find company website when only name + city known: `"Müller Architekten" Zürich` → website URL
- Discover additional directories not manually provided

---

## Prompt Injection Protection

This is a critical concern — scraped HTML may contain hidden instructions targeting the LLM.

Mitigations:
- **Structured output only** — LLM returns JSON schema `{name, phone, email, address, website}`, never free text
- **HTML stripped before LLM** — only visible text passed, script/style tags removed
- **System prompt hardcoded** — never influenced by scraped content
- **Output validation** — email regex, phone regex, URL format check before storing; invalid → rejected
- **Size limit** — max 8,000 chars per page passed to LLM, hard truncation
- **Sandboxed model** — local Ollama, no internet access, no tools, no code execution

---

## Local LLM

- **Runtime:** Ollama (already installed)
- **Model:** Llama 3 8B (fast, sufficient for structured extraction)
- **Prompt pattern:**

```
System: You are a contact data extractor.
Extract contact information from the text below.
Return ONLY valid JSON matching this schema:
{"name": "", "phone": "", "email": "", "address": "", "website": ""}
Use null for missing fields. Output nothing else.

User: [stripped page text, max 8000 chars]
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Crawler | Playwright (handles dynamic JS pages) |
| LLM | Ollama (local, private) |
| Database | SQLite + better-sqlite3 |
| Bot framework | grammy (same as NanoClaw) |
| Runtime | Node.js / TypeScript |
| Deployment | launchd plist: com.scrapenano |

---

## Stage 2 Safety Pre-Check

Before visiting any company website in Stage 2, run these checks in order:

| Check | Method | Fail action |
|---|---|---|
| Domain reputation | Google Safe Browsing API (free) | Skip, mark `unsafe` |
| robots.txt | Parse and check `/crawl-delay`, disallow rules | Skip if disallowed |
| HTTPS required | Reject `http://` URLs | Skip, mark `insecure` |
| Domain mismatch | Website URL redirects to different domain | Flag for review, skip auto |
| Response timeout | No response within 10 seconds | Mark `timeout`, move on |
| Content type | Response must be `text/html` | Skip PDFs, apps, etc. |

Records marked `unsafe`, `insecure`, or `timeout` are kept in the database but excluded from export by default. Bartek can review and override manually.

Google Safe Browsing API key stored in Keychain: `scrapenano-safebrowsing-api`

---

## Rate Limiting & Politeness

- Minimum 2 second delay between requests to same domain
- Respect robots.txt
- Max 5 concurrent requests
- User-agent identifies bot honestly
- Timeout: 30 seconds per page

---

## Legal Considerations

- Google Places: official API only (scraping Maps violates ToS)
- Website scraping: legal for publicly available data when robots.txt is respected
- Contact data storage: for personal/business use only, not for resale
- GDPR: data collected is business contact data (not personal private data)

---

## Files to Create

```
scrapenano/
├── src/
│   ├── index.ts          — Telegram bot, command routing
│   ├── crawler.ts        — Playwright crawler, robots.txt check
│   ├── extractor.ts      — Ollama LLM extraction, prompt injection defence
│   ├── cleaner.ts        — validation, normalisation, deduplication
│   ├── db.ts             — SQLite contacts table + FTS5
│   ├── exporter.ts       — CSV export
│   └── logger.ts         — structured logging
├── launchd/
│   └── com.scrapenano.plist
├── package.json
├── tsconfig.json
└── install-scrapenano.sh
```

---

## Alternatives Considered

1. **Python + Scrapy** — rejected: Node.js keeps stack consistent
2. **Cloud LLM for extraction** — rejected: contact data privacy, cost
3. **Browser extension** — rejected: not automatable at scale
4. **Apify / ScrapeHero SaaS** — rejected: data leaves Mac mini, recurring cost

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prompt injection | Medium | High | Structured output + validation |
| IP ban from aggressive crawling | Medium | Medium | Rate limiting + delay |
| Dynamic pages not scraped | Medium | Medium | Playwright handles JS |
| Low email hit rate | High | Medium | Email often not publicly listed |
| Ollama extraction errors | Medium | Low | Fallback to regex for email |

---

## Scope Estimate

**Medium-Large — 3-5 days**

---

## Open Questions for Expert Review

**For marketing expert:**
1. What directories are the target sources? (regional, sector-specific?)
2. What export format is needed — CSV, Excel, CRM import?
3. What fields matter most — is email truly essential or is phone sufficient?
4. What volume is expected — hundreds or tens of thousands of contacts?

**For scraping expert:**
1. Are target directories JavaScript-heavy or static HTML?
2. Are there known anti-scraping measures on target sites?
3. Is Playwright sufficient or do we need rotating proxies?
4. What's the right crawl depth for the deep scrape stage?

---

## Status

Draft RFC complete. Pending review by marketing and scraping experts before implementation.
