// Package retry provides exponential backoff retry logic.
package retry

import (
	"context"
	"math"
	"time"
)

// Options configures retry behaviour.
type Options struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	ShouldRetry func(err error, attempt int) bool
}

var DefaultOptions = Options{
	MaxAttempts: 3,
	BaseDelay:   100 * time.Millisecond,
	MaxDelay:    5 * time.Second,
	ShouldRetry: func(err error, attempt int) bool { return true },
}

// Do retries fn with exponential backoff. Respects ctx cancellation.
func Do(ctx context.Context, opts Options, fn func() error) error {
	shouldRetry := opts.ShouldRetry
	if shouldRetry == nil {
		shouldRetry = DefaultOptions.ShouldRetry
	}
	var lastErr error
	for attempt := 1; attempt <= opts.MaxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := fn(); err != nil {
			lastErr = err
			if attempt == opts.MaxAttempts || !shouldRetry(err, attempt) {
				return err
			}
			delay := time.Duration(math.Min(
				float64(opts.BaseDelay)*math.Pow(2, float64(attempt-1)),
				float64(opts.MaxDelay),
			))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
			continue
		}
		return nil
	}
	return lastErr
}
