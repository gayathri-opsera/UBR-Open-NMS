package com.ubrnms.shared.utils;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ApiErrorTest {

    @Test
    void testNotFound() {
        ApiError err = ApiError.notFound("Device");
        assertEquals("error", err.getStatus());
        assertEquals("NOT_FOUND", err.getError().getCode());
        assertTrue(err.getError().getMessage().contains("Device"));
    }

    @Test
    void testForbidden() {
        ApiError err = ApiError.forbidden("no access");
        assertEquals("FORBIDDEN", err.getError().getCode());
    }

    @Test
    void testUnauthorized() {
        ApiError err = ApiError.unauthorized("no token");
        assertEquals("UNAUTHORIZED", err.getError().getCode());
    }

    @Test
    void testConflict() {
        ApiError err = ApiError.conflict("duplicate");
        assertEquals("CONFLICT", err.getError().getCode());
    }

    @Test
    void testValidation() {
        ApiError err = ApiError.validation("bad field");
        assertEquals("VALIDATION_ERROR", err.getError().getCode());
    }

    @Test
    void testServiceUnavailable() {
        ApiError err = ApiError.serviceUnavailable("down");
        assertEquals("SERVICE_UNAVAILABLE", err.getError().getCode());
    }

    @Test
    void testInternal() {
        ApiError err = ApiError.internal("boom");
        assertEquals("INTERNAL_ERROR", err.getError().getCode());
    }
}
