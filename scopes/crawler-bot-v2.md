# Crawler Bot v2 — Scope

**Project:** TataNano Scraper upgrade
**Date:** 2026-03-29
**Status:** Scoped — awaiting go-ahead to build

---

## What We're Building

An upgrade to the existing TataNano Scraper Telegram bot. The bot already works — this version makes it smarter, more flexible, and safe to use on any type of website.

The two main use cases it needs to handle:

1. **Contact harvesting** — names, emails, phones, addresses, job titles, websites
2. **Competitive intelligence** — products, prices, descriptions, specs, availability

You control everything via plain Telegram messages or commands.

---

## Two Scraping Engines

You choose the engine when you create a job. Within each engine, the bot automatically tries the simplest approach first and escalates only if needed — two steps, clear failure messages.

### Engine A — Firecrawl (Cloud)
Pages are fetched by Firecrawl's external service. Handles JavaScript-heavy sites, bot protection, dynamic content. Costs API credits per page. Fast and reliable.

**Use when:** you want maximum reliability and don't mind the cost.

### Engine B — Playwright + Brave (Local)
Brave is a free, open-source browser (Chromium-based). Playwright controls it silently on your Mac mini. Same capability as Firecrawl — full JavaScript rendering, handles bot-protected sites — but with extra advantages:

- Built-in ad and tracker blocking → cleaner page content for extraction
- Fingerprint randomisation → harder for sites to detect as a bot
- No API cost → free to run regardless of volume
- Data never leaves your Mac

Brave is used specifically for Phase 2 enrichment scraping where individual websites may be JS-heavy or bot-protected. Phase 1 (catalog scrape) uses a lightweight fetch — no browser needed.

**Use when:** high volume scraping, privacy matters, or you want zero API cost.

---

## Escalation Logic (within each engine)

The bot does not cascade between engines — you choose the engine. But within the chosen engine it tries the simplest approach first, then escalates automatically if the page comes back empty or broken. Two steps only — no complex chains.

### Engine A escalation (Firecrawl)

```
Step 1 — Simple fetch (httpx)
  Free, instant, no API cost
  Works for plain HTML sites like motywdesign.pl
        ↓ if page empty or no data found
Step 2 — Firecrawl
  Full JS rendering, bot protection handled
  Uses API credits
        ↓ if still fails
  Report as failed — you decide next action
```

### Engine B escalation (Playwright + Brave)

```
Step 1 — Simple fetch (httpx)
  Free, instant
  Works for plain HTML sites
        ↓ if page empty or no data found
Step 2 — Playwright + Brave
  Real browser, full JS, fingerprint protection
  Zero cost
        ↓ if still fails
  Report as failed — you decide next action
```

### Why two steps only

More steps = more things that can silently fail and produce bad data. Two steps is enough:
- Most sites (like motywdesign.pl) are plain HTML → Step 1 handles them free and fast
- Complex or protected sites → Step 2 handles them
- If Step 2 fails, you get a clear error — not a silent bad result

---

## Two-Phase Pipeline

### Phase 1 — Catalog Scrape

You give one starting URL — a directory, catalog, or listing page.

The bot scrapes every record on that page and extracts whatever contact data is immediately visible. Every record is saved, even if incomplete. If a record has a website URL but no email, it's kept and flagged for Phase 2.

**Output:** database of all records with a status flag per record.

### Phase 2 — Enrichment Scrape

Takes all partial records from Phase 1 that have a website URL.

Visits each website and searches for the missing fields — email, phone, full address, contact page. Updates the record when found.

You trigger Phase 2 manually:
> *"Start enrichment"* / *"Fill in the missing emails"* / *"Enrich partial records"*

Phase 2 can be run multiple times — first pass finds the homepage, second pass digs into the contact page.

---

## Record Status Tracking

Every record has a status column from the moment it's captured.

| Status | Meaning |
|--------|---------|
| `complete` | All requested fields found |
| `partial` | Some fields missing — has a website URL to enrich |
| `stub` | Very little data — no website to follow up |
| `enriched` | Phase 2 ran — fields updated |
| `enrichment_failed` | Phase 2 ran but found nothing new |

The website URL column is also tracked:

| URL Status | Meaning |
|-----------|---------|
| `not_checked` | Website found, Phase 2 hasn't run yet |
| `checked` | Phase 2 visited this URL |
| `no_url` | No website found on the record |

---

## Full Pipeline Flow

```
You (Telegram message)
        │
        ▼
┌─────────────────────┐
│   Intent Parser     │  Ollama reads your message — routes to
│   (local Ollama)    │  correct action: new job, scrape, enrich, export
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    Job Manager      │  Stores: job name, description, engine choice,
│    (SQLite DB)      │  fields to extract, all records + status
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│           Phase 1: Catalog Scrape        │
│                                          │
│  Starting URL → scrape all records       │
│  Extract visible fields                  │
│  Save all records with status flag       │
│  Store website URLs for Phase 2          │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Scraping Engine (your choice per job)   │
│                                          │
│  A: Firecrawl                            │
│     Step 1: httpx (free, instant)        │
│     Step 2: Firecrawl (if Step 1 empty)  │
│                                          │
│  B: Playwright + Brave                   │
│     Step 1: httpx (free, instant)        │
│     Step 2: Brave (if Step 1 empty)      │
│                                          │
│  Both steps automatic — you only pick    │
│  the engine, not the step               │
└──────────┬───────────────────────────────┘
           │  clean page text
           ▼
┌──────────────────────────────────────────┐
│         Content Sanitiser               │
│                                          │
│  Strip HTML, scripts, hidden text        │
│  Fix broken unicode (ftfy)               │
│  Truncate to safe size                   │
│  Wrap in injection-hardened prompt       │
└──────────┬───────────────────────────────┘
           │  clean text + hardened prompt
           ▼
┌──────────────────────────────────────────┐
│      Extraction Layer (Ollama)           │
│                                          │
│  Input:  page text + your job desc       │
│          + fields you defined            │
│  Output: structured data (your fields)   │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│        Output Validator (Pydantic)       │
│                                          │
│  Emails look like emails                 │
│  Phones look like phones                 │
│  Flag suspicious extractions             │
└──────────┬───────────────────────────────┘
           │
           ▼
┌─────────────────────┐
│  SQLite Database    │  Records + status flags + website URLs
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│        Phase 2: Enrichment               │
│        (you trigger manually)            │
│                                          │
│  Take all partial records with URL       │
│  Visit each website                      │
│  Search for missing fields               │
│  Update records in DB                    │
│  Update status → enriched / failed       │
└──────────┬───────────────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Excel Export      │  Columns match exactly what you asked for
│   (openpyxl)        │  Includes: Record Status + Website Checked
└──────────┬──────────┘
           │
           ▼
     Excel file sent to you in Telegram
```

---

## Flexible Extraction

You describe what you want in plain language when creating a job. The AI reads your description and extracts exactly those fields.

**Example — contacts:**
> *"Find the clinic name, director's full name, email address, phone, and city"*
→ Excel columns: Clinic Name | Director | Email | Phone | City

**Example — competitors:**
> *"Extract product name, price, material, dimensions, and availability"*
→ Excel columns: Product Name | Price | Material | Dimensions | Availability

If a field isn't on the page, the cell is left empty. No errors.

---

## One Row Per Person

When a page lists multiple people (e.g. motywdesign.pl has Józef Bis and Paweł Deroń), the bot creates **one row per person** — not one row per page.

Shared fields (company name, email, website) are duplicated across all rows from the same page.

**Example — motywdesign.pl:**

| Company | Person Name | Phone | Email | Website | Record Status |
|---------|------------|-------|-------|---------|--------------|
| Motyw Design | Józef Bis | +48 781 562 256 | motywdesign@gmail.com | motywdesign.pl | complete |
| Motyw Design | Paweł Deroń | +48 792 337 013 | motywdesign@gmail.com | motywdesign.pl | complete |

This means:
- A page with 1 person → 1 row
- A page with 3 people → 3 rows
- A catalog page listing 50 companies → potentially 100+ rows if each company has 2 contacts

Ollama is instructed to find **every person mentioned** on the page and create a separate record for each, inheriting shared fields like company name and email.

---

## Security & Safety

No external paid tools. Pure Python.

| Layer | Tool | What It Does |
|-------|------|-------------|
| URL validation | `ipaddress` + `validators` | Blocks internal IPs, localhost, malformed URLs |
| URL safety | VirusTotal API (already in NanoClaw) | Checks URL before scraping |
| HTML stripping | `bleach` + `beautifulsoup4` | Removes scripts, hidden text, styling |
| Unicode fix | `ftfy` | Fixes garbled characters from scraped pages |
| Prompt injection guard | Hardened prompt wrapper | Isolates page content from instructions |
| Output validation | `pydantic` | Enforces correct field formats |
| Field validation | `email-validator` + `phonenumbers` | Verifies emails and phone numbers |
| Browser isolation | Playwright settings | Blocks outbound JS requests in browser |

---

## Example Session

```
You:     New job: Swiss physiotherapists.
         Extract: clinic name, lead therapist name, email, phone, city.

Bot:     ✅ Job created: Swiss physiotherapists
         Engine? A (Firecrawl) or B (Local Brave)?

You:     B

Bot:     ✅ Engine: Local Brave
         Send me the starting URL.

You:     https://physio-verzeichnis.ch/schweiz

Bot:     ⚙️ Phase 1: Scraping catalog...
         47 records found
         ✅ 18 complete  ⚠️ 24 partial  ❌ 5 stubs

         Say "enrich" to fill in missing fields from partial records.
         Or say "export" to get what we have now.

You:     Enrich

Bot:     ⚙️ Phase 2: Visiting 24 websites...
         8/24 done — 6 emails found
         24/24 done — 19 emails found

         ✅ 37 complete  ⚠️ 5 partial  ❌ 5 stubs

You:     Export

Bot:     [sends Excel file]
         physio-schweiz-2026-03-29.xlsx
         47 records · 37 complete · 5 partial · 5 stubs
```

---

## What Gets Built

| # | What | Why |
|---|------|-----|
| 1 | Playwright + Brave engine | Local alternative to Firecrawl |
| 2 | Engine selector per job | Stored in DB, chosen at job creation |
| 3 | Two-phase pipeline | Phase 1 catalog + Phase 2 enrichment |
| 4 | Record status tracking | Complete / partial / stub / enriched |
| 5 | Website URL status column | Checked / not checked / no URL |
| 6 | Flexible field extraction | Driven by job description, not hardcoded |
| 7 | Dynamic Excel columns | Match exactly what you asked for |
| 8 | Sanitization layer | Strip HTML, fix unicode, guard injection |
| 9 | Output validation | Pydantic + email + phone validators |
| 10 | Guided job creation flow | Engine → URL → go |

---

---

## Excel Output — Example Headers

The first columns are always fixed system columns. The remaining columns are dynamic — generated from your job description.

### Fixed Columns (always present)

| Column | Example Value | What It Means |
|--------|--------------|---------------|
| `Record ID` | 42 | Internal record number |
| `Source URL` | https://physio-verzeichnis.ch/bern | Page where this record was found |
| `Record Status` | complete / partial / stub / enriched / enrichment_failed | How complete the record is |
| `Website URL` | https://praxis-mueller.ch | Website found on the record for Phase 2 |
| `Website Checked` | yes / no / n/a | Whether Phase 2 visited the website |
| `Date Scraped` | 2026-03-29 | When Phase 1 captured this record |
| `Date Enriched` | 2026-03-29 | When Phase 2 last updated this record |
| `Job Name` | Swiss physiotherapists | Which job this record belongs to |

### Dynamic Columns — Contact Job Example

> Job description: *"Find clinic name, lead therapist name, email, phone, city"*

| Clinic Name | Lead Therapist | Email | Phone | City |
|-------------|---------------|-------|-------|------|
| Physio Bern AG | Dr. Anna Müller | a.mueller@physiobern.ch | +41 31 123 45 67 | Bern |
| Praxis Zurich | Thomas Weber | — | +41 44 987 65 43 | Zurich |
| Sport Physio Basel | — | info@sportphysio.ch | — | Basel |

### Dynamic Columns — Competitor Products Example

> Job description: *"Extract product name, price, material, dimensions, availability"*

| Product Name | Price | Material | Dimensions | Availability |
|-------------|-------|----------|------------|-------------|
| Standing Desk Pro | CHF 890 | Oak / Steel | 140x70cm | In stock |
| Ergonomic Chair X | CHF 450 | Mesh | Adjustable | 2-3 weeks |
| Monitor Arm V2 | — | Aluminium | — | In stock |

### Notes on Dynamic Columns
- Column names come directly from your job description — you define them
- Empty cell (`—`) means the field was not found on that page
- All records appear in the export regardless of completeness
- `Record Status` column lets you filter in Excel: show only `complete`, or only `partial`, etc.

---

*Status: Scoped — awaiting go-ahead to build*
