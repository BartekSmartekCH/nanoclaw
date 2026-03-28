"""
TataNano Scraper — Natural Language Intent Parser
Rule-based intent parsing — no external LLM needed.
"""
import re


# ── Intent schema ──────────────────────────────────────────────────────────────
# Possible intents:
#   new_job, scrape, crawl, results, export, status, help, unknown


def parse_intent(text: str) -> dict:
    """Parse a natural language message into a structured intent dict."""
    t = text.lower()
    url = _extract_url(text)

    if any(w in t for w in ["export", "excel", "download", "xlsx"]):
        return _intent("export")
    if any(w in t for w in ["result", "found", "show", "what did", "leads"]):
        n = _extract_number(text)
        return _intent("results", n=n)
    if any(w in t for w in ["status", "check", "running", "working"]):
        return _intent("status")
    if any(w in t for w in ["help", "how", "command"]):
        return _intent("help")
    if url:
        # Has URL — decide crawl vs new_job based on whether there's description
        words_without_url = re.sub(r'https?://\S+', '', text).strip()
        if len(words_without_url) > 20:
            return _intent("new_job", url=url, job_description=words_without_url)
        return _intent("crawl", url=url)

    # If no URL but enough text, treat as new job description
    if len(text.strip()) > 30:
        return _intent("new_job", job_description=text.strip())

    return _intent("unknown")


def _extract_url(text: str) -> str | None:
    match = re.search(r'https?://[^\s]+', text)
    return match.group(0).rstrip('.,)') if match else None


def _extract_number(text: str) -> int | None:
    match = re.search(r'\b(\d+)\b', text)
    return int(match.group(1)) if match else None


def _intent(intent: str, **kwargs) -> dict:
    base = {"intent": intent, "job_name": None, "job_description": None,
            "url": None, "max_pages": None, "n": None}
    return {**base, **kwargs}


def _auto_job_name(description: str) -> str:
    """Generate a short job name from description using first few meaningful words."""
    stop = {"find","get","extract","collect","all","the","a","an","of","in","from","and","or","with"}
    words = [w.capitalize() for w in description.split() if w.lower() not in stop]
    return " ".join(words[:3]) or "New Job"
