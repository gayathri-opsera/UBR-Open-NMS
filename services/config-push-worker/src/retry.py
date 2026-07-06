"""Retry helper with exponential backoff."""
import asyncio
import logging
from typing import Callable, Awaitable, TypeVar

T = TypeVar("T")
log = logging.getLogger(__name__)


async def retry_async(
    func: Callable[[], Awaitable[T]],
    attempts: int = 3,
    base_delay: float = 5.0,
    label: str = "",
) -> T:
    """Execute *func* up to *attempts* times with exponential backoff."""
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await func()
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < attempts:
                delay = base_delay * (2 ** (attempt - 1))
                log.warning("Attempt %d/%d failed for %s: %s — retrying in %.1fs",
                            attempt, attempts, label, exc, delay)
                await asyncio.sleep(delay)
            else:
                log.error("All %d attempts failed for %s: %s", attempts, label, exc)
    raise last_exc  # type: ignore[misc]
