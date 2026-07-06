#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# UBR NMS E2E Test Environment Setup Script
# Starts all required test infrastructure before running E2E tests.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== UBR NMS E2E Test Setup ==="

# 1. Start OSS stubs
echo "Starting OSS/BSS stubs..."
docker run -d \
  --name ubrnms-oss-stubs \
  --rm \
  -p 8080:8080 \
  -e STUB_LOG_LEVEL=info \
  ubrnms/oss-stubs:latest || echo "Stubs already running"

# 2. Start device simulator (small-10 profile)
echo "Starting device fleet simulator..."
docker run -d \
  --name ubrnms-device-simulator \
  --rm \
  -e SIMULATOR_PROFILE=profiles/small-10.yaml \
  -e DISCOVERY_URL="${DISCOVERY_URL:-http://discovery-service:8080}" \
  -e EVENT_COLLECTOR_HOST="${EVENT_COLLECTOR_HOST:-event-collector}" \
  ubrnms/device-simulator:latest || echo "Simulator already running"

# 3. Wait for all NMS services to be healthy
echo "Waiting for NMS services..."
services=(
  "${AUTH_URL:-http://localhost:3000}/healthz"
  "${ALARM_URL:-http://localhost:8081}/healthz"
  "${INVENTORY_URL:-http://localhost:8082}/healthz"
  "${STUBS_URL:-http://localhost:8080}/healthz"
)

for url in "${services[@]}"; do
  echo -n "  Checking $url ... "
  for i in $(seq 1 30); do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo "OK"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "TIMEOUT (service may not be running)"
    fi
    sleep 2
  done
done

# 4. Reset all stubs to clean state
echo "Resetting stubs..."
STUBS_URL="${STUBS_URL:-http://localhost:8080}"
for stub in netcool mycom mobinet syslog; do
  curl -sf -X DELETE "$STUBS_URL/api/v1/stub/$stub/messages" > /dev/null || true
done

echo "=== Setup complete ==="
