"""
ScrapeNano — Ollama Extraction Pipeline
Sends scraped markdown to local Ollama (qwen2.5vl:7b) for structured extraction.
All processing is local — no data leaves the machine.
"""
import json
import re
import requests
from typing import Optional
from . import config

# ── System prompt template ────────────────────────────────────────────────────
_SYSTEM = """You are a precise data extraction assistant.
Your task is to extract structured contact/lead information from scraped webpage content.
You MUST return ONLY valid JSON — no explanation, no markdown fences, no extra text.
If a field is not found, use null.
Never invent or guess data that is not explicitly present in the content."""

# ── Main extraction function ──────────────────────────────────────────────────
def extract(markdown: str, job_description: str, source_url: str = "") -> list[dict]:
    """
    Extract structured leads from markdown content.

    markdown: raw scraped text from Firecrawl
    job_description: what kind of leads we're looking for (free text from user)
    source_url: where the content came from (added to each lead)

    Returns: list of dicts (one per lead found on the page).
    Empty list if nothing found or on error.
    """
    if not markdown or len(markdown.strip()) < 50:
        return []

    # Truncate very long pages to avoid context overflow (~12k chars ~ 3k tokens)
    content = markdown[:12000] if len(markdown) > 12000 else markdown

    prompt = _build_prompt(content, job_description, source_url)

    try:
        response_text = _call_ollama(prompt)
        leads = _parse_response(response_text)
        # Stamp source URL on each lead
        for lead in leads:
            if source_url and not lead.get("source_url"):
                lead["source_url"] = source_url
        return leads
    except Exception as e:
        return []  # Fail silently — page gets marked as failed in DB


def _build_prompt(content: str, job_description: str, source_url: str) -> str:
    return f"""Job context: {job_description}

Source URL: {source_url}

Scraped content:
---
{content}
---

Extract ALL relevant leads/contacts from the above content that match the job context.
Return a JSON array. Each item should include any of these fields that are present:
  name, email, phone, company, title, location, website, linkedin, description, source_url

Example output format:
[
  {{
    "name": "John Smith",
    "email": "john@example.com",
    "phone": "+41 79 123 45 67",
    "company": "ACME AG",
    "title": "CEO",
    "location": "Zurich, Switzerland",
    "source_url": "{source_url}"
  }}
]

If no relevant leads are found, return an empty array: []
Return ONLY the JSON array, nothing else."""


def _call_ollama(prompt: str) -> str:
    """Call Ollama /api/generate endpoint. Returns raw response text."""
    endpoint = f"{config.OLLAMA_BASE_URL}/api/generate"
    payload = {
        "model": config.OLLAMA_MODEL,
        "prompt": prompt,
        "system": _SYSTEM,
        "stream": False,
        "options": {
            "temperature": 0.1,      # low temp for precise extraction
            "top_p": 0.9,
            "num_predict": 2048,
        }
    }

    resp = requests.post(endpoint, json=payload, timeout=config.OLLAMA_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    return data.get("response", "")


def _parse_response(text: str) -> list[dict]:
    """
    Parse Ollama's response into a list of lead dicts.
    Handles cases where model wraps JSON in markdown fences.
    """
    if not text:
        return []

    # Strip markdown fences if present
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)
    text = text.strip()

    # Try to find JSON array in the response
    # Sometimes model adds preamble text before the JSON
    match = re.search(r'\[.*\]', text, re.DOTALL)
    if match:
        text = match.group(0)

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            # Filter out empty dicts and ensure values are strings/null
            result = []
            for item in parsed:
                if isinstance(item, dict) and any(v for v in item.values() if v):
                    result.append(_sanitize_lead(item))
            return result
        elif isinstance(parsed, dict):
            # Model returned single object instead of array
            return [_sanitize_lead(parsed)]
    except json.JSONDecodeError:
        return []

    return []


def _sanitize_lead(lead: dict) -> dict:
    """Ensure all values are strings or None. Remove internal keys."""
    clean = {}
    for k, v in lead.items():
        if v is None or v == "" or v == "null":
            clean[k] = None
        elif isinstance(v, (int, float)):
            clean[k] = str(v)
        elif isinstance(v, str):
            clean[k] = v.strip() or None
        elif isinstance(v, list):
            clean[k] = ", ".join(str(i) for i in v) if v else None
        else:
            clean[k] = str(v)
    return clean


# ── Ollama health check ───────────────────────────────────────────────────────
def check_ollama() -> tuple[bool, str]:
    """Returns (ok: bool, message: str)"""
    try:
        resp = requests.get(f"{config.OLLAMA_BASE_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        if config.OLLAMA_MODEL in models:
            return True, f"✅ Ollama online — {config.OLLAMA_MODEL} ready"
        else:
            available = ", ".join(models) if models else "none"
            return False, f"⚠️ Ollama online but {config.OLLAMA_MODEL} not found. Available: {available}"
    except requests.exceptions.ConnectionError:
        return False, f"❌ Cannot reach Ollama at {config.OLLAMA_BASE_URL} — is it running?"
    except Exception as e:
        return False, f"❌ Ollama error: {e}"
