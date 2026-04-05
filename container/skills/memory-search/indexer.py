#!/usr/bin/env python3
"""
Memory indexer — builds/updates a vector index over conversation archives,
then runs a synthesis pass to extract structured facts into knowledge.md.

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
from typing import List, Optional, Tuple


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
SYNTH_MODEL = "qwen2.5vl:7b"
CHUNK_CHARS = 1800   # ~500 tokens at ~3.5 chars/token
CHUNK_OVERLAP = 200
SYNTH_MAX_CHARS = 6000  # truncate input to synthesis model


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def embed(text: str) -> List[float]:
    payload = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode()
    req = urllib.request.Request(
        f"{ollama_url()}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["embedding"]


def chunk_text(text: str) -> List[str]:
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
# Synthesis
# ---------------------------------------------------------------------------

SYNTH_PROMPT = """You are a knowledge extractor for a personal AI assistant system.
Given a conversation transcript, extract the most important facts in a structured format.
Focus only on things that are worth remembering across future sessions.

Output ONLY in this exact format. Omit any section that has nothing to add — do not output empty sections.

**Decisions:** <decisions made, e.g. architectural choices, confirmed approaches>
**Built:** <things implemented or shipped>
**Fixed:** <bugs or issues resolved>
**Discussed:** <topics discussed but not yet acted on>
**Open:** <pending items awaiting go-ahead or follow-up>
**Preferences:** <user preferences or working style expressed>

Rules:
- Be concise. One line per item, comma-separated within a section if multiple.
- Do not invent facts. Only extract what is clearly present in the transcript.
- If nothing noteworthy happened, output exactly: SKIP

Transcript:
"""


def call_ollama_generate(prompt: str) -> str:
    payload = json.dumps({
        "model": SYNTH_MODEL,
        "prompt": prompt,
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{ollama_url()}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["response"].strip()


def synthesize_file(md_file: Path, date: str) -> Optional[str]:
    """Run synthesis on a conversation file. Returns formatted entry or None."""
    text = md_file.read_text(encoding="utf-8", errors="replace")
    truncated = text[:SYNTH_MAX_CHARS]
    response = call_ollama_generate(SYNTH_PROMPT + truncated)
    if response.strip().upper() == "SKIP" or not response.strip():
        return None
    return f"## {date}\n\n{response}\n"


def load_pending(pending_file: Path) -> List:
    if not pending_file.exists():
        return []
    try:
        return json.loads(pending_file.read_text())
    except Exception:
        return []


def save_pending(pending_file: Path, filenames: List) -> None:
    pending_file.write_text(json.dumps(filenames))


def append_knowledge(knowledge_file: Path, entry: str) -> None:
    with open(knowledge_file, "a", encoding="utf-8") as f:
        if knowledge_file.stat().st_size > 0:
            f.write("\n---\n\n")
        f.write(entry)


def run_synthesis(files_to_synthesize: List[Tuple[Path, str]], knowledge_file: Path, pending_file: Path) -> None:
    """
    Attempt synthesis for each file. Writes results to knowledge_file.
    On any Ollama failure: saves remaining files to pending_file and stops.
    Clears pending_file on full success.
    """
    remaining = [(str(f), d) for f, d in files_to_synthesize]

    for md_path_str, date in list(remaining):
        md_file = Path(md_path_str)
        fname = md_file.name
        try:
            print(f"  Synthesizing {fname}...", end=" ", flush=True)
            entry = synthesize_file(md_file, date)
            if entry:
                knowledge_file.touch(exist_ok=True)
                append_knowledge(knowledge_file, entry)
                print("done")
            else:
                print("nothing noteworthy")
            remaining.remove((md_path_str, date))
        except Exception as e:
            print(f"\n  Synthesis failed for {fname}: {e}", file=sys.stderr)
            print(f"  Saving {len(remaining)} file(s) to pending for retry.", file=sys.stderr)
            save_pending(pending_file, [[p, d] for p, d in remaining])
            return

    # All done — clear pending flag
    if pending_file.exists():
        pending_file.unlink()


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

    group_dir = base / "groups" / args.group
    conversations_dir = group_dir / "conversations"
    knowledge_file = group_dir / "knowledge.md"
    pending_file = group_dir / ".synthesis-pending"
    index_dir = Path(args.index_dir) if args.index_dir else group_dir / "memory-index"
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

    new_files_count = 0
    new_chunks = 0
    newly_indexed: List[Tuple[Path, str]] = []  # (path, date) for synthesis

    # --- Phase 1: Vector indexing ---
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
        date = date_match.group(1) if date_match else datetime.utcnow().strftime("%Y-%m-%d")

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
        new_files_count += 1
        newly_indexed.append((md_file, date))
        print(f"{len(file_chunks)} chunks")

    index["chunks"] = chunks
    index["file_hashes"] = existing_hashes
    index["updated_at"] = datetime.utcnow().isoformat()
    index["group"] = args.group

    with open(index_file, "w") as f:
        json.dump(index, f)

    print(f"\nDone. {new_files_count} files indexed, {new_chunks} new chunks. Total: {len(chunks)} chunks.")
    print(f"Index saved to {index_file}")

    # --- Phase 2: Synthesis ---
    # Retry any previously failed synthesis first
    pending = load_pending(pending_file)
    retry_files: List[Tuple[Path, str]] = []
    if pending:
        print(f"\nRetrying {len(pending)} pending synthesis file(s)...")
        retry_files = [(Path(p), d) for p, d in pending]

    to_synthesize = retry_files + newly_indexed
    if to_synthesize:
        print(f"\nSynthesis pass ({len(to_synthesize)} file(s))...")
        run_synthesis(to_synthesize, knowledge_file, pending_file)
    else:
        print("\nNo new files to synthesize.")

    # --- Phase 3: Index knowledge.md ---
    # knowledge.md is append-only and higher signal than raw archives.
    # Re-index it fully on every run so new entries are always searchable.
    # Chunks get source="knowledge" so search.py can rank them higher.
    if knowledge_file.exists() and knowledge_file.stat().st_size > 0:
        print("\nIndexing knowledge.md...")
        knowledge_text = knowledge_file.read_text(encoding="utf-8", errors="replace")
        knowledge_fhash = file_hash(knowledge_file)
        knowledge_fname = "__knowledge__"

        if existing_hashes.get(knowledge_fname) != knowledge_fhash:
            # Remove old knowledge chunks and re-index
            chunks = [c for c in chunks if c.get("source") != "knowledge"]
            knowledge_chunks = chunk_text(knowledge_text)
            knowledge_new = 0
            for i, chunk in enumerate(knowledge_chunks):
                try:
                    vector = embed(chunk)
                except Exception as e:
                    print(f"\nEmbedding failed for knowledge.md chunk {i}: {e}", file=sys.stderr)
                    continue
                chunks.append({
                    "file": knowledge_fname,
                    "date": datetime.utcnow().strftime("%Y-%m-%d"),
                    "chunk_index": i,
                    "text": chunk[:500],
                    "full_text": chunk,
                    "vector": vector,
                    "source": "knowledge",
                })
                knowledge_new += 1
            existing_hashes[knowledge_fname] = knowledge_fhash
            print(f"knowledge.md indexed: {knowledge_new} chunks")

            # Save updated index with knowledge chunks
            index["chunks"] = chunks
            index["file_hashes"] = existing_hashes
            index["updated_at"] = datetime.utcnow().isoformat()
            with open(index_file, "w") as f:
                json.dump(index, f)
        else:
            print("knowledge.md unchanged, skipping.")


if __name__ == "__main__":
    main()
