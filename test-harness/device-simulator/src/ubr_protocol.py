"""
UBR southbound protocol helpers for device simulation (WO-035).

Implements the Auth-Info / Auth-Signature HMAC protocol from WO-015, Consul-style
KV service-registry decoding, nonce generation, and signed-request header construction.

SECURITY: This module never logs, prints, or exposes HMAC secrets, private keys,
or certificate material. Only redacted device identity and correlation fields
appear in structured log output.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import string
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

log = logging.getLogger(__name__)

_NONCE_CHARSET = string.ascii_letters + string.digits
_NONCE_LENGTH = 30
_TIMESTAMP_FRESHNESS_SECONDS = 300  # 5-minute window matching server-side tolerance


# ── Nonce generation ──────────────────────────────────────────────────────────

def generate_nonce(length: int = _NONCE_LENGTH) -> str:
    """Generate a cryptographically random alphanumeric nonce of the given length."""
    return "".join(secrets.choice(_NONCE_CHARSET) for _ in range(length))


# ── Auth-Info header construction ─────────────────────────────────────────────

def build_auth_info(mac_address: str, timestamp: Optional[int] = None,
                    nonce: Optional[str] = None) -> str:
    """
    Build the Auth-Info header value per the WO-015 spec.

    Format: ``id=<mac-addr>,timestamp=<unix-time>,nonce=<nonce>``

    :param mac_address: Device MAC address (used as the identity token).
    :param timestamp:   Unix epoch seconds; defaults to current time.
    :param nonce:       30-character random string; generated if omitted.
    :returns:           Auth-Info header string.
    """
    ts = timestamp if timestamp is not None else int(time.time())
    n = nonce if nonce is not None else generate_nonce()
    return f"id={mac_address},timestamp={ts},nonce={n}"


def is_timestamp_fresh(auth_info: str) -> bool:
    """
    Validates that the timestamp embedded in an Auth-Info value is within
    the freshness window. Used by negative-case test fixtures to simulate
    stale-timestamp rejection.
    """
    m = re.search(r"timestamp=(\d+)", auth_info)
    if not m:
        return False
    ts = int(m.group(1))
    return abs(time.time() - ts) <= _TIMESTAMP_FRESHNESS_SECONDS


# ── HMAC-SHA256 signature ─────────────────────────────────────────────────────

def compute_auth_signature(secret: str, auth_info: str, path: str,
                           body: bytes = b"") -> str:
    """
    Compute the Auth-Signature over the WO-015 canonical message:
    ``Auth-Info_value + "\\n" + request_path + "\\n" + raw_body_bytes``

    :param secret:    HMAC secret for this device (never logged).
    :param auth_info: The Auth-Info header value for this request.
    :param path:      HTTP request path (e.g. /api/v1/discovery/check-in).
    :param body:      Raw request body bytes.
    :returns:         Lowercase hex-encoded HMAC-SHA256 digest.
    """
    mac = hmac.new(secret.encode(), digestmod=hashlib.sha256)
    mac.update(auth_info.encode())
    mac.update(b"\n")
    mac.update(path.encode())
    mac.update(b"\n")
    mac.update(body)
    return mac.hexdigest()


def build_signed_headers(secret: str, mac_address: str, path: str,
                         body: bytes = b"",
                         timestamp: Optional[int] = None,
                         nonce: Optional[str] = None) -> Dict[str, str]:
    """
    Build the Auth-Info and Auth-Signature headers for a signed southbound request.

    :returns: Dict with ``Auth-Info`` and ``Auth-Signature`` keys ready for HTTP headers.
    """
    auth_info = build_auth_info(mac_address, timestamp=timestamp, nonce=nonce)
    signature = compute_auth_signature(secret, auth_info, path, body)
    # Log the redacted identity only — never the secret or signature material.
    log.debug("Signing request: mac=[redacted] path=%s", path)
    return {
        "Auth-Info": auth_info,
        "Auth-Signature": signature,
    }


# ── Consul-style KV registry decoding ────────────────────────────────────────

@dataclass
class ServiceRegistry:
    """Decoded southbound service locations from the discovery KV registry."""
    auth_url:     Optional[str] = None
    checkin_url:  Optional[str] = None
    event_url:    Optional[str] = None
    realtime_url: Optional[str] = None

    def is_complete(self) -> bool:
        """Returns True when all four service endpoints have been decoded."""
        return all([self.auth_url, self.checkin_url, self.event_url, self.realtime_url])


def decode_kv_registry(kv_response: list) -> ServiceRegistry:
    """
    Decode a Consul-style KV response into a ServiceRegistry.

    Each entry is expected to have the form:
    ``{"Key": "services/<name>", "Value": "<base64-encoded-json>"}``

    Malformed entries (missing keys, invalid base64, non-JSON values, unsupported
    schemes) are logged at WARNING level and skipped without crashing the decoder.

    :param kv_response: Parsed list from the discovery KV endpoint.
    :returns:           ServiceRegistry with decoded endpoints.
    """
    registry = ServiceRegistry()

    if not isinstance(kv_response, list):
        log.warning("KV registry response is not a list: type=%s", type(kv_response).__name__)
        return registry

    for entry in kv_response:
        if not isinstance(entry, dict):
            log.warning("KV entry is not a dict — skipping")
            continue
        key = entry.get("Key", "")
        raw_value = entry.get("Value")
        if not raw_value:
            log.warning("KV entry missing Value: key=%s", key)
            continue

        try:
            decoded_bytes = base64.b64decode(raw_value)
            metadata = json.loads(decoded_bytes)
        except (ValueError, json.JSONDecodeError) as exc:
            log.warning("KV entry decode failed: key=%s error=%s", key, exc)
            continue

        url = metadata.get("url", "")
        if not isinstance(url, str) or not re.match(r"^https?://|^wss?://", url):
            log.warning("KV entry has unsupported or missing URL scheme: key=%s", key)
            continue

        service_name = key.split("/")[-1].lower() if "/" in key else key.lower()
        if "auth" in service_name:
            registry.auth_url = url
        elif "checkin" in service_name or "check-in" in service_name:
            registry.checkin_url = url
        elif "event" in service_name:
            registry.event_url = url
        elif "realtime" in service_name or "websocket" in service_name or "wss" in service_name:
            registry.realtime_url = url
        else:
            log.debug("KV entry key not mapped to a known service: key=%s", key)

    return registry


def make_kv_entry(service_name: str, url: str) -> dict:
    """
    Build a single Consul-style KV entry for test fixtures.
    Encodes the url in the expected base64(JSON) format.
    """
    metadata_json = json.dumps({"url": url}).encode()
    return {
        "Key": f"services/{service_name}",
        "Value": base64.b64encode(metadata_json).decode(),
        "Flags": 0,
    }


# ── Retry helpers ─────────────────────────────────────────────────────────────

_DEFAULT_RETRY_SECONDS = 30
_DEFAULT_JITTER_MAX = 10


def parse_retry_headers(headers: Dict[str, str]) -> Tuple[int, int]:
    """
    Extract Retry-After and X-Retry-Jitter-Max from response headers.
    Falls back to documented defaults when headers are missing (WO-029 behaviour).

    :returns: (retry_after_seconds, jitter_max_seconds)
    """
    try:
        retry_after = int(headers.get("Retry-After", _DEFAULT_RETRY_SECONDS))
    except (ValueError, TypeError):
        retry_after = _DEFAULT_RETRY_SECONDS
        log.warning("Invalid Retry-After header — using default=%ds", retry_after)

    try:
        jitter_max = int(headers.get("X-Retry-Jitter-Max", _DEFAULT_JITTER_MAX))
    except (ValueError, TypeError):
        jitter_max = _DEFAULT_JITTER_MAX
        log.warning("Invalid X-Retry-Jitter-Max header — using default=%ds", jitter_max)

    return retry_after, jitter_max
