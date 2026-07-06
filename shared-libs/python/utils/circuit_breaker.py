"""Circuit breaker decorator with exponential backoff for Python services."""
from __future__ import annotations

import asyncio
import functools
import time
from enum import Enum
from typing import Any, Callable, Optional


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreaker:
    """
    Simple circuit breaker that tracks consecutive failures.
    Transitions: CLOSED → OPEN (on failure_threshold failures)
                 OPEN → HALF_OPEN (after reset_timeout seconds)
                 HALF_OPEN → CLOSED (on success)
                 HALF_OPEN → OPEN (on failure)
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        reset_timeout: float = 30.0,
        name: str = "default",
    ):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.name = name
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._opened_at: Optional[float] = None

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if self._opened_at and time.monotonic() - self._opened_at >= self.reset_timeout:
                self._state = CircuitState.HALF_OPEN
        return self._state

    def _on_success(self) -> None:
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self._opened_at = None

    def _on_failure(self) -> None:
        self._failure_count += 1
        if self._state == CircuitState.HALF_OPEN or self._failure_count >= self.failure_threshold:
            self._state = CircuitState.OPEN
            self._opened_at = time.monotonic()

    def __call__(self, fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            if self.state == CircuitState.OPEN:
                raise RuntimeError(f"Circuit '{self.name}' is OPEN")
            try:
                result = await fn(*args, **kwargs)
                self._on_success()
                return result
            except Exception as e:
                self._on_failure()
                raise e

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            if self.state == CircuitState.OPEN:
                raise RuntimeError(f"Circuit '{self.name}' is OPEN")
            try:
                result = fn(*args, **kwargs)
                self._on_success()
                return result
            except Exception as e:
                self._on_failure()
                raise e

        if asyncio.iscoroutinefunction(fn):
            return async_wrapper
        return sync_wrapper
