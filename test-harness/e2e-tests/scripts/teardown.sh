#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# UBR NMS E2E Test Teardown Script
# Stops test infrastructure after E2E tests complete.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== UBR NMS E2E Test Teardown ==="

docker stop ubrnms-oss-stubs 2>/dev/null || true
docker stop ubrnms-device-simulator 2>/dev/null || true

echo "=== Teardown complete ==="
