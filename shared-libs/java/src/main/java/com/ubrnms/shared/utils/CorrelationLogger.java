package com.ubrnms.shared.utils;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

/**
 * Logger helper that injects correlationId into SLF4J MDC for structured logging.
 *
 * Usage:
 *   CorrelationLogger logger = CorrelationLogger.getLogger(MyService.class);
 *   try (var ctx = CorrelationLogger.withCorrelationId("req-abc")) {
 *       logger.info("Handling request");
 *   }
 */
public class CorrelationLogger {

    public static final String CORRELATION_ID_KEY = "correlationId";

    private final Logger delegate;

    private CorrelationLogger(Class<?> clazz) {
        this.delegate = LoggerFactory.getLogger(clazz);
    }

    public static CorrelationLogger getLogger(Class<?> clazz) {
        return new CorrelationLogger(clazz);
    }

    public void info(String message, Object... args) {
        delegate.info(message, args);
    }

    public void warn(String message, Object... args) {
        delegate.warn(message, args);
    }

    public void error(String message, Object... args) {
        delegate.error(message, args);
    }

    public void debug(String message, Object... args) {
        delegate.debug(message, args);
    }

    /**
     * Returns an AutoCloseable that sets the correlation ID in MDC and removes it on close.
     */
    public static AutoCloseable withCorrelationId(String correlationId) {
        MDC.put(CORRELATION_ID_KEY, correlationId);
        return () -> MDC.remove(CORRELATION_ID_KEY);
    }

    public static String getCorrelationId() {
        return MDC.get(CORRELATION_ID_KEY);
    }
}
