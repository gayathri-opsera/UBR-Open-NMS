"""Retry decorator with exponential backoff for Python services."""
from __future__ import annotations

import asyncio
import functools
import time
from typing import Callable, Optional, Type, Tuple


def retry(
    max_attempts: int = 3,
    base_delay: float = 0.1,
    max_delay: float = 5.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
    should_retry: Optional[Callable[[Exception, int], bool]] = None,
):
    """
    Decorator factory that retries a function with exponential backoff.

    Args:
        max_attempts: Maximum number of attempts (including the first call).
        base_delay: Initial delay in seconds.
        max_delay: Maximum delay cap in seconds.
        exceptions: Tuple of exception types to catch and retry on.
        should_retry: Optional callable(exc, attempt) → bool. Return False to stop.
    """
    def decorator(fn: Callable) -> Callable:
        if asyncio.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args, **kwargs):
                last_exc = None
                for attempt in range(1, max_attempts + 1):
                    try:
                        return await fn(*args, **kwargs)
                    except exceptions as e:
                        last_exc = e
                        if attempt == max_attempts:
                            raise
                        if should_retry and not should_retry(e, attempt):
                            raise
                        delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
                        await asyncio.sleep(delay)
                raise last_exc
            return async_wrapper
        else:
            @functools.wraps(fn)
            def sync_wrapper(*args, **kwargs):
                last_exc = None
                for attempt in range(1, max_attempts + 1):
                    try:
                        return fn(*args, **kwargs)
                    except exceptions as e:
                        last_exc = e
                        if attempt == max_attempts:
                            raise
                        if should_retry and not should_retry(e, attempt):
                            raise
                        delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
                        time.sleep(delay)
                raise last_exc
            return sync_wrapper
    return decorator
