#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# UBR Open NMS — Database Seed Runner
# Usage:
#   ./scripts/seed.sh          # seed (skip if already exists)
#   ./scripts/seed.sh --reset  # drop all NMS collections then re-seed
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ── 1. Ensure MongoDB is reachable ──────────────────────────────────────────
MONGO_URL="${MONGO_URL:-mongodb://localhost:27017}"
echo "⏳  Waiting for MongoDB at ${MONGO_URL} ..."
for i in $(seq 1 30); do
  if mongosh --quiet --eval "db.adminCommand('ping').ok" "$MONGO_URL" 2>/dev/null | grep -q "1"; then
    echo "✓  MongoDB is up"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "❌  MongoDB did not become ready after 30s."
    echo "    Make sure to run:  docker compose -f docker-compose.dev.yml up -d mongo"
    exit 1
  fi
  sleep 1
done

# ── 2. Install script deps if needed ────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦  Installing seed script dependencies..."
  cd "$SCRIPT_DIR" && npm install --silent
fi

# ── 3. Run the seed script ──────────────────────────────────────────────────
echo ""
cd "$SCRIPT_DIR"
if [[ "${1:-}" == "--reset" ]]; then
  MONGO_URL="$MONGO_URL" node seed.js --reset
else
  MONGO_URL="$MONGO_URL" node seed.js
fi
