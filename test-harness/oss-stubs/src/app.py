"""
FastAPI application providing all OSS/BSS stub REST APIs for test assertions.

Each stub exposes:
  GET  /api/v1/stub/{name}/messages  — list received messages
  DELETE /api/v1/stub/{name}/messages — reset (clear) stored messages

Additional stubs:
  GET  /api/v1/stub/gis/tiles/{z}/{x}/{y}.png — mock GIS tile
  POST /api/v1/stub/syslog — syslog receiver (used by integration tests)
"""
import json
import logging
from typing import List

from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.responses import JSONResponse, Response as FastAPIResponse

from stubs import (
    StubStore,
    validate_netcool, validate_mycom, validate_mobinet, validate_syslog_rfc5424,
    build_gis_tile_response,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="UBR NMS OSS/BSS Stubs", version="1.0.0")

# ── Stub stores ────────────────────────────────────────────────────────────────

STORES: dict[str, StubStore] = {
    "netcool": StubStore("netcool"),
    "mycom":   StubStore("mycom"),
    "mobinet": StubStore("mobinet"),
    "syslog":  StubStore("syslog"),
}

VALIDATORS = {
    "netcool": validate_netcool,
    "mycom":   validate_mycom,
    "mobinet": validate_mobinet,
}


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/healthz")
def health():
    return {"status": "ok"}


# ── Generic stub assertion API ─────────────────────────────────────────────────

@app.get("/api/v1/stub/{name}/messages")
def get_messages(name: str):
    if name not in STORES:
        raise HTTPException(404, f"Unknown stub: {name}")
    store = STORES[name]
    return {"stub": name, "count": store.count(), "messages": store.all()}


@app.delete("/api/v1/stub/{name}/messages")
def reset_messages(name: str):
    if name not in STORES:
        raise HTTPException(404, f"Unknown stub: {name}")
    STORES[name].reset()
    return {"stub": name, "status": "cleared"}


# ── Kafka-based stub ingest (called from Kafka consumer task) ──────────────────

def ingest_kafka_message(stub_name: str, payload: bytes) -> dict:
    """Parse and validate a raw Kafka message payload for the given stub."""
    try:
        msg = json.loads(payload)
    except Exception as e:
        log.warning("Failed to parse message for %s: %s", stub_name, e)
        store_entry = {"raw": payload.decode(errors="replace"), "valid": False, "errors": [str(e)]}
        STORES[stub_name].add(store_entry)
        return store_entry

    errors = VALIDATORS.get(stub_name, lambda m: [])(msg)
    store_entry = {"message": msg, "valid": not errors, "errors": errors}
    STORES[stub_name].add(store_entry)
    return store_entry


# ── Syslog stub (HTTP endpoint for integration tests) ─────────────────────────

@app.post("/api/v1/stub/syslog")
async def receive_syslog(request: Request):
    body = await request.body()
    line = body.decode(errors="replace").strip()
    errors = validate_syslog_rfc5424(line)
    entry = {"line": line, "valid": not errors, "errors": errors}
    STORES["syslog"].add(entry)
    return {"valid": not errors, "errors": errors}


# ── GIS stub ──────────────────────────────────────────────────────────────────

@app.get("/api/v1/stub/gis/tiles/{z}/{x}/{y}.png")
def gis_tile(z: int, x: int, y: int):
    tile_bytes = build_gis_tile_response(z, x, y)
    return FastAPIResponse(content=tile_bytes, media_type="image/png")
