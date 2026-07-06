package com.ubrnms.shared.utils;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RetryHelperTest {

    @Test
    void testSuccessFirstAttempt() throws Exception {
        int[] calls = {0};
        String result = RetryHelper.retry(() -> {
            calls[0]++;
            return "ok";
        }, RetryHelper.Options.defaults());
        assertEquals("ok", result);
        assertEquals(1, calls[0]);
    }

    @Test
    void testRetriesAndSucceeds() throws Exception {
        int[] calls = {0};
        String result = RetryHelper.retry(() -> {
            calls[0]++;
            if (calls[0] < 3) throw new RuntimeException("transient");
            return "done";
        }, new RetryHelper.Options(3, 1, 10, e -> true));
        assertEquals("done", result);
        assertEquals(3, calls[0]);
    }

    @Test
    void testExceedsMaxAttempts() {
        int[] calls = {0};
        assertThrows(RuntimeException.class, () ->
            RetryHelper.retry(() -> {
                calls[0]++;
                throw new RuntimeException("always fails");
            }, new RetryHelper.Options(2, 1, 10, e -> true))
        );
        assertEquals(2, calls[0]);
    }

    @Test
    void testShouldRetryStopsEarly() {
        int[] calls = {0};
        assertThrows(IllegalArgumentException.class, () ->
            RetryHelper.retry(() -> {
                calls[0]++;
                throw new IllegalArgumentException("stop");
            }, new RetryHelper.Options(3, 1, 10, e -> false))
        );
        assertEquals(1, calls[0]);
    }
}
