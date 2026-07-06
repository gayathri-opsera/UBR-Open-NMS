package com.ubrnms.shared.utils;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * Standard API error response matching the JSON shape:
 * {"status":"error","error":{"code":"...","message":"..."}}
 */
public class ApiError {

    @JsonProperty("status")
    private final String status = "error";

    @JsonProperty("error")
    private final ErrorBody error;

    public ApiError(String code, String message) {
        this.error = new ErrorBody(code, message);
    }

    public String getStatus() { return status; }
    public ErrorBody getError() { return error; }

    // --- Factory helpers ---

    public static ApiError notFound(String resource) {
        return new ApiError("NOT_FOUND", resource + " not found");
    }

    public static ApiError forbidden(String message) {
        return new ApiError("FORBIDDEN", message);
    }

    public static ApiError unauthorized(String message) {
        return new ApiError("UNAUTHORIZED", message);
    }

    public static ApiError conflict(String message) {
        return new ApiError("CONFLICT", message);
    }

    public static ApiError validation(String message) {
        return new ApiError("VALIDATION_ERROR", message);
    }

    public static ApiError serviceUnavailable(String message) {
        return new ApiError("SERVICE_UNAVAILABLE", message);
    }

    public static ApiError internal(String message) {
        return new ApiError("INTERNAL_ERROR", message);
    }

    /**
     * Writes this error as JSON to an HttpServletResponse.
     */
    public void writeTo(HttpServletResponse response, int statusCode) throws IOException {
        response.setStatus(statusCode);
        response.setContentType("application/json");
        ObjectMapper mapper = new ObjectMapper();
        mapper.writeValue(response.getOutputStream(), this);
    }

    public static class ErrorBody {
        @JsonProperty("code")
        private final String code;

        @JsonProperty("message")
        private final String message;

        public ErrorBody(String code, String message) {
            this.code = code;
            this.message = message;
        }

        public String getCode() { return code; }
        public String getMessage() { return message; }
    }
}
