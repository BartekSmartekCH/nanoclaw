#!/usr/bin/env python3
"""
Memory indexer — builds/updates a vector index over conversation archives.

Usage:
    python3 indexer.py --group telegram_main [--base /path/to/nanoclaw] [--index-dir /path/to/write/index]
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def ollama_url() -> str:
    host = os.environ.get("OLLAMA_HOST")
    if host:
        return host.rstrip("/")
    # Inside Docker container
    if Path("/.dockerenv").exists():
        return "http://host.docker.internal:11434"
    # Outside container (CoderBot / host)
    return "http://localhost:11434"


EMBED_MODEL = "nomic-embed-text"
CHUNK_CHARS = 1800   # ~500 tokens at ~3.5 chars/token
CHUNK_OVERLAP = 200


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def embed(text: str) -> list[float]:
    payload = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode()
    req = urllib.request.Request(
        f"{ollama_url()}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["embedding"]


def chunk_text(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_CHARS
        chunks.append(text[start:end])
        start += CHUNK_CHARS - CHUNK_OVERLAP
    return [c.strip() for c in chunks if c.strip()]


def file_hash(path: Path) -> str:
    """Simple mtime+size fingerprint — avoids re-indexing unchanged files."""
    s = path.stat()
    return f"{s.st_mtime_ns}:{s.st_size}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", required=True, help="Group folder name, e.g. telegram_main")
    parser.add_argument("--base", default=None, help="NanoClaw root directory")
    parser.add_argument("--index-dir", default=None, help="Override directory where the index is written (useful when --base is read-only)")
    args = parser.parse_args()

    # Resolve base path
    if args.base:
        base = Path(args.base)
    elif Path("/.dockerenv").exists():
        base = Path("/workspace/project")
    else:
        base = Path(__file__).resolve().parents[3]  # container/skills/memory-search/ → root

    conversations_dir = base / "groups" / args.group / "conversations"
    index_dir = Path(args.index_dir) if args.index_dir else base / "groups" / args.group / "memory-index"
    index_file = index_dir / "index.json"

    if not conversations_dir.exists():
        print(f"No conversations directory found at {conversations_dir}", file=sys.stderr)
        sys.exit(1)

    index_dir.mkdir(parents=True, exist_ok=True)

    # Load existing index
    if index_file.exists():
        with open(index_file) as f:
            index = json.load(f)
    else:
        index = {"chunks": [], "file_hashes": {}}

    existing_hashes = index.get("file_hashes", {})
    chunks = index.get("chunks", [])

    md_files = sorted(conversations_dir.glob("*.md"))
    if not md_files:
        print("No conversation files found.")
        return

    new_files = 0
    new_chunks = 0

    for md_file in md_files:
        fhash = file_hash(md_file)
        fname = md_file.name

        if existing_hashes.get(fname) == fhash:
            continue  # unchanged

        print(f"Indexing {fname}...", end=" ", flush=True)

        # Remove old chunks for this file
        chunks = [c for c in chunks if c["file"] != fname]

        text = md_file.read_text(encoding="utf-8", errors="replace")
        # Extract date from filename e.g. 2026-03-20-conversation-*.md
        date_match = re.match(r"(\d{4}-\d{2}-\d{2})", fname)
        date = date_match.group(1) if date_match else "unknown"

        file_chunks = chunk_text(text)
        for i, chunk in enumerate(file_chunks):
            try:
                vector = embed(chunk)
            except Exception as e:
                print(f"\nEmbedding failed for {fname} chunk {i}: {e}", file=sys.stderr)
                continue
            chunks.append({
                "file": fname,
                "date": date,
                "chunk_index": i,
                "text": chunk[:500],   # store preview only, not full chunk
                "full_text": chunk,
                "vector": vector,
            })
            new_chunks += 1

        existing_hashes[fname] = fhash
        new_files += 1
        print(f"{len(file_chunks)} chunks")

    index["chunks"] = chunks
    index["file_hashes"] = existing_hashes
    index["updated_at"] = datetime.utcnow().isoformat()
    index["group"] = args.group

    with open(index_file, "w") as f:
        json.dump(index, f)

    print(f"\nDone. {new_files} files indexed, {new_chunks} new chunks. Total: {len(chunks)} chunks.")
    print(f"Index saved to {index_file}")


if __name__ == "__main__":
    main()
