#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Run E2E tests and generate JUnit XML + HTML reports
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Running UBR NMS E2E Tests ==="

cd "$E2E_DIR"
pip install -q -e ".[dev]" 2>/dev/null || pip install -q pytest pytest-asyncio pytest-timeout httpx anyio

python -m pytest tests/ \
  -v \
  --tb=short \
  --junit-xml=reports/e2e-results.xml \
  --html=reports/e2e-report.html \
  --self-contained-html \
  -m "${TEST_MARKERS:-alarm or auth or onboarding or kpi or config or slo}" \
  "$@"

EXIT_CODE=$?

echo ""
echo "=== E2E Test Results ==="
if [ $EXIT_CODE -eq 0 ]; then
  echo "PASS — All E2E tests passed"
else
  echo "FAIL — One or more E2E tests failed (exit code: $EXIT_CODE)"
fi
echo "Reports: reports/e2e-results.xml (JUnit), reports/e2e-report.html (HTML)"

exit $EXIT_CODE
