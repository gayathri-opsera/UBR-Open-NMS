package retry_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/airtel-ubrnms/shared-libs/utils/retry"
)

func TestDo_SuccessFirstAttempt(t *testing.T) {
	calls := 0
	err := retry.Do(context.Background(), retry.Options{MaxAttempts: 3, BaseDelay: time.Millisecond}, func() error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Errorf("expected 1 call, got %d", calls)
	}
}

func TestDo_RetriesAndSucceeds(t *testing.T) {
	calls := 0
	err := retry.Do(context.Background(), retry.Options{MaxAttempts: 3, BaseDelay: time.Millisecond}, func() error {
		calls++
		if calls < 3 {
			return errors.New("transient")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 3 {
		t.Errorf("expected 3 calls, got %d", calls)
	}
}

func TestDo_ExceedsMaxAttempts(t *testing.T) {
	calls := 0
	err := retry.Do(context.Background(), retry.Options{MaxAttempts: 2, BaseDelay: time.Millisecond}, func() error {
		calls++
		return errors.New("always fails")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if calls != 2 {
		t.Errorf("expected 2 calls, got %d", calls)
	}
}

func TestDo_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := retry.Do(ctx, retry.Options{MaxAttempts: 5, BaseDelay: time.Millisecond}, func() error {
		return errors.New("fail")
	})
	if err == nil {
		t.Fatal("expected context error")
	}
}
