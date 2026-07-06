import pytest
import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.circuit_breaker import CircuitBreaker, CircuitState


def test_closed_state_allows_calls():
    cb = CircuitBreaker(failure_threshold=3, reset_timeout=30)

    @cb
    def fn():
        return "ok"

    assert fn() == "ok"
    assert cb.state == CircuitState.CLOSED


def test_opens_after_threshold():
    cb = CircuitBreaker(failure_threshold=3, reset_timeout=30)

    @cb
    def fn():
        raise RuntimeError("fail")

    for _ in range(3):
        with pytest.raises(RuntimeError):
            fn()

    assert cb.state == CircuitState.OPEN


def test_open_rejects_calls():
    cb = CircuitBreaker(failure_threshold=2, reset_timeout=60)

    @cb
    def fn():
        raise RuntimeError("fail")

    for _ in range(2):
        with pytest.raises(RuntimeError):
            fn()

    with pytest.raises(RuntimeError, match="OPEN"):
        fn()


def test_success_resets_failures():
    cb = CircuitBreaker(failure_threshold=3, reset_timeout=30)
    cb._failure_count = 2

    @cb
    def fn():
        return "ok"

    fn()
    assert cb._failure_count == 0
    assert cb.state == CircuitState.CLOSED
