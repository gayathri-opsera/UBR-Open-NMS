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
echo "⏳  Checking MongoDB at ${MONGO_URL} ..."

# Try mongosh first, fall back to docker exec
if command -v mongosh &>/dev/null; then
  for i in $(seq 1 30); do
    if mongosh --quiet --eval "db.adminCommand('ping').ok" "$MONGO_URL" 2>/dev/null | grep -q "1"; then
      echo "✓  MongoDB is up"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "❌  MongoDB did not become ready after 30s."
      exit 1
    fi
    sleep 1
  done
elif docker ps --filter "name=nms-mongo" --filter "status=running" -q 2>/dev/null | grep -q .; then
  echo "✓  MongoDB container (nms-mongo) is running"
else
  echo "⚠️  mongosh not found — assuming MongoDB is reachable and proceeding..."
fi

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
