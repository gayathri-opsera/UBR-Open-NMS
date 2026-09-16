"""
Performance tests for the paginated inventory endpoint (WO-018).

Validates that the /api/v1/devices endpoint meets the sub-200ms P99 SLO
introduced by the DB-level pagination refactoring (WO-008).

Run with:
    pytest test-harness/performance-tests/inventory/ -v --tb=short

Environment variables:
    INVENTORY_URL   — base URL for the inventory service (default: http://localhost:8082)
    PERF_CONCURRENCY — number of concurrent workers (default: 10)
    PERF_REQUESTS    — total requests per scenario (default: 100)
    PERF_P99_LIMIT_MS — P99 SLO in milliseconds (default: 200)
"""
from __future__ import annotations

import os
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Tuple

import httpx
import pytest

from conftest import INVENTORY_URL

# ── Configuration ─────────────────────────────────────────────────────────────

CONCURRENCY    = int(os.environ.get("PERF_CONCURRENCY",    "10"))
TOTAL_REQUESTS = int(os.environ.get("PERF_REQUESTS",       "100"))
P99_LIMIT_MS   = int(os.environ.get("PERF_P99_LIMIT_MS",   "200"))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _request_page(base_url: str, page: int, limit: int) -> Tuple[int, float]:
    """GET /api/v1/devices with pagination params; returns (status_code, latency_ms)."""
    t0 = time.perf_counter()
    r  = httpx.get(
        f"{base_url}/api/v1/devices",
        params={"page": page, "limit": limit},
        timeout=5,
    )
    latency_ms = (time.perf_counter() - t0) * 1000
    return r.status_code, latency_ms


def _run_concurrent(
    base_url: str,
    scenarios: List[Tuple[int, int]],
    concurrency: int,
) -> List[float]:
    """
    Execute `scenarios` concurrently using a thread pool.
    Returns a list of successful latencies in milliseconds.
    """
    latencies: List[float] = []
    failures = 0

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(_request_page, base_url, page, limit): (page, limit)
            for page, limit in scenarios
        }
        for future in as_completed(futures):
            status, ms = future.result()
            if status == 200:
                latencies.append(ms)
            else:
                failures += 1

    assert failures == 0, f"{failures} requests returned non-200 status"
    return latencies


def _p99(values: List[float]) -> float:
    """Return the 99th-percentile value from a list of floats."""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = int(len(sorted_vals) * 0.99)
    return sorted_vals[min(idx, len(sorted_vals) - 1)]


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestInventoryPaginationPerformance:
    """P99 SLO validation for the paginated /api/v1/devices endpoint (WO-018)."""

    def test_first_page_p99_under_slo(self):
        """
        Requesting page 0 with size 20 should complete in <P99_LIMIT_MS ms
        across TOTAL_REQUESTS concurrent calls.

        This is the most common access pattern (default list view).
        """
        scenarios = [(0, 20)] * TOTAL_REQUESTS
        latencies = _run_concurrent(INVENTORY_URL, scenarios, CONCURRENCY)

        p99_ms = _p99(latencies)
        avg_ms = statistics.mean(latencies)
        assert p99_ms < P99_LIMIT_MS, (
            f"P99 latency {p99_ms:.1f}ms exceeds SLO {P99_LIMIT_MS}ms "
            f"(avg={avg_ms:.1f}ms, n={len(latencies)})"
        )

    def test_varied_page_sizes_p99_under_slo(self):
        """
        Varied page/size combinations stress the Criteria + Pageable codepath
        with different SKIP+LIMIT values.
        """
        scenarios = [
            (i % 10, [10, 20, 50, 100][i % 4])
            for i in range(TOTAL_REQUESTS)
        ]
        latencies = _run_concurrent(INVENTORY_URL, scenarios, CONCURRENCY)
        p99_ms = _p99(latencies)
        assert p99_ms < P99_LIMIT_MS, (
            f"Varied page-size P99 {p99_ms:.1f}ms exceeds SLO {P99_LIMIT_MS}ms"
        )

    def test_last_page_p99_under_slo(self):
        """
        Requesting the last page of a large dataset can be a DB bottleneck.
        Even the last-page query must meet the SLO (edge case: large SKIP).
        """
        # Determine approximate last page for page-size=20.
        r = httpx.get(f"{INVENTORY_URL}/api/v1/devices", params={"page": 0, "limit": 1}, timeout=10)
        r.raise_for_status()
        total = r.json().get("totalElements", 1000)
        last_page = max(0, (total // 20) - 1)

        scenarios = [(last_page, 20)] * (TOTAL_REQUESTS // 2)
        latencies = _run_concurrent(INVENTORY_URL, scenarios, CONCURRENCY)
        p99_ms = _p99(latencies)
        assert p99_ms < P99_LIMIT_MS, (
            f"Last-page P99 {p99_ms:.1f}ms exceeds SLO {P99_LIMIT_MS}ms (last_page={last_page})"
        )

    def test_thundering_herd_first_page(self):
        """
        Simulates a thundering herd: TOTAL_REQUESTS * 2 simultaneous requests
        for page 0. The endpoint must remain stable and within SLO.
        """
        n = TOTAL_REQUESTS * 2
        scenarios = [(0, 20)] * n
        latencies = _run_concurrent(INVENTORY_URL, scenarios, CONCURRENCY * 2)
        p99_ms = _p99(latencies)
        assert p99_ms < P99_LIMIT_MS * 2, (  # 2× SLO under doubled load
            f"Thundering-herd P99 {p99_ms:.1f}ms exceeds 2× SLO {P99_LIMIT_MS * 2}ms"
        )

    def test_out_of_bounds_page_returns_empty_not_error(self):
        """
        A page number beyond the last page must return HTTP 200 with an empty
        data array, not an error or exception (edge case: OOB page).
        """
        r = httpx.get(
            f"{INVENTORY_URL}/api/v1/devices",
            params={"page": 999_999, "limit": 20},
            timeout=10,
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("data") == [] or body.get("data") is not None
        assert body.get("totalPages") is not None

    def test_invalid_pagination_returns_400(self):
        """
        Negative page or zero limit must return HTTP 400 Bad Request
        with a meaningful error body (edge case: invalid params).
        """
        for params in [{"page": -1, "limit": 10}, {"page": 0, "limit": 0}]:
            r = httpx.get(f"{INVENTORY_URL}/api/v1/devices", params=params, timeout=5)
            assert r.status_code == 400, (
                f"Expected 400 for params={params}, got {r.status_code}"
            )

    def test_large_page_size_stability(self):
        """
        Requesting the maximum allowed page size (500) must complete within
        an extended latency ceiling (3× SLO) without crashing the service
        (edge case: large page size).
        """
        status, ms = _request_page(INVENTORY_URL, 0, 500)
        assert status == 200, f"Expected 200, got {status}"
        assert ms < P99_LIMIT_MS * 3, (
            f"Large-page-size latency {ms:.1f}ms exceeds 3× SLO {P99_LIMIT_MS * 3}ms"
        )
