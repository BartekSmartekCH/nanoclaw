#!/usr/bin/env bash
# Run memory indexer for all active groups directly on the host.
# Bypasses the container/Claude pipeline — just Python + Ollama.
#
# Usage:
#   memory-reindex.sh              # all active groups
#   memory-reindex.sh telegram_main  # single group

set -euo pipefail

BASE="/Users/tataadmin/nanoclaw"
INDEXER="$BASE/container/skills/memory-search/indexer.py"
LOG_DIR="$BASE/store/reindex-logs"
PYTHON="/usr/bin/env python3"

mkdir -p "$LOG_DIR"

# Groups to reindex (only those with conversations/ directories)
if [ $# -ge 1 ]; then
  TARGETS=("$@")
else
  TARGETS=()
  for d in "$BASE"/groups/*/conversations; do
    [ -d "$d" ] && TARGETS+=("$(basename "$(dirname "$d")")")
  done
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "No groups with conversations/ found."
  exit 0
fi

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
LOGFILE="$LOG_DIR/reindex-$TIMESTAMP.log"

echo "[$TIMESTAMP] Memory reindex starting for: ${TARGETS[*]}" | tee "$LOGFILE"

ERRORS=0
for group in "${TARGETS[@]}"; do
  echo "" | tee -a "$LOGFILE"
  echo "=== $group ===" | tee -a "$LOGFILE"
  if $PYTHON "$INDEXER" --group "$group" --base "$BASE" >> "$LOGFILE" 2>&1; then
    echo "  OK" | tee -a "$LOGFILE"
  else
    echo "  FAILED (exit $?)" | tee -a "$LOGFILE"
    ERRORS=$((ERRORS + 1))
  fi
done

# Merge all knowledge.md files into groups/global/knowledge.md
GLOBAL_KNOWLEDGE="$BASE/groups/global/knowledge.md"
echo "" | tee -a "$LOGFILE"
echo "=== Merging knowledge.md into global ===" | tee -a "$LOGFILE"
: > "$GLOBAL_KNOWLEDGE"
for kf in "$BASE"/groups/*/knowledge.md; do
  [ -f "$kf" ] || continue
  GROUP_NAME=$(basename "$(dirname "$kf")")
  [ "$GROUP_NAME" = "global" ] && continue
  echo "# $GROUP_NAME" >> "$GLOBAL_KNOWLEDGE"
  echo "" >> "$GLOBAL_KNOWLEDGE"
  cat "$kf" >> "$GLOBAL_KNOWLEDGE"
  echo "" >> "$GLOBAL_KNOWLEDGE"
  echo "---" >> "$GLOBAL_KNOWLEDGE"
  echo "" >> "$GLOBAL_KNOWLEDGE"
done
echo "  Written to $GLOBAL_KNOWLEDGE" | tee -a "$LOGFILE"

echo "" | tee -a "$LOGFILE"
echo "[$TIMESTAMP] Done. Errors: $ERRORS" | tee -a "$LOGFILE"

# Prune old logs (keep last 30)
ls -t "$LOG_DIR"/reindex-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

exit $ERRORS
