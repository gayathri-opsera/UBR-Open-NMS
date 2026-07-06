package com.ubrnms.shared.utils;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CircuitBreakerTest {

    @Test
    void testClosedStateAllowsCalls() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, 30000);
        String result = cb.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    void testOpensAfterThreshold() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, 30000);
        for (int i = 0; i < 3; i++) {
            assertThrows(RuntimeException.class, () ->
                cb.execute(() -> { throw new RuntimeException("fail"); })
            );
        }
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
    }

    @Test
    void testOpenRejectsCalls() {
        CircuitBreaker cb = new CircuitBreaker("test", 2, 60000);
        for (int i = 0; i < 2; i++) {
            assertThrows(RuntimeException.class, () ->
                cb.execute(() -> { throw new RuntimeException("fail"); })
            );
        }
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
            cb.execute(() -> "should not reach")
        );
        assertTrue(ex.getMessage().contains("OPEN"));
    }

    @Test
    void testSuccessResetFailures() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, 30000);
        // Trigger 2 failures (below threshold, circuit still CLOSED)
        for (int i = 0; i < 2; i++) {
            assertThrows(RuntimeException.class, () ->
                cb.execute(() -> { throw new RuntimeException("fail"); })
            );
        }
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        // A success should reset the failure count
        String result = cb.execute(() -> "ok");
        assertEquals("ok", result);
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }
}
