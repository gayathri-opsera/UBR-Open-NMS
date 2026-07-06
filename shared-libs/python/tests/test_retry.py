import pytest
import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.retry import retry


def test_success_first_attempt():
    calls = []

    @retry(max_attempts=3, base_delay=0.001)
    def fn():
        calls.append(1)
        return "ok"

    result = fn()
    assert result == "ok"
    assert len(calls) == 1


def test_retries_and_succeeds():
    calls = []

    @retry(max_attempts=3, base_delay=0.001)
    def fn():
        calls.append(1)
        if len(calls) < 3:
            raise ValueError("transient")
        return "done"

    result = fn()
    assert result == "done"
    assert len(calls) == 3


def test_exceeds_max_attempts():
    calls = []

    @retry(max_attempts=2, base_delay=0.001)
    def fn():
        calls.append(1)
        raise RuntimeError("always fails")

    with pytest.raises(RuntimeError):
        fn()
    assert len(calls) == 2


def test_should_retry_stops_early():
    calls = []

    @retry(max_attempts=3, base_delay=0.001, should_retry=lambda e, a: False)
    def fn():
        calls.append(1)
        raise ValueError("stop now")

    with pytest.raises(ValueError):
        fn()
    assert len(calls) == 1
