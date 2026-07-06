import pytest
import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.errors import ApiErrorResponse


def test_not_found():
    e = ApiErrorResponse.not_found("Device")
    assert e.status == "error"
    assert e.error.code == "NOT_FOUND"
    assert "Device" in e.error.message


def test_forbidden():
    e = ApiErrorResponse.forbidden("no access")
    assert e.error.code == "FORBIDDEN"


def test_unauthorized():
    e = ApiErrorResponse.unauthorized()
    assert e.error.code == "UNAUTHORIZED"


def test_conflict():
    e = ApiErrorResponse.conflict("duplicate")
    assert e.error.code == "CONFLICT"


def test_validation():
    e = ApiErrorResponse.validation("bad field")
    assert e.error.code == "VALIDATION_ERROR"


def test_service_unavailable():
    e = ApiErrorResponse.service_unavailable()
    assert e.error.code == "SERVICE_UNAVAILABLE"


def test_to_dict():
    d = ApiErrorResponse.not_found("Alarm").to_dict()
    assert d["status"] == "error"
    assert d["error"]["code"] == "NOT_FOUND"
    assert isinstance(d["error"]["message"], str)
