package service

import (
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// helper: insert n runs with sequential creation times and the given statuses.
func populateStore(t *testing.T, store *DiscoveryRunStore, statuses []string) {
	t.Helper()
	base := time.Now().UTC()
	for i, s := range statuses {
		run := &model.DiscoveryRun{
			ID:        "run-" + s + "-" + string(rune('a'+i)),
			Status:    s,
			CreatedAt: base.Add(time.Duration(i) * time.Second),
		}
		if err := store.Create(run); err != nil {
			t.Fatalf("Create run: %v", err)
		}
	}
}

// ── Happy path ────────────────────────────────────────────────────────────────

func TestListRuns_ReturnsAllRuns_NoFilter(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"COMPLETED", "RUNNING", "FAILED"})

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: 20})

	if result.Pagination.Total != 3 {
		t.Errorf("want Total=3, got %d", result.Pagination.Total)
	}
	if len(result.Data) != 3 {
		t.Errorf("want 3 items in Data, got %d", len(result.Data))
	}
}

func TestListRuns_FilterByStatus_ReturnsOnlyMatching(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"COMPLETED", "RUNNING", "COMPLETED", "FAILED"})

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: 20, Status: "COMPLETED"})

	if result.Pagination.Total != 2 {
		t.Errorf("want Total=2, got %d", result.Pagination.Total)
	}
	for _, run := range result.Data {
		if run.Status != "COMPLETED" {
			t.Errorf("unexpected status %s in filtered results", run.Status)
		}
	}
}

func TestListRuns_Pagination_SecondPage(t *testing.T) {
	store := NewDiscoveryRunStore()
	statuses := make([]string, 5)
	for i := range statuses {
		statuses[i] = "COMPLETED"
	}
	populateStore(t, store, statuses)

	result := store.ListRuns(ListRunsParams{Page: 2, Limit: 2})

	if result.Pagination.Total != 5 {
		t.Errorf("want Total=5, got %d", result.Pagination.Total)
	}
	if result.Pagination.Page != 2 {
		t.Errorf("want Page=2, got %d", result.Pagination.Page)
	}
	if len(result.Data) != 2 {
		t.Errorf("want 2 items on page 2, got %d", len(result.Data))
	}
}

func TestListRuns_Pagination_LastPagePartial(t *testing.T) {
	store := NewDiscoveryRunStore()
	statuses := make([]string, 5)
	for i := range statuses {
		statuses[i] = "COMPLETED"
	}
	populateStore(t, store, statuses)

	result := store.ListRuns(ListRunsParams{Page: 3, Limit: 2})

	// 5 items, 2 per page: page 3 has 1 item.
	if len(result.Data) != 1 {
		t.Errorf("want 1 item on last partial page, got %d", len(result.Data))
	}
	if result.Pagination.Total != 5 {
		t.Errorf("want Total=5, got %d", result.Pagination.Total)
	}
}

func TestListRuns_EmptyStore_ReturnsEmptyResult(t *testing.T) {
	store := NewDiscoveryRunStore()

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: 20})

	if result.Pagination.Total != 0 {
		t.Errorf("want Total=0, got %d", result.Pagination.Total)
	}
	if len(result.Data) != 0 {
		t.Errorf("want empty Data, got %d items", len(result.Data))
	}
}

// ── Edge cases ────────────────────────────────────────────────────────────────

func TestListRuns_PageOutOfBounds_ReturnsEmptyData(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"COMPLETED", "COMPLETED"})

	// Request page 10 when only 1 page exists.
	result := store.ListRuns(ListRunsParams{Page: 10, Limit: 20})

	if result.Pagination.Total != 2 {
		t.Errorf("want Total=2 even for out-of-bounds page, got %d", result.Pagination.Total)
	}
	if len(result.Data) != 0 {
		t.Errorf("want empty Data for out-of-bounds page, got %d items", len(result.Data))
	}
}

func TestListRuns_InvalidPage_ClampsToOne(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"RUNNING"})

	result := store.ListRuns(ListRunsParams{Page: 0, Limit: 20})

	// Page < 1 should clamp to 1.
	if result.Pagination.Page != 1 {
		t.Errorf("want Page clamped to 1, got %d", result.Pagination.Page)
	}
	if len(result.Data) != 1 {
		t.Errorf("want 1 item, got %d", len(result.Data))
	}
}

func TestListRuns_NegativeLimit_ClampsToDefault(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"COMPLETED"})

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: -1})

	// Limit < 1 defaults to 20.
	if result.Pagination.Limit != 20 {
		t.Errorf("want Limit=20 (default), got %d", result.Pagination.Limit)
	}
}

func TestListRuns_ExcessiveLimit_CappedAt200(t *testing.T) {
	store := NewDiscoveryRunStore()
	populateStore(t, store, []string{"COMPLETED"})

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: 9999})

	if result.Pagination.Limit != 200 {
		t.Errorf("want Limit capped at 200, got %d", result.Pagination.Limit)
	}
}

func TestListRuns_OrderIsStable_ByCreationTime(t *testing.T) {
	store := NewDiscoveryRunStore()

	base := time.Now().UTC()
	for i, id := range []string{"c", "a", "b"} {
		run := &model.DiscoveryRun{
			ID:        "run-" + id,
			Status:    "COMPLETED",
			CreatedAt: base.Add(time.Duration(i) * time.Second),
		}
		if err := store.Create(run); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	result := store.ListRuns(ListRunsParams{Page: 1, Limit: 20})

	// Oldest run (run-c) should come first.
	if result.Data[0].ID != "run-c" {
		t.Errorf("want run-c first (oldest), got %s", result.Data[0].ID)
	}
	if result.Data[2].ID != "run-b" {
		t.Errorf("want run-b last (newest), got %s", result.Data[2].ID)
	}
}
