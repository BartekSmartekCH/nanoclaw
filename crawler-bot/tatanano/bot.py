"""
TataNano Scraper — Telegram Bot
Job-agnostic lead scraper. Commands:
  /newjob <name> | <description>   — create a new scraping job
  /job                             — show current active job
  /jobs                            — list all jobs
  /scrape <url>                    — scrape single page + extract
  /crawl <url> [max_pages]         — crawl entire site + extract
  /results [N]                     — show last N leads (default 10)
  /export                          — export current job to Excel
  /status                          — bot + Ollama health check
  /help                            — show this help
"""
import asyncio
import logging
import os
from pathlib import Path
from telegram import Update, Document
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    ContextTypes, filters
)
from telegram.constants import ParseMode

from . import config, db
from .scraper import scrape_page, crawl_site
from .exporter import export_job
from .nl import parse_intent, _auto_job_name

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO
)
log = logging.getLogger("tatanano")


# ── Auth guard ────────────────────────────────────────────────────────────────
def _authorized(update: Update) -> bool:
    if not config.ALLOWED_CHAT_IDS:
        return True  # open mode if no restriction set
    return update.effective_chat.id in config.ALLOWED_CHAT_IDS


async def _deny(update: Update):
    await update.message.reply_text("⛔ Unauthorized.")


# ── /start & /help ────────────────────────────────────────────────────────────
async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)
    await update.message.reply_text(
        "🕷 *TataNano Scraper* — Local Lead Extractor\n\n"
        "*Jobs:*\n"
        "`/newjob Name | Description` — create job\n"
        "`/job` — show current job\n"
        "`/jobs` — list all jobs\n"
        "`/usejob <id>` — switch to job by ID\n\n"
        "*Scraping:*\n"
        "`/scrape <url>` — scrape one page\n"
        "`/crawl <url> [max]` — crawl full site (default 50 pages)\n\n"
        "*Results:*\n"
        "`/results [N]` — show last N leads\n"
        "`/export` — export to Excel and send file\n\n"
        "*System:*\n"
        "`/status` — check DB + Firecrawl status\n"
        "`/help` — this message",
        parse_mode=ParseMode.MARKDOWN
    )


# ── /status ───────────────────────────────────────────────────────────────────
async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    job = db.get_active_job()
    job_text = f"📋 Active job: *{job['name']}* (ID {job['id']})" if job else "📋 No active job"

    leads_count = db.count_leads(job["id"]) if job else 0
    pages_count = db.count_pages(job["id"]) if job else 0

    await update.message.reply_text(
        f"*TataNano Scraper Status*\n\n"
        f"🔑 Firecrawl: {'✅ key set' if config.FIRECRAWL_API_KEY else '❌ missing'}\n"
        f"🗄 DB: `{config.DB_PATH}`\n\n"
        f"{job_text}\n"
        f"{'📄 Pages scraped: ' + str(pages_count) if job else ''}\n"
        f"{'👤 Leads found: ' + str(leads_count) if job else ''}",
        parse_mode=ParseMode.MARKDOWN
    )


# ── /newjob ───────────────────────────────────────────────────────────────────
async def cmd_newjob(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    text = " ".join(ctx.args).strip()
    if "|" not in text:
        await update.message.reply_text(
            "Usage: `/newjob Name | Description of what to extract`\n\n"
            "Example:\n`/newjob Swiss CTOs | Find CTO contact details, email and LinkedIn`",
            parse_mode=ParseMode.MARKDOWN
        )
        return

    parts = text.split("|", 1)
    name = parts[0].strip()
    description = parts[1].strip()

    if not name or not description:
        await update.message.reply_text("Both name and description are required.")
        return

    job_id = db.create_job(name, description)
    await update.message.reply_text(
        f"✅ Job created!\n\n"
        f"*ID:* {job_id}\n"
        f"*Name:* {name}\n"
        f"*Target:* {description}\n\n"
        f"Now use `/scrape <url>` or `/crawl <url>` to start collecting.",
        parse_mode=ParseMode.MARKDOWN
    )


# ── /job ──────────────────────────────────────────────────────────────────────
async def cmd_job(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    job = db.get_active_job()
    if not job:
        await update.message.reply_text("No active job. Use `/newjob` to create one.", parse_mode=ParseMode.MARKDOWN)
        return

    leads = db.count_leads(job["id"])
    pages = db.count_pages(job["id"])
    await update.message.reply_text(
        f"📋 *Current Job*\n\n"
        f"*ID:* {job['id']}\n"
        f"*Name:* {job['name']}\n"
        f"*Target:* {job['description']}\n"
        f"*Pages scraped:* {pages}\n"
        f"*Leads found:* {leads}\n"
        f"*Created:* {job['created_at'][:10]}",
        parse_mode=ParseMode.MARKDOWN
    )


# ── /jobs ─────────────────────────────────────────────────────────────────────
async def cmd_jobs(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    jobs = db.list_jobs()
    if not jobs:
        await update.message.reply_text("No jobs yet. Use `/newjob` to create one.", parse_mode=ParseMode.MARKDOWN)
        return

    lines = ["*All Jobs:*\n"]
    for j in jobs:
        status_icon = "🟢" if j["status"] == "active" else "⚫"
        leads = db.count_leads(j["id"])
        lines.append(f"{status_icon} *{j['id']}* — {j['name']} ({leads} leads)")

    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


# ── /usejob ───────────────────────────────────────────────────────────────────
async def cmd_usejob(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    if not ctx.args:
        await update.message.reply_text("Usage: `/usejob <id>`", parse_mode=ParseMode.MARKDOWN)
        return

    try:
        job_id = int(ctx.args[0])
    except ValueError:
        await update.message.reply_text("Job ID must be a number.")
        return

    # Archive all others, activate this one
    for j in db.list_jobs():
        if j["id"] != job_id:
            db.archive_job(j["id"])

    from . import db as _db
    with _db.get_conn() as conn:
        conn.execute("UPDATE jobs SET status='active' WHERE id=?", (job_id,))

    job = db.get_job(job_id)
    if not job:
        await update.message.reply_text(f"Job {job_id} not found.")
        return

    await update.message.reply_text(f"✅ Switched to job *{job['name']}*", parse_mode=ParseMode.MARKDOWN)


# ── /scrape ───────────────────────────────────────────────────────────────────
async def cmd_scrape(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    if not ctx.args:
        await update.message.reply_text("Usage: `/scrape <url>`", parse_mode=ParseMode.MARKDOWN)
        return

    url = ctx.args[0].strip()
    job = db.get_active_job()
    if not job:
        await update.message.reply_text("No active job. Create one with `/newjob` first.", parse_mode=ParseMode.MARKDOWN)
        return

    if db.url_already_scraped(job["id"], url):
        await update.message.reply_text(f"⚠️ Already scraped: `{url}`\nSkipping duplicate.", parse_mode=ParseMode.MARKDOWN)
        return

    msg = await update.message.reply_text(f"🕷 Scraping + extracting from `{url}`...", parse_mode=ParseMode.MARKDOWN)

    result = scrape_page(url, job_description=job["description"])

    if not result["success"]:
        db.add_page(job["id"], url, status="failed", error=result["error"])
        await msg.edit_text(f"❌ Scrape failed: {result['error']}")
        return

    page_id = db.add_page(job["id"], url, markdown=result["markdown"])
    leads = result["leads"]

    if leads:
        for lead in leads:
            db.add_lead(job["id"], page_id, lead)
        db.update_page_status(page_id, "extracted")
        lead_lines = _format_leads_preview(leads[:5])
        await msg.edit_text(
            f"✅ *{len(leads)} lead(s) found* from `{url}`\n\n{lead_lines}"
            f"{'...' if len(leads) > 5 else ''}\n\n"
            f"Total for job: {db.count_leads(job['id'])} leads",
            parse_mode=ParseMode.MARKDOWN
        )
    else:
        db.update_page_status(page_id, "extracted")
        await msg.edit_text(f"📭 No leads found on `{url}`\n(Page scraped and stored)", parse_mode=ParseMode.MARKDOWN)


# ── /crawl ────────────────────────────────────────────────────────────────────
async def cmd_crawl(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    if not ctx.args:
        await update.message.reply_text("Usage: `/crawl <url> [max_pages]`\nDefault max: 50", parse_mode=ParseMode.MARKDOWN)
        return

    url = ctx.args[0].strip()
    max_pages = int(ctx.args[1]) if len(ctx.args) > 1 else config.CRAWL_MAX_PAGES

    job = db.get_active_job()
    if not job:
        await update.message.reply_text("No active job. Create one with `/newjob` first.", parse_mode=ParseMode.MARKDOWN)
        return

    msg = await update.message.reply_text(
        f"🕸 Crawling + extracting from `{url}`\nMax pages: {max_pages}\n\nThis may take a few minutes...",
        parse_mode=ParseMode.MARKDOWN
    )

    total_leads = 0

    def progress(done, total):
        pass  # polling progress only

    pages = crawl_site(url, max_pages=max_pages, job_description=job["description"],
                       progress_callback=progress)

    for i, page in enumerate(pages):
        if not page["success"]:
            db.add_page(job["id"], page["url"], status="failed", error=page["error"])
            continue

        if db.url_already_scraped(job["id"], page["url"]):
            continue

        page_id = db.add_page(job["id"], page["url"], markdown=page["markdown"])
        leads = page.get("leads", [])

        for lead in leads:
            db.add_lead(job["id"], page_id, lead)
        total_leads += len(leads)
        db.update_page_status(page_id, "extracted")

        if (i + 1) % 10 == 0:
            await msg.edit_text(
                f"⚙️ Processing... {i+1}/{len(pages)} pages\nLeads so far: {total_leads}",
                parse_mode=ParseMode.MARKDOWN
            )

    total_in_job = db.count_leads(job["id"])
    await msg.edit_text(
        f"✅ *Crawl complete!*\n\n"
        f"📄 Pages crawled: {len(pages)}\n"
        f"👤 New leads found: {total_leads}\n"
        f"📊 Total in job: {total_in_job}\n\n"
        f"Use `/export` to download Excel file.",
        parse_mode=ParseMode.MARKDOWN
    )


# ── /results ──────────────────────────────────────────────────────────────────
async def cmd_results(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    n = int(ctx.args[0]) if ctx.args else 10
    job = db.get_active_job()
    if not job:
        await update.message.reply_text("No active job.", parse_mode=ParseMode.MARKDOWN)
        return

    leads = db.get_leads(job["id"])
    if not leads:
        await update.message.reply_text("No leads yet for this job.")
        return

    preview = leads[:n]
    text = f"*Last {len(preview)} leads — {job['name']}*\n\n"
    text += _format_leads_preview(preview)
    text += f"\n_Total: {len(leads)} leads_"

    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)


# ── /export ───────────────────────────────────────────────────────────────────
async def cmd_export(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return await _deny(update)

    job = db.get_active_job()
    if not job:
        await update.message.reply_text("No active job.", parse_mode=ParseMode.MARKDOWN)
        return

    leads_count = db.count_leads(job["id"])
    if leads_count == 0:
        await update.message.reply_text("No leads to export yet.")
        return

    msg = await update.message.reply_text(f"📊 Generating Excel export ({leads_count} leads)...")

    try:
        filepath = export_job(job["id"])
        await msg.delete()
        await update.message.reply_document(
            document=open(filepath, "rb"),
            filename=Path(filepath).name,
            caption=f"📊 *{job['name']}* — {leads_count} leads\nExported by TataNano Scraper",
            parse_mode=ParseMode.MARKDOWN
        )
    except Exception as e:
        await msg.edit_text(f"❌ Export failed: {e}")


# ── Natural language handler ──────────────────────────────────────────────────
async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Catch-all handler for plain text messages — routes via Ollama intent parser."""
    if not _authorized(update): return await _deny(update)

    text = update.message.text.strip()
    msg = await update.message.reply_text("🤔 Thinking...", parse_mode=ParseMode.MARKDOWN)

    intent = parse_intent(text)
    action = intent.get("intent", "unknown")

    # ── Route to correct action ────────────────────────────────────────────────
    if action == "export":
        await msg.delete()
        ctx.args = []
        await cmd_export(update, ctx)

    elif action == "results":
        await msg.delete()
        ctx.args = [str(intent["n"])] if intent.get("n") else []
        await cmd_results(update, ctx)

    elif action == "status":
        await msg.delete()
        await cmd_status(update, ctx)

    elif action == "help":
        await msg.delete()
        await cmd_help(update, ctx)

    elif action == "new_job":
        # Create job + auto-crawl if URL provided
        desc  = intent.get("job_description") or text
        name  = intent.get("job_name") or _auto_job_name(desc)
        url   = intent.get("url")
        pages = intent.get("max_pages") or config.CRAWL_MAX_PAGES

        job_id = db.create_job(name, desc)
        await msg.edit_text(
            f"✅ Job created: *{name}*\n_{desc}_",
            parse_mode=ParseMode.MARKDOWN
        )

        if url:
            ctx.args = [url, str(pages)]
            await _do_crawl(update, ctx, job_id, url, pages)
        else:
            await update.message.reply_text(
                f"Job ready! Now send me a URL to crawl, e.g.:\n`https://example.com`",
                parse_mode=ParseMode.MARKDOWN
            )

    elif action in ("scrape", "crawl"):
        url = intent.get("url")
        if not url:
            await msg.edit_text("I need a URL. Send me the link you want to scrape.")
            return

        job = db.get_active_job()
        if not job:
            await msg.edit_text(
                "No active job yet. Tell me what you're looking for first, e.g.:\n"
                "_Find all marketing managers in Zurich from https://..._",
                parse_mode=ParseMode.MARKDOWN
            )
            return

        await msg.delete()
        if action == "scrape":
            ctx.args = [url]
            await cmd_scrape(update, ctx)
        else:
            pages = intent.get("max_pages") or config.CRAWL_MAX_PAGES
            ctx.args = [url, str(pages)]
            await cmd_crawl(update, ctx)

    else:
        # Unknown — give a helpful nudge
        await msg.edit_text(
            "I didn't quite get that 🤷\n\n"
            "Try something like:\n"
            "• _Find all clinic directors in Bern from https://example.ch_\n"
            "• _Show me what you found_\n"
            "• _Export to Excel_\n\n"
            "Or type /help for all commands.",
            parse_mode=ParseMode.MARKDOWN
        )


async def _do_crawl(update, ctx, job_id, url, max_pages):
    """Internal crawl helper used by NL handler."""
    msg = await update.message.reply_text(
        f"🕸 Crawling + extracting from `{url}` (up to {max_pages} pages)...",
        parse_mode=ParseMode.MARKDOWN
    )
    job = db.get_job(job_id)
    total_leads = 0
    pages = crawl_site(url, max_pages=max_pages, job_description=job["description"])

    for i, page in enumerate(pages):
        if not page["success"]:
            db.add_page(job_id, page["url"], status="failed", error=page["error"])
            continue
        if db.url_already_scraped(job_id, page["url"]):
            continue
        page_id = db.add_page(job_id, page["url"], markdown=page["markdown"])
        leads = page.get("leads", [])
        for lead in leads:
            db.add_lead(job_id, page_id, lead)
        total_leads += len(leads)
        db.update_page_status(page_id, "extracted")
        if (i + 1) % 10 == 0:
            await msg.edit_text(f"⚙️ {i+1}/{len(pages)} pages done — {total_leads} leads so far...")

    await msg.edit_text(
        f"✅ *Done!*\n\n"
        f"📄 Pages: {len(pages)}\n"
        f"👤 Leads: {total_leads}\n\n"
        f"Say _export_ to get the Excel file.",
        parse_mode=ParseMode.MARKDOWN
    )


# ── Helpers ───────────────────────────────────────────────────────────────────
def _format_leads_preview(leads: list[dict]) -> str:
    lines = []
    for l in leads:
        parts = []
        if l.get("name"):    parts.append(f"👤 {l['name']}")
        if l.get("company"): parts.append(f"🏢 {l['company']}")
        if l.get("title"):   parts.append(f"💼 {l['title']}")
        if l.get("email"):   parts.append(f"📧 `{l['email']}`")
        if l.get("phone"):   parts.append(f"📞 {l['phone']}")
        if l.get("location"):parts.append(f"📍 {l['location']}")
        lines.append("\n".join(parts) if parts else "_(empty)_")
        lines.append("─" * 20)
    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────
def run():
    config.validate()
    db.init_db()

    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start",   cmd_help))
    app.add_handler(CommandHandler("help",    cmd_help))
    app.add_handler(CommandHandler("status",  cmd_status))
    app.add_handler(CommandHandler("newjob",  cmd_newjob))
    app.add_handler(CommandHandler("job",     cmd_job))
    app.add_handler(CommandHandler("jobs",    cmd_jobs))
    app.add_handler(CommandHandler("usejob",  cmd_usejob))
    app.add_handler(CommandHandler("scrape",  cmd_scrape))
    app.add_handler(CommandHandler("crawl",   cmd_crawl))
    app.add_handler(CommandHandler("results", cmd_results))
    app.add_handler(CommandHandler("export",  cmd_export))
    # Natural language — must be last
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    log.info("TataNano Scraper bot started")
    import asyncio
    import time as _time

    async def _run():
        for attempt in range(5):
            try:
                async with app:
                    await app.updater.start_polling(drop_pending_updates=True)
                    await app.start()
                    await asyncio.Event().wait()
            except Exception as e:
                if "Conflict" in str(e) and attempt < 4:
                    wait = 5 * (attempt + 1)
                    log.warning(f"Conflict detected, retrying in {wait}s (attempt {attempt + 1}/5)")
                    _time.sleep(wait)
                else:
                    raise

    asyncio.run(_run())


if __name__ == "__main__":
    run()
