package com.ubrnms.shared.utils;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * Thread-safe circuit breaker for Java services.
 *
 * States: CLOSED → OPEN (after failureThreshold consecutive failures)
 *         OPEN → HALF_OPEN (after resetTimeoutMs elapses)
 *         HALF_OPEN → CLOSED (on success) / OPEN (on failure)
 */
public class CircuitBreaker {

    public enum State { CLOSED, OPEN, HALF_OPEN }

    private final String name;
    private final int failureThreshold;
    private final long resetTimeoutMs;

    private final AtomicReference<State> state = new AtomicReference<>(State.CLOSED);
    private final AtomicInteger failureCount = new AtomicInteger(0);
    private volatile Instant openedAt = null;

    public CircuitBreaker(String name, int failureThreshold, long resetTimeoutMs) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
    }

    public State getState() {
        if (state.get() == State.OPEN) {
            Instant opened = openedAt;
            if (opened != null && Instant.now().toEpochMilli() - opened.toEpochMilli() >= resetTimeoutMs) {
                state.compareAndSet(State.OPEN, State.HALF_OPEN);
            }
        }
        return state.get();
    }

    public <T> T execute(Supplier<T> supplier) {
        if (getState() == State.OPEN) {
            throw new IllegalStateException("Circuit '" + name + "' is OPEN");
        }
        try {
            T result = supplier.get();
            onSuccess();
            return result;
        } catch (Exception e) {
            onFailure();
            throw e;
        }
    }

    private void onSuccess() {
        failureCount.set(0);
        state.set(State.CLOSED);
        openedAt = null;
    }

    private void onFailure() {
        int count = failureCount.incrementAndGet();
        if (state.get() == State.HALF_OPEN || count >= failureThreshold) {
            state.set(State.OPEN);
            openedAt = Instant.now();
        }
    }

    public String getName() { return name; }
}
