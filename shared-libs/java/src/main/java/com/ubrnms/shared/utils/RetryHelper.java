package com.ubrnms.shared.utils;

import java.util.concurrent.Callable;
import java.util.function.Predicate;

/**
 * Exponential backoff retry helper for Java services.
 *
 * <pre>
 * RetryHelper.retry(() -> callExternalService(), RetryHelper.Options.defaults());
 * </pre>
 */
public class RetryHelper {

    public static class Options {
        public final int maxAttempts;
        public final long baseDelayMs;
        public final long maxDelayMs;
        public final Predicate<Exception> shouldRetry;

        public Options(int maxAttempts, long baseDelayMs, long maxDelayMs, Predicate<Exception> shouldRetry) {
            this.maxAttempts = maxAttempts;
            this.baseDelayMs = baseDelayMs;
            this.maxDelayMs = maxDelayMs;
            this.shouldRetry = shouldRetry;
        }

        public static Options defaults() {
            return new Options(3, 100, 5000, e -> true);
        }
    }

    /**
     * Execute a Callable with retry logic.
     *
     * @param callable the operation to retry
     * @param opts     retry configuration
     * @return result of the callable
     * @throws Exception the last exception if all attempts fail
     */
    public static <T> T retry(Callable<T> callable, Options opts) throws Exception {
        Exception lastException = null;
        for (int attempt = 1; attempt <= opts.maxAttempts; attempt++) {
            try {
                return callable.call();
            } catch (Exception e) {
                lastException = e;
                if (attempt == opts.maxAttempts || !opts.shouldRetry.test(e)) {
                    throw e;
                }
                long delay = Math.min(opts.baseDelayMs * (1L << (attempt - 1)), opts.maxDelayMs);
                Thread.sleep(delay);
            }
        }
        throw lastException;
    }

    /**
     * Execute a Runnable with retry logic.
     */
    public static void retry(Runnable runnable, Options opts) throws Exception {
        retry(() -> { runnable.run(); return null; }, opts);
    }
}
