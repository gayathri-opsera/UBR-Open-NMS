"""Structured JSON logger with correlation ID support for UBR NMS Python services."""
from __future__ import annotations

import json
import logging
import os
import sys
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Optional

_correlation_id: ContextVar[Optional[str]] = ContextVar("correlation_id", default=None)


def set_correlation_id(value: str) -> None:
    """Set the correlation ID for the current async context."""
    _correlation_id.set(value)


def get_correlation_id() -> Optional[str]:
    return _correlation_id.get()


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_data: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "message": record.getMessage(),
            "logger": record.name,
        }
        cid = get_correlation_id()
        if cid:
            log_data["correlationId"] = cid
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        extra = {k: v for k, v in record.__dict__.items()
                 if k not in logging.LogRecord.__dict__ and k not in log_data}
        if extra:
            log_data.update(extra)
        return json.dumps(log_data)


def get_logger(name: str) -> logging.Logger:
    """Return a logger configured with JSON output."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
        level = os.getenv("LOG_LEVEL", "INFO").upper()
        logger.setLevel(getattr(logging, level, logging.INFO))
    return logger
