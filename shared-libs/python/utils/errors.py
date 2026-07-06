"""Standardized API error response for UBR NMS Python services."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ErrorBody:
    code: str
    message: str


@dataclass
class ApiErrorResponse:
    """Standard error shape: {status: 'error', error: {code, message}}"""
    status: str = "error"
    error: Optional[ErrorBody] = None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "error": {
                "code": self.error.code if self.error else "UNKNOWN",
                "message": self.error.message if self.error else "",
            },
        }

    @classmethod
    def not_found(cls, resource: str = "Resource") -> "ApiErrorResponse":
        return cls(error=ErrorBody("NOT_FOUND", f"{resource} not found"))

    @classmethod
    def forbidden(cls, message: str = "Access denied") -> "ApiErrorResponse":
        return cls(error=ErrorBody("FORBIDDEN", message))

    @classmethod
    def unauthorized(cls, message: str = "Unauthorized") -> "ApiErrorResponse":
        return cls(error=ErrorBody("UNAUTHORIZED", message))

    @classmethod
    def conflict(cls, message: str) -> "ApiErrorResponse":
        return cls(error=ErrorBody("CONFLICT", message))

    @classmethod
    def validation(cls, message: str) -> "ApiErrorResponse":
        return cls(error=ErrorBody("VALIDATION_ERROR", message))

    @classmethod
    def service_unavailable(cls, message: str = "Service temporarily unavailable") -> "ApiErrorResponse":
        return cls(error=ErrorBody("SERVICE_UNAVAILABLE", message))

    @classmethod
    def internal(cls, message: str = "Internal server error") -> "ApiErrorResponse":
        return cls(error=ErrorBody("INTERNAL_ERROR", message))
