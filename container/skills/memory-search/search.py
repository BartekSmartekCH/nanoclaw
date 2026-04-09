#!/usr/bin/env python3
"""
Memory search — semantic search over conversation archives.

Usage:
    python3 search.py --group telegram_main "your query here"
    python3 search.py --group telegram_main "your query" --top 5
"""

import argparse
import json
import math
import os
import sys
import urllib.request
from pathlib import Path


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def ollama_url() -> str:
    host = os.environ.get("OLLAMA_HOST")
    if host:
        return host.rstrip("/")
    if Path("/.dockerenv").exists():
        return "http://host.docker.internal:11434"
    return "http://localhost:11434"


EMBED_MODEL = "nomic-embed-text"


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


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", required=True, help="Group folder name, e.g. telegram_main")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--top", type=int, default=5, help="Number of results to return")
    parser.add_argument("--base", default=None, help="NanoClaw root directory")
    args = parser.parse_args()

    # Resolve base path
    if args.base:
        base = Path(args.base)
    elif Path("/.dockerenv").exists():
        base = Path("/workspace/project")
    else:
        base = Path(__file__).resolve().parents[3]

    index_file = base / "groups" / args.group / "memory-index" / "index.json"

    if not index_file.exists():
        print(f"No index found for group '{args.group}'.")
        print(f"Run: python3 indexer.py --group {args.group}")
        sys.exit(1)

    with open(index_file) as f:
        index = json.load(f)

    chunks = index.get("chunks", [])
    if not chunks:
        print("Index is empty.")
        sys.exit(1)

    # Embed query
    try:
        query_vec = embed(args.query)
    except Exception as e:
        print(f"Failed to embed query: {e}", file=sys.stderr)
        sys.exit(1)

    # Score all chunks
    scored = []
    for chunk in chunks:
        score = cosine(query_vec, chunk["vector"])
        scored.append((score, chunk))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Deduplicate: skip results whose full text matches an already-selected result.
    # Compare full chunk text (not just prefix) to avoid false positives on shared preambles.
    seen_texts: set[str] = set()
    top: list[tuple[float, dict]] = []
    for score, chunk in scored:
        text = chunk.get("full_text", chunk.get("text", "")).strip()
        if text in seen_texts:
            continue
        seen_texts.add(text)
        top.append((score, chunk))
        if len(top) >= args.top:
            break

    # Output
    print(f"\n=== Memory search: \"{args.query}\" ===\n")
    for rank, (score, chunk) in enumerate(top, 1):
        print(f"[{rank}] {chunk['date']} — {chunk['file']}  (score: {score:.3f})")
        preview = chunk.get("full_text", chunk.get("text", ""))[:400].replace("\n", " ").strip()
        print(f"    {preview}")
        print()

    # Also output as JSON for programmatic use
    results = [
        {
            "rank": i + 1,
            "score": round(score, 4),
            "date": chunk["date"],
            "file": chunk["file"],
            "text": chunk.get("full_text", chunk.get("text", "")),
        }
        for i, (score, chunk) in enumerate(top)
    ]
    print("--- JSON ---")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
