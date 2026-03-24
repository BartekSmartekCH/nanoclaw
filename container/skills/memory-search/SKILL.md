# Skill: Memory Search

Semantic search over past conversation archives. Use this when you need to recall something from a previous session that is no longer in your active context.

## When to use

- User asks "do you remember when we discussed X?"
- You need context from a past conversation to answer correctly
- You want to check if something was already decided or built previously

## How to use

### From inside a container

```bash
# Search
python3 /home/node/.claude/skills/memory-search/search.py --group telegram_main "your query"

# Re-index (if new conversations exist)
python3 /home/node/.claude/skills/memory-search/indexer.py --group telegram_main
```

### From outside a container (CoderBot)

```bash
# Search
python3 /Users/tataadmin/nanoclaw/container/skills/memory-search/search.py --group telegram_main "your query"

# Re-index
python3 /Users/tataadmin/nanoclaw/container/skills/memory-search/indexer.py --group telegram_main
```

## Reading results

Each result shows:
- **Date** — which conversation file it came from
- **Score** — relevance (0–1, higher is better). Scores above 0.7 are strong matches.
- **Text** — the relevant passage

Use the top 2–3 results. Ignore results with score below 0.4.

## Notes

- Index is rebuilt weekly by the scheduler. If a very recent conversation isn't found, run the indexer manually.
- The index lives at `groups/{name}/memory-index/index.json` — never edit it manually.
- Requires `nomic-embed-text` model in Ollama.
