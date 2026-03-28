"""
ScrapeNano — Firecrawl Scraper + Extraction
Handles single-page scrape and multi-page crawl via Firecrawl API.
Extraction via v1 "extract" format with separate schema parameter.
Anti-bot resistant: Firecrawl handles JS rendering, stealth headers, retries.
"""
import time
import requests
from typing import Optional
from . import config

# ── Firecrawl client ───────────────────────────────────────────────────────────
def _headers() -> dict:
    return {
        "Authorization": f"Bearer {config.FIRECRAWL_API_KEY}",
        "Content-Type": "application/json",
    }


# ── Lead extraction schema ────────────────────────────────────────────────────
def _extract_params(job_description: str) -> dict:
    """Build the extract parameter for Firecrawl v1 API."""
    return {
        "schema": {
            "type": "object",
            "properties": {
                "leads": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "email": {"type": "string"},
                            "phone": {"type": "string"},
                            "company": {"type": "string"},
                            "title": {"type": "string"},
                            "location": {"type": "string"},
                            "website": {"type": "string"},
                            "linkedin": {"type": "string"},
                            "description": {"type": "string"},
                        },
                    },
                }
            },
            "required": ["leads"],
        },
        "prompt": f"Extract all contact/lead information matching: {job_description}. "
                  "Return only leads that are explicitly present on the page. "
                  "Do not invent or guess data.",
    }


# ── Single page scrape ────────────────────────────────────────────────────────
def scrape_page(url: str, job_description: str = None) -> dict:
    """
    Scrape a single URL via Firecrawl /v1/scrape.
    If job_description is provided, also extracts leads server-side.
    Returns: {"url", "markdown", "title", "leads", "success", "error"}
    """
    endpoint = f"{config.FIRECRAWL_BASE_URL}/v1/scrape"

    formats = ["markdown"]
    payload = {
        "url": url,
        "formats": formats,
        "onlyMainContent": True,
        "waitFor": 1500,
        "timeout": config.SCRAPE_TIMEOUT * 1000,
    }

    if job_description:
        payload["formats"].append("extract")
        payload["extract"] = _extract_params(job_description)

    try:
        resp = requests.post(endpoint, json=payload, headers=_headers(), timeout=config.SCRAPE_TIMEOUT + 10)
        resp.raise_for_status()
        data = resp.json()

        if not data.get("success"):
            return {"url": url, "markdown": "", "title": "", "leads": [],
                    "success": False, "error": data.get("error", "Firecrawl returned success=false")}

        page_data = data.get("data", {})
        md = page_data.get("markdown", "")
        title = page_data.get("metadata", {}).get("title", "")
        leads = _parse_leads(page_data.get("extract", {}), url)

        return {"url": url, "markdown": md, "title": title, "leads": leads,
                "success": True, "error": None}

    except requests.exceptions.Timeout:
        return {"url": url, "markdown": "", "title": "", "leads": [],
                "success": False, "error": "Timeout"}
    except requests.exceptions.HTTPError as e:
        return {"url": url, "markdown": "", "title": "", "leads": [],
                "success": False, "error": f"HTTP {e.response.status_code}"}
    except Exception as e:
        return {"url": url, "markdown": "", "title": "", "leads": [],
                "success": False, "error": str(e)}


# ── Multi-page crawl ──────────────────────────────────────────────────────────
def crawl_site(url: str, max_pages: int = None, job_description: str = None,
               progress_callback=None) -> list[dict]:
    """
    Crawl an entire site via Firecrawl /v1/crawl.
    If job_description is provided, extraction happens server-side per page.
    Returns list of page dicts with leads included.
    """
    if max_pages is None:
        max_pages = config.CRAWL_MAX_PAGES

    scrape_options = {
        "formats": ["markdown"],
        "onlyMainContent": True,
        "waitFor": 1500,
    }

    if job_description:
        scrape_options["formats"].append("extract")
        scrape_options["extract"] = _extract_params(job_description)

    endpoint = f"{config.FIRECRAWL_BASE_URL}/v1/crawl"
    payload = {
        "url": url,
        "limit": max_pages,
        "scrapeOptions": scrape_options,
        "excludePaths": ["*/login*", "*/logout*", "*/cart*", "*/checkout*",
                         "*.pdf", "*.jpg", "*.png", "*.gif", "*.zip"],
    }

    try:
        resp = requests.post(endpoint, json=payload, headers=_headers(), timeout=30)
        resp.raise_for_status()
        job_data = resp.json()
    except Exception as e:
        return [{"url": url, "markdown": "", "title": "", "leads": [],
                 "success": False, "error": f"Crawl start failed: {e}"}]

    job_id = job_data.get("id")
    if not job_id:
        return [{"url": url, "markdown": "", "title": "", "leads": [],
                 "success": False, "error": f"No job ID returned: {job_data}"}]

    # ── Poll for completion ────────────────────────────────────────────────────
    poll_url = f"{config.FIRECRAWL_BASE_URL}/v1/crawl/{job_id}"
    poll_interval = 3
    max_polls = 300  # 15 min max

    for _ in range(max_polls):
        time.sleep(poll_interval)
        try:
            poll_resp = requests.get(poll_url, headers=_headers(), timeout=15)
            poll_resp.raise_for_status()
            poll_data = poll_resp.json()
        except Exception:
            continue

        status = poll_data.get("status", "")
        completed = poll_data.get("completed", 0)
        total = poll_data.get("total", 0)

        if progress_callback and total > 0:
            progress_callback(completed, total)

        if status == "completed":
            pages_raw = poll_data.get("data", [])
            results = []
            for p in pages_raw:
                page_url = p.get("metadata", {}).get("sourceURL", url)
                results.append({
                    "url": page_url,
                    "title": p.get("metadata", {}).get("title", ""),
                    "markdown": p.get("markdown", ""),
                    "leads": _parse_leads(p.get("extract", {}), page_url),
                    "success": True,
                    "error": None,
                })
            return results

        if status in ("failed", "cancelled"):
            return [{"url": url, "markdown": "", "title": "", "leads": [],
                     "success": False, "error": f"Crawl job {status}"}]

    return [{"url": url, "markdown": "", "title": "", "leads": [],
             "success": False, "error": "Crawl timed out after 15 minutes"}]


# ── URL list scrape (batch) ───────────────────────────────────────────────────
def scrape_url_list(urls: list[str], job_description: str = None,
                    delay: float = None, progress_callback=None) -> list[dict]:
    """Scrape a list of specific URLs one by one with rate limiting."""
    if delay is None:
        delay = config.RATE_LIMIT_DELAY

    results = []
    for i, url in enumerate(urls):
        result = scrape_page(url, job_description=job_description)
        results.append(result)
        if progress_callback:
            progress_callback(i + 1, len(urls))
        if i < len(urls) - 1:
            time.sleep(delay)
    return results


# ── Helpers ───────────────────────────────────────────────────────────────────
def _parse_leads(extract_data: dict, source_url: str) -> list[dict]:
    """Parse leads from Firecrawl's extract response."""
    if not extract_data:
        return []

    leads = extract_data.get("leads", [])
    if not isinstance(leads, list):
        return []

    result = []
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        clean = {}
        for k, v in lead.items():
            if v and v != "null":
                clean[k] = str(v).strip() if isinstance(v, (str, int, float)) else str(v)
        if clean:
            clean["source_url"] = source_url
            result.append(clean)
    return result
