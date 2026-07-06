// Package logger provides a structured JSON logger using slog.
package logger

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

type ctxKey string

const correlationIDKey ctxKey = "correlationId"

var defaultLogger = newLogger()

func newLogger() *slog.Logger {
	level := slog.LevelInfo
	if l := os.Getenv("LOG_LEVEL"); l != "" {
		switch strings.ToLower(l) {
		case "debug":
			level = slog.LevelDebug
		case "warn", "warning":
			level = slog.LevelWarn
		case "error":
			level = slog.LevelError
		}
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}

// WithCorrelationID returns a context carrying the given correlation ID.
func WithCorrelationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, correlationIDKey, id)
}

// CorrelationIDFromContext extracts the correlation ID from context.
func CorrelationIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(correlationIDKey).(string); ok {
		return v
	}
	return ""
}

// Info logs at INFO level, adding correlationId if present in ctx.
func Info(ctx context.Context, msg string, args ...any) {
	if id := CorrelationIDFromContext(ctx); id != "" {
		args = append(args, "correlationId", id)
	}
	defaultLogger.InfoContext(ctx, msg, args...)
}

// Warn logs at WARN level.
func Warn(ctx context.Context, msg string, args ...any) {
	if id := CorrelationIDFromContext(ctx); id != "" {
		args = append(args, "correlationId", id)
	}
	defaultLogger.WarnContext(ctx, msg, args...)
}

// Error logs at ERROR level.
func Error(ctx context.Context, msg string, args ...any) {
	if id := CorrelationIDFromContext(ctx); id != "" {
		args = append(args, "correlationId", id)
	}
	defaultLogger.ErrorContext(ctx, msg, args...)
}

// Debug logs at DEBUG level.
func Debug(ctx context.Context, msg string, args ...any) {
	if id := CorrelationIDFromContext(ctx); id != "" {
		args = append(args, "correlationId", id)
	}
	defaultLogger.DebugContext(ctx, msg, args...)
}
