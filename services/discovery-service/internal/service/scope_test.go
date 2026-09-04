package service

import (
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// TestValidateAndNormalizeScope_Success verifies valid scope entries.
func TestValidateAndNormalizeScope_Success(t *testing.T) {
	scope := []model.ScopeEntry{
		{Type: "CIDR", Value: "192.168.1.0/24", Label: "Office Network"},
		{Type: "IP", Value: "10.0.0.1", Label: "Gateway"},
		{Type: "SEED", Value: "device.example.com", Label: "Primary Device"},
	}

	normalized, fieldErrors, err := ValidateAndNormalizeScope(scope)
	if err != nil {
		t.Fatalf("ValidateAndNormalizeScope() error = %v, want nil", err)
	}
	if fieldErrors != nil {
		t.Errorf("fieldErrors = %v, want nil", fieldErrors)
	}
	if len(normalized) != 3 {
		t.Errorf("len(normalized) = %d, want 3", len(normalized))
	}
}

// TestValidateAndNormalizeScope_EmptyScope verifies empty scope rejection.
func TestValidateAndNormalizeScope_EmptyScope(t *testing.T) {
	scope := []model.ScopeEntry{}

	_, fieldErrors, err := ValidateAndNormalizeScope(scope)
	if err != ErrInvalidScope {
		t.Errorf("error = %v, want ErrInvalidScope", err)
	}
	if len(fieldErrors) == 0 {
		t.Error("expected fieldErrors for empty scope")
	}
	if fieldErrors[0].Field != "scope" {
		t.Errorf("fieldErrors[0].Field = %s, want scope", fieldErrors[0].Field)
	}
}

// TestValidateAndNormalizeScope_InvalidCIDR verifies CIDR validation.
func TestValidateAndNormalizeScope_InvalidCIDR(t *testing.T) {
	tests := []string{
		"192.168.1.0",        // Missing /prefix
		"192.168.1.0/",       // Empty prefix
		"192.168.1/24",       // Invalid IP
		"not-a-cidr/24",      // Invalid format
	}

	for _, invalidCIDR := range tests {
		scope := []model.ScopeEntry{{Type: "CIDR", Value: invalidCIDR}}

		_, fieldErrors, err := ValidateAndNormalizeScope(scope)
		if err != ErrInvalidScope {
			t.Errorf("CIDR %s: error = %v, want ErrInvalidScope", invalidCIDR, err)
		}
		if len(fieldErrors) == 0 {
			t.Errorf("CIDR %s: expected fieldErrors", invalidCIDR)
		}
	}
}

// TestValidateAndNormalizeScope_InvalidIP verifies IP validation.
func TestValidateAndNormalizeScope_InvalidIP(t *testing.T) {
	tests := []string{
		"192.168.1",          // Incomplete
		"192.168.1.256",      // Out of range
		"192.168.1.1.1",      // Too many octets
		"not-an-ip",          // Invalid format
	}

	for _, invalidIP := range tests {
		scope := []model.ScopeEntry{{Type: "IP", Value: invalidIP}}

		_, fieldErrors, err := ValidateAndNormalizeScope(scope)
		if err != ErrInvalidScope {
			t.Errorf("IP %s: error = %v, want ErrInvalidScope", invalidIP, err)
		}
		if len(fieldErrors) == 0 {
			t.Errorf("IP %s: expected fieldErrors", invalidIP)
		}
	}
}

// TestValidateAndNormalizeScope_Duplicates verifies duplicate elimination.
func TestValidateAndNormalizeScope_Duplicates(t *testing.T) {
	scope := []model.ScopeEntry{
		{Type: "IP", Value: "192.168.1.1"},
		{Type: "IP", Value: "192.168.1.1"}, // Duplicate
		{Type: "CIDR", Value: "10.0.0.0/24"},
		{Type: "CIDR", Value: "10.0.0.0/24"}, // Duplicate
	}

	normalized, _, err := ValidateAndNormalizeScope(scope)
	if err != nil {
		t.Fatalf("error = %v, want nil", err)
	}
	if len(normalized) != 2 {
		t.Errorf("len(normalized) = %d, want 2 (duplicates removed)", len(normalized))
	}
}

// TestValidateAndNormalizeScope_InvalidType verifies type validation.
func TestValidateAndNormalizeScope_InvalidType(t *testing.T) {
	scope := []model.ScopeEntry{
		{Type: "INVALID", Value: "192.168.1.1"},
	}

	_, fieldErrors, err := ValidateAndNormalizeScope(scope)
	if err != ErrInvalidScope {
		t.Errorf("error = %v, want ErrInvalidScope", err)
	}
	if len(fieldErrors) == 0 {
		t.Error("expected fieldErrors for invalid type")
	}
}

// TestValidateAndNormalizeScope_EmptyValue verifies value validation.
func TestValidateAndNormalizeScope_EmptyValue(t *testing.T) {
	scope := []model.ScopeEntry{
		{Type: "IP", Value: ""},
	}

	_, fieldErrors, err := ValidateAndNormalizeScope(scope)
	if err != ErrInvalidScope {
		t.Errorf("error = %v, want ErrInvalidScope", err)
	}
	if len(fieldErrors) == 0 {
		t.Error("expected fieldErrors for empty value")
	}
}

// TestCreateDiscoveryRun_Success verifies successful run creation.
func TestCreateDiscoveryRun_Success(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "CIDR", Value: "192.168.1.0/24"},
			{Type: "IP", Value: "10.0.0.1"},
		},
	}

	response, fieldErrors, err := svc.CreateDiscoveryRun(req, "test-user", runStore)
	if err != nil {
		t.Fatalf("CreateDiscoveryRun() error = %v", err)
	}
	if fieldErrors != nil {
		t.Errorf("fieldErrors = %v, want nil", fieldErrors)
	}
	if response.RunID == "" {
		t.Error("RunID is empty")
	}
	if response.Status != "CREATED" {
		t.Errorf("Status = %s, want CREATED", response.Status)
	}
	if response.CreatedBy != "test-user" {
		t.Errorf("CreatedBy = %s, want test-user", response.CreatedBy)
	}
	if len(response.NormalizedScope) != 2 {
		t.Errorf("len(NormalizedScope) = %d, want 2", len(response.NormalizedScope))
	}

	// Verify run is stored
	run, ok := runStore.Get(response.RunID)
	if !ok {
		t.Error("Run not found in store")
	}
	if run.Status != "CREATED" {
		t.Errorf("Stored run status = %s, want CREATED", run.Status)
	}
}

// TestCreateDiscoveryRun_InvalidScope verifies validation error handling.
func TestCreateDiscoveryRun_InvalidScope(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "IP", Value: "invalid-ip"},
		},
	}

	response, fieldErrors, err := svc.CreateDiscoveryRun(req, "test-user", runStore)
	if err != ErrInvalidScope {
		t.Errorf("error = %v, want ErrInvalidScope", err)
	}
	if response != nil {
		t.Error("response should be nil for invalid scope")
	}
	if len(fieldErrors) == 0 {
		t.Error("expected fieldErrors for invalid IP")
	}
}

// TestCreateDiscoveryRun_EmptyScope verifies empty scope rejection.
func TestCreateDiscoveryRun_EmptyScope(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{},
	}

	response, _, err := svc.CreateDiscoveryRun(req, "test-user", runStore)
	if err != ErrInvalidScope {
		t.Errorf("error = %v, want ErrInvalidScope", err)
	}
	if response != nil {
		t.Error("response should be nil for empty scope")
	}
}

// TestDiscoveryRunStore verifies run storage operations.
func TestDiscoveryRunStore(t *testing.T) {
	runStore := NewDiscoveryRunStore()

	run := &model.DiscoveryRun{
		ID:              "test-run-001",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.0.0.1"}},
		Status:          "CREATED",
		CreatedBy:       "test-user",
	}

	err := runStore.Create(run)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	retrieved, ok := runStore.Get("test-run-001")
	if !ok {
		t.Fatal("Run not found in store")
	}
	if retrieved.ID != run.ID {
		t.Errorf("ID = %s, want %s", retrieved.ID, run.ID)
	}
	if retrieved.Status != run.Status {
		t.Errorf("Status = %s, want %s", retrieved.Status, run.Status)
	}
}

// TestIsValidCIDR verifies CIDR validation logic.
func TestIsValidCIDR(t *testing.T) {
	tests := []struct {
		cidr  string
		valid bool
	}{
		{"192.168.1.0/24", true},
		{"10.0.0.0/16", true},
		{"172.16.0.0/12", true},
		{"192.168.1.0", false},      // Missing prefix
		{"192.168.1/24", false},     // Invalid IP
		{"192.168.1.0/", false},     // Empty prefix
		{"not-cidr", false},
	}

	for _, tt := range tests {
		result := isValidCIDR(tt.cidr)
		if result != tt.valid {
			t.Errorf("isValidCIDR(%s) = %v, want %v", tt.cidr, result, tt.valid)
		}
	}
}

// TestIsValidIPAddress verifies IP validation logic.
func TestIsValidIPAddress(t *testing.T) {
	tests := []struct {
		ip    string
		valid bool
	}{
		{"192.168.1.1", true},
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"::1", true},              // IPv6
		{"2001:db8::1", true},      // IPv6
		{"192.168.1", false},       // Incomplete
		{"192.168.1.256", false},   // Out of range (but we don't validate that deeply)
		{"not-an-ip", false},
	}

	for _, tt := range tests {
		result := isValidIPAddress(tt.ip)
		if result != tt.valid {
			t.Errorf("isValidIPAddress(%s) = %v, want %v", tt.ip, result, tt.valid)
		}
	}
}

// TestIsValidHostname verifies hostname validation logic.
func TestIsValidHostname(t *testing.T) {
	tests := []struct {
		hostname string
		valid    bool
	}{
		{"device.example.com", true},
		{"server-01", true},
		{"test.local", true},
		{"192.168.1.1", true},      // IP addresses are valid hostnames
		{"", false},                 // Empty
		{string(make([]byte, 300)), false}, // Too long
	}

	for _, tt := range tests {
		result := isValidHostname(tt.hostname)
		if result != tt.valid {
			t.Errorf("isValidHostname(%s) = %v, want %v", tt.hostname, result, tt.valid)
		}
	}
}
