"""
TataNano Scraper — Configuration
Priority order for secrets:
  1. macOS Keychain  (NanoClaw convention: service per credential, account "bartek")
  2. .env file       (optional, in project root)
  3. Environment variables

To store in Keychain, run once in Terminal:
  security add-generic-password -s NanoClaw-crawler-telegram-token -a bartek -w "your_token"
  security add-generic-password -s NanoClaw-firecrawl-api-key     -a bartek -w "your_key"
"""
import os
import subprocess
from pathlib import Path
from dotenv import load_dotenv

# Load .env as base layer (won't override existing env vars)
_env_path = Path(__file__).parent.parent / ".env"
load_dotenv(_env_path)


# ── Keychain helper ───────────────────────────────────────────────────────────
# Maps config keys to NanoClaw Keychain service names (account is always "bartek")
_KEYCHAIN_MAP: dict[str, str] = {
    "TELEGRAM_BOT_TOKEN": "NanoClaw-crawler-telegram-token",
    "FIRECRAWL_API_KEY":  "NanoClaw-firecrawl-api-key",
}


def _keychain(key: str) -> str:
    """
    Read a secret from macOS Keychain using NanoClaw naming convention.
    Returns empty string if not found or not on macOS.
    """
    service = _KEYCHAIN_MAP.get(key)
    if not service:
        return ""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", "bartek", "-w"],
            capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass  # Not macOS, or security tool unavailable
    return ""


def _secret(key: str, default: str = "") -> str:
    """Get a secret: Keychain first, then .env / environment."""
    return _keychain(key) or os.getenv(key, default)


# ── Telegram ──────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN: str = _secret("TELEGRAM_BOT_TOKEN")
ALLOWED_CHAT_IDS: list[int] = [
    int(x) for x in os.getenv("ALLOWED_CHAT_IDS", "8774386022,-5265094203").split(",") if x.strip()
]

# ── Firecrawl ─────────────────────────────────────────────────────────────────
FIRECRAWL_API_KEY: str  = _secret("FIRECRAWL_API_KEY")
FIRECRAWL_BASE_URL: str = os.getenv("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev")

# ── Database ──────────────────────────────────────────────────────────────────
DB_PATH: str = os.getenv("DB_PATH", str(Path(__file__).parent.parent / "data" / "tatanano.db"))

# ── Scraping ──────────────────────────────────────────────────────────────────
CRAWL_MAX_PAGES: int   = int(os.getenv("CRAWL_MAX_PAGES", "50"))
SCRAPE_TIMEOUT: int    = int(os.getenv("SCRAPE_TIMEOUT", "30"))
RATE_LIMIT_DELAY: float = float(os.getenv("RATE_LIMIT_DELAY", "1.5"))

# ── Export ────────────────────────────────────────────────────────────────────
EXPORT_DIR: str = os.getenv("EXPORT_DIR", str(Path(__file__).parent.parent / "exports"))

# ── Validation ────────────────────────────────────────────────────────────────
def validate():
    missing = []
    if not TELEGRAM_BOT_TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not FIRECRAWL_API_KEY:
        missing.append("FIRECRAWL_API_KEY")
    if missing:
        raise EnvironmentError(
            f"Missing secrets: {', '.join(missing)}\n\n"
            "Add via Keychain (recommended):\n"
            f"  security add-generic-password -s NanoClaw-crawler-telegram-token -a bartek -w \"your_token\"\n"
            f"  security add-generic-password -s NanoClaw-firecrawl-api-key     -a bartek -w \"your_key\"\n\n"
            "Or add to .env file in the project folder."
        )

# Ensure directories exist
Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
Path(EXPORT_DIR).mkdir(parents=True, exist_ok=True)
