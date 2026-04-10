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
import tempfile
import urllib.request
from datetime import datetime, timezone
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
SYNTH_MODEL = "gemma4:e2b"
CHUNK_CHARS = 1800   # ~500 tokens at ~3.5 chars/token
CHUNK_OVERLAP = 200
SYNTH_MAX_CHARS = 10000  # ~2500 tokens, safe headroom for gemma4:e2b + prompt


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


def atomic_json_write(path: Path, data: dict) -> None:
    """Write JSON atomically: write to temp file, then rename (crash-safe)."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, str(path))  # atomic on POSIX
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def content_hash(text: str) -> str:
    """SHA-256 of normalized text for deduplication across files."""
    import hashlib
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()[:16]


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


def synthesize_file(md_file: Path, date: str, fname: str) -> Optional[str]:
    """Run synthesis on a conversation file. Returns formatted entry or None."""
    text = md_file.read_text(encoding="utf-8", errors="replace")
    # Read the tail — most recent/relevant content is at the end
    truncated = text[-SYNTH_MAX_CHARS:]
    response = call_ollama_generate(SYNTH_PROMPT + truncated)
    if response.strip().upper() == "SKIP" or not response.strip():
        return None
    # Filter out per-field SKIP/None lines
    lines = response.split('\n')
    lines = [l for l in lines if not re.match(r'\*\*\w+:\*\*\s*(SKIP|None|none)\.?\s*$', l)]
    response = '\n'.join(lines).strip()
    if not response:
        return None
    # Tag heading with source filename so it can be found and replaced later
    return f"## {date} <!-- {fname} -->\n\n{response}\n"


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


def replace_or_append_knowledge(knowledge_file: Path, fname: str, entry: str) -> None:
    """Write entry to knowledge_file. If a tagged section for fname exists, replace it.
    Otherwise append. Sections are separated by newline-dash-dash-dash-newline."""
    tag = f"<!-- {fname} -->"

    if not knowledge_file.exists() or knowledge_file.stat().st_size == 0:
        knowledge_file.write_text(entry, encoding="utf-8")
        return

    content = knowledge_file.read_text(encoding="utf-8")

    if tag in content:
        sections = re.split(r'\n---\n', content)
        new_sections = []
        replaced = False
        for section in sections:
            if tag in section:
                new_sections.append(entry.rstrip())
                replaced = True
            else:
                new_sections.append(section)
        if replaced:
            knowledge_file.write_text('\n---\n'.join(new_sections), encoding="utf-8")
            return

    # No existing tag found — append
    with open(knowledge_file, "a", encoding="utf-8") as f:
        f.write("\n---\n\n")
        f.write(entry)


def run_synthesis(
    files_to_synthesize: List[Tuple[Path, str]],
    knowledge_file: Path,
    pending_file: Path,
    synthesized_hashes: dict,
) -> None:
    """
    Attempt synthesis for each file. Writes results to knowledge_file.
    Skips files whose hash hasn't changed since last synthesis.
    On any Ollama failure: saves remaining files to pending_file and stops.
    Clears pending_file on full success.
    Updates synthesized_hashes in-place on each success.
    """
    remaining = [(str(f), d) for f, d in files_to_synthesize]

    for md_path_str, date in list(remaining):
        md_file = Path(md_path_str)
        fname = md_file.name
        fhash = file_hash(md_file)

        if synthesized_hashes.get(fname) == fhash:
            print(f"  Skipping {fname} — already synthesized at this version")
            remaining.remove((md_path_str, date))
            continue

        try:
            print(f"  Synthesizing {fname}...", end=" ", flush=True)
            entry = synthesize_file(md_file, date, fname)
            if entry:
                replace_or_append_knowledge(knowledge_file, fname, entry)
                print("done")
            else:
                print("nothing noteworthy")
            synthesized_hashes[fname] = fhash
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

def check_ollama() -> bool:
    """Check if Ollama is running and has the required models."""
    try:
        req = urllib.request.Request(f"{ollama_url()}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            model_names = [m.get("name", "") for m in data.get("models", [])]
            has_embed = any(EMBED_MODEL in n for n in model_names)
            has_synth = any(SYNTH_MODEL in n for n in model_names)
            if not has_embed:
                print(f"Ollama missing embedding model: {EMBED_MODEL}", file=sys.stderr)
            if not has_synth:
                print(f"Ollama missing synthesis model: {SYNTH_MODEL} (synthesis will be skipped)", file=sys.stderr)
            return has_embed  # Embedding is required, synthesis is optional
    except Exception as e:
        print(f"Ollama not available at {ollama_url()}: {e}", file=sys.stderr)
        return False


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
    sources_dir = group_dir / "sources"
    global_sources_dir = base / "groups" / "global" / "sources"
    knowledge_file = group_dir / "knowledge.md"
    pending_file = group_dir / ".synthesis-pending"

    has_conversations = conversations_dir.exists()
    has_sources = sources_dir.exists() or global_sources_dir.exists()

    if not has_conversations and not has_sources:
        print(f"No conversations or sources to index for {args.group}.")
        sys.exit(0)

    if not check_ollama():
        print("Ollama not ready, skipping indexing.", file=sys.stderr)
        sys.exit(0)  # Clean exit — will retry next run

    # Deduplicate existing knowledge.md before doing anything else.
    # Identical adjacent sections (same content after stripping) are collapsed to one.
    if knowledge_file.exists() and knowledge_file.stat().st_size > 0:
        content = knowledge_file.read_text(encoding="utf-8")
        sections = re.split(r'\n---\n', content)
        seen = []
        deduped = []
        for section in sections:
            key = section.strip()
            if key not in seen:
                seen.append(key)
                deduped.append(section)
        if len(deduped) < len(sections):
            removed = len(sections) - len(deduped)
            knowledge_file.write_text('\n---\n'.join(deduped), encoding="utf-8")
            print(f"Deduplicated knowledge.md: removed {removed} duplicate section(s)")
    index_dir = Path(args.index_dir) if args.index_dir else group_dir / "memory-index"
    index_file = index_dir / "index.json"

    index_dir.mkdir(parents=True, exist_ok=True)

    # Load existing index
    if index_file.exists():
        with open(index_file) as f:
            index = json.load(f)
    else:
        index = {"chunks": [], "file_hashes": {}}

    existing_hashes = index.get("file_hashes", {})
    synthesized_hashes = index.get("synthesized_hashes", {})
    chunks = index.get("chunks", [])

    # Gather all indexable files: conversations + sources (group + global)
    md_files = sorted(conversations_dir.glob("*.md")) if has_conversations else []
    source_files: List[Path] = []
    for sdir in [sources_dir, global_sources_dir]:
        if sdir.exists():
            source_files.extend(sorted(sdir.glob("*.md")))

    if not md_files and not source_files:
        print("No conversation or source files found.")
        return

    new_files_count = 0
    new_chunks = 0
    skipped_dupes = 0
    newly_indexed: List[Tuple[Path, str]] = []  # (path, date) for synthesis

    # Build content hash set from existing chunks (excluding knowledge/notebook sources)
    seen_hashes: set = set()
    for c in chunks:
        if c.get("source") in ("knowledge", "notebook"):
            continue
        text = c.get("full_text", c.get("text", ""))
        seen_hashes.add(content_hash(text))

    # --- Phase 1: Vector indexing ---
    for md_file in md_files:
        fhash = file_hash(md_file)
        fname = md_file.name

        if existing_hashes.get(fname) == fhash:
            continue  # unchanged

        print(f"Indexing {fname}...", end=" ", flush=True)

        # Remove old chunks for this file (and their hashes)
        old_chunks = [c for c in chunks if c["file"] == fname]
        for c in old_chunks:
            text = c.get("full_text", c.get("text", ""))
            seen_hashes.discard(content_hash(text))
        chunks = [c for c in chunks if c["file"] != fname]

        text = md_file.read_text(encoding="utf-8", errors="replace")
        # Extract date from filename e.g. 2026-03-20-conversation-*.md
        date_match = re.match(r"(\d{4}-\d{2}-\d{2})", fname)
        date = date_match.group(1) if date_match else datetime.now(timezone.utc).strftime("%Y-%m-%d")

        file_chunks = chunk_text(text)
        file_dupes = 0
        for i, chunk in enumerate(file_chunks):
            chash = content_hash(chunk)
            if chash in seen_hashes:
                file_dupes += 1
                skipped_dupes += 1
                continue
            try:
                vector = embed(chunk)
            except Exception as e:
                print(f"\nEmbedding failed for {fname} chunk {i}: {e}", file=sys.stderr)
                continue
            seen_hashes.add(chash)
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
        dupe_note = f" ({file_dupes} dupes skipped)" if file_dupes else ""
        print(f"{len(file_chunks)} chunks, {len(file_chunks) - file_dupes} unique{dupe_note}")

    # --- Phase 1b: Index source files (notebook entries) ---
    # Sources are curated knowledge — no synthesis needed, tagged as "notebook".
    new_source_chunks = 0
    for src_file in source_files:
        fhash = file_hash(src_file)
        # Use full path relative to base as key to avoid collisions with conversation filenames
        fkey = f"src:{src_file.name}"

        if existing_hashes.get(fkey) == fhash:
            continue

        print(f"Indexing source {src_file.name}...", end=" ", flush=True)

        # Remove old chunks for this source file
        chunks = [c for c in chunks if c.get("_fkey") != fkey]

        text = src_file.read_text(encoding="utf-8", errors="replace")
        date_match = re.match(r"notebook-(\d{4}-\d{2}-\d{2})", src_file.name)
        date = date_match.group(1) if date_match else datetime.now(timezone.utc).strftime("%Y-%m-%d")

        file_chunks = chunk_text(text)
        for i, chunk_text_item in enumerate(file_chunks):
            chash = content_hash(chunk_text_item)
            if chash in seen_hashes:
                continue
            try:
                vector = embed(chunk_text_item)
            except Exception as e:
                print(f"\nEmbedding failed for {src_file.name} chunk {i}: {e}", file=sys.stderr)
                continue
            seen_hashes.add(chash)
            chunks.append({
                "file": src_file.name,
                "_fkey": fkey,
                "date": date,
                "chunk_index": i,
                "text": chunk_text_item[:500],
                "full_text": chunk_text_item,
                "vector": vector,
                "source": "notebook",
            })
            new_source_chunks += 1

        existing_hashes[fkey] = fhash
        print(f"{len(file_chunks)} chunks")

    if new_source_chunks:
        print(f"Sources: {new_source_chunks} new chunks indexed")

    index["chunks"] = chunks
    index["file_hashes"] = existing_hashes
    index["synthesized_hashes"] = synthesized_hashes
    index["updated_at"] = datetime.now(timezone.utc).isoformat()
    index["group"] = args.group

    atomic_json_write(index_file, index)

    dupe_msg = f", {skipped_dupes} duplicates skipped" if skipped_dupes else ""
    total_new = new_chunks + new_source_chunks
    print(f"\nDone. {new_files_count} files indexed, {total_new} new chunks{dupe_msg}. Total: {len(chunks)} chunks.")
    print(f"Index saved to {index_file}")

    # --- Phase 2: Synthesis ---
    # Retry any previously failed synthesis first
    pending = load_pending(pending_file)
    retry_files: List[Tuple[Path, str]] = []
    if pending:
        print(f"\nRetrying {len(pending)} pending synthesis file(s)...")
        retry_files = [(Path(p), d) for p, d in pending]

    # If synthesis was never run (e.g. added after initial indexing), queue all files
    if not synthesized_hashes and not retry_files and not newly_indexed and md_files:
        print(f"\nNo synthesis history found — queuing all {len(md_files)} file(s) for first synthesis...")
        for md_file in md_files:
            date_match = re.match(r"(\d{4}-\d{2}-\d{2})", md_file.name)
            date = date_match.group(1) if date_match else datetime.now(timezone.utc).strftime("%Y-%m-%d")
            newly_indexed.append((md_file, date))

    to_synthesize = retry_files + newly_indexed
    if to_synthesize:
        print(f"\nSynthesis pass ({len(to_synthesize)} file(s))...")
        run_synthesis(to_synthesize, knowledge_file, pending_file, synthesized_hashes)
        # Persist updated synthesized_hashes immediately after synthesis
        index["synthesized_hashes"] = synthesized_hashes
        with open(index_file, "w") as f:
            json.dump(index, f)
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
                    "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
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
            index["synthesized_hashes"] = synthesized_hashes
            index["updated_at"] = datetime.now(timezone.utc).isoformat()
            with open(index_file, "w") as f:
                json.dump(index, f)
        else:
            print("knowledge.md unchanged, skipping.")


if __name__ == "__main__":
    main()
