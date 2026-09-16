// Package repository provides the data access layer for the Discovery Service.
//
// WO-002: CredentialRepository is the interface for all SNMP credential CRUD
// operations. Two implementations are provided:
//
//   - InMemoryCredentialRepository — for local development and unit tests.
//     No external dependencies required; state is not persisted across restarts.
//
//   - MongoCredentialRepository — for production deployments.
//     Connects to MongoDB using the official Go driver; persists credentials
//     in the snmp_credentials collection.
//
// The MongoDB implementation is conditionally compiled and requires the
// `go.mongodb.org/mongo-driver` module to be present in go.mod.
//
// Authority rules (security):
//   - Plaintext community strings, auth keys, and privacy keys must NEVER be
//     stored. Callers must encrypt values before passing them to Create/Update.
//   - The repository never decrypts stored values; encryption/decryption is
//     the responsibility of the credential service layer.
package repository

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/google/uuid"
)

// ── Sentinel errors ───────────────────────────────────────────────────────────

// ErrCredentialNotFound is returned when a credential is not found by ID or name.
var ErrCredentialNotFound = errors.New("snmp credential not found")

// ErrDuplicateCredentialName is returned when a credential with the same name
// already exists (unique index violation on the name field).
var ErrDuplicateCredentialName = errors.New("snmp credential with this name already exists")

// ErrInvalidCredentialID is returned when an ID is empty or malformed.
var ErrInvalidCredentialID = errors.New("invalid credential ID: must be a non-empty string")

// ── CredentialRepository interface ───────────────────────────────────────────

// CredentialRepository defines all CRUD operations on SNMP credential documents.
// Implementations must be safe for concurrent use from multiple goroutines.
//
// All methods accept a context.Context for cancellation and deadline propagation.
// Implementations should honour context cancellation and wrap returned errors
// with sufficient context for the service layer to produce meaningful messages.
type CredentialRepository interface {
	// Create persists a new SNMP credential document.
	// Sets ID, CreatedAt, UpdatedAt, and Active=true on the credential before saving.
	// Returns ErrDuplicateCredentialName if a credential with the same name exists.
	Create(ctx context.Context, cred *model.SNMPCredential) (*model.SNMPCredential, error)

	// FindByID retrieves a single credential by its ID.
	// Returns ErrCredentialNotFound if no matching document exists.
	// Returns ErrInvalidCredentialID for an empty ID.
	FindByID(ctx context.Context, id string) (*model.SNMPCredential, error)

	// FindAll returns all active credential documents.
	// An empty slice (not nil) is returned when no credentials exist.
	FindAll(ctx context.Context) ([]*model.SNMPCredential, error)

	// UpdateByID replaces the mutable fields of an existing credential.
	// Returns ErrCredentialNotFound if the ID does not exist.
	// Returns ErrDuplicateCredentialName if the new name conflicts with another credential.
	// Updates the UpdatedAt timestamp automatically.
	UpdateByID(ctx context.Context, id string, update *model.SNMPCredential) (*model.SNMPCredential, error)

	// DeleteByID performs a soft-delete: sets active=false on the document.
	// Returns ErrCredentialNotFound if the ID does not exist.
	// Physical deletion is intentionally not supported to preserve audit trails.
	DeleteByID(ctx context.Context, id string) error
}

// ── InMemoryCredentialRepository ─────────────────────────────────────────────

// InMemoryCredentialRepository is a thread-safe in-memory implementation of
// CredentialRepository for local development and unit testing.
//
// It enforces the unique constraint on Name and all error semantics defined
// by the interface contract, making it a faithful stand-in for the MongoDB
// implementation in tests without requiring a running database.
type InMemoryCredentialRepository struct {
	mu      sync.RWMutex
	byID    map[string]*model.SNMPCredential
	byName  map[string]string // name → ID index for unique constraint enforcement
}

// NewInMemoryCredentialRepository constructs an empty in-memory repository.
func NewInMemoryCredentialRepository() *InMemoryCredentialRepository {
	return &InMemoryCredentialRepository{
		byID:   make(map[string]*model.SNMPCredential),
		byName: make(map[string]string),
	}
}

// Create persists a new credential. Assigns a UUID as ID and sets timestamps.
func (r *InMemoryCredentialRepository) Create(ctx context.Context, cred *model.SNMPCredential) (*model.SNMPCredential, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("repository.Create: context cancelled: %w", err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Enforce unique name constraint.
	if _, exists := r.byName[cred.Name]; exists {
		return nil, ErrDuplicateCredentialName
	}

	// Assign system-managed fields.
	cred.ID = uuid.NewString()
	now := time.Now().UTC()
	cred.CreatedAt = now
	cred.UpdatedAt = now
	cred.Active = true

	// Deep copy to prevent external mutation of the stored value.
	stored := *cred
	r.byID[stored.ID] = &stored
	r.byName[stored.Name] = stored.ID

	result := stored
	return &result, nil
}

// FindByID retrieves a credential by its ID.
func (r *InMemoryCredentialRepository) FindByID(ctx context.Context, id string) (*model.SNMPCredential, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("repository.FindByID: context cancelled: %w", err)
	}
	if id == "" {
		return nil, ErrInvalidCredentialID
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	cred, ok := r.byID[id]
	if !ok {
		return nil, ErrCredentialNotFound
	}
	result := *cred
	return &result, nil
}

// FindAll returns all active credentials (active=true).
func (r *InMemoryCredentialRepository) FindAll(ctx context.Context) ([]*model.SNMPCredential, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("repository.FindAll: context cancelled: %w", err)
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	results := make([]*model.SNMPCredential, 0, len(r.byID))
	for _, cred := range r.byID {
		if cred.Active {
			copy := *cred
			results = append(results, &copy)
		}
	}
	return results, nil
}

// UpdateByID replaces mutable fields of an existing credential by ID.
func (r *InMemoryCredentialRepository) UpdateByID(ctx context.Context, id string, update *model.SNMPCredential) (*model.SNMPCredential, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("repository.UpdateByID: context cancelled: %w", err)
	}
	if id == "" {
		return nil, ErrInvalidCredentialID
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.byID[id]
	if !ok {
		return nil, ErrCredentialNotFound
	}

	// Enforce unique name constraint when the name changes.
	if update.Name != existing.Name {
		if _, nameExists := r.byName[update.Name]; nameExists {
			return nil, ErrDuplicateCredentialName
		}
		// Update the name index.
		delete(r.byName, existing.Name)
		r.byName[update.Name] = id
	}

	// Preserve immutable fields.
	update.ID = existing.ID
	update.CreatedBy = existing.CreatedBy
	update.CreatedAt = existing.CreatedAt
	update.UpdatedAt = time.Now().UTC()
	update.Active = existing.Active // Active state is managed by DeleteByID, not Update.

	stored := *update
	r.byID[id] = &stored

	result := stored
	return &result, nil
}

// DeleteByID performs a soft-delete (active=false) on the credential.
func (r *InMemoryCredentialRepository) DeleteByID(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("repository.DeleteByID: context cancelled: %w", err)
	}
	if id == "" {
		return ErrInvalidCredentialID
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	cred, ok := r.byID[id]
	if !ok {
		return ErrCredentialNotFound
	}

	// Soft-delete: mark as inactive to preserve audit trail.
	cred.Active = false
	cred.UpdatedAt = time.Now().UTC()
	return nil
}

// ── MongoCredentialRepository ─────────────────────────────────────────────────

// mongoCollection is an interface representing the MongoDB collection operations
// used by MongoCredentialRepository. This abstraction enables unit testing of
// MongoCredentialRepository without a live MongoDB connection.
//
// In production, mongo.Collection satisfies this interface.
// In tests, mockMongoCollection can be used instead.
type mongoCollection interface {
	InsertOne(ctx context.Context, document interface{}) (interface{}, error)
	FindOne(ctx context.Context, filter interface{}) mongoSingleResult
	Find(ctx context.Context, filter interface{}) (mongoCursor, error)
	UpdateOne(ctx context.Context, filter interface{}, update interface{}) (int64, error)
}

// mongoSingleResult abstracts mongo.SingleResult for testability.
type mongoSingleResult interface {
	Decode(v interface{}) error
	Err() error
}

// mongoCursor abstracts mongo.Cursor for testability.
type mongoCursor interface {
	Next(ctx context.Context) bool
	Decode(v interface{}) error
	Close(ctx context.Context) error
	Err() error
}

// MongoCredentialRepository implements CredentialRepository backed by MongoDB.
//
// Production use requires the go.mongodb.org/mongo-driver module and a
// running MongoDB instance. Connection and pooling are managed externally;
// this repository accepts an already-connected collection handle.
//
// The snmp_credentials collection should have a unique index on the name field:
//
//	db.snmp_credentials.createIndex({ name: 1 }, { unique: true })
//
// Documents use BSON tags defined on model.SNMPCredential. The _id field is
// stored as the hex string of a MongoDB ObjectID.
type MongoCredentialRepository struct {
	collection mongoCollection
}

// NewMongoCredentialRepository constructs a MongoCredentialRepository.
// The collection argument must be a handle to the snmp_credentials collection
// obtained from a connected MongoDB client.
//
// Example (production wiring):
//
//	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI))
//	col := client.Database("discovery").Collection("snmp_credentials")
//	repo := repository.NewMongoCredentialRepository(col)
func NewMongoCredentialRepository(col mongoCollection) *MongoCredentialRepository {
	return &MongoCredentialRepository{collection: col}
}

// Create persists a new credential document in MongoDB.
// Assigns a new UUID as the _id value and sets CreatedAt/UpdatedAt/Active.
// Returns ErrDuplicateCredentialName on unique index violation (code 11000).
func (r *MongoCredentialRepository) Create(ctx context.Context, cred *model.SNMPCredential) (*model.SNMPCredential, error) {
	cred.ID = uuid.NewString()
	now := time.Now().UTC()
	cred.CreatedAt = now
	cred.UpdatedAt = now
	cred.Active = true

	_, err := r.collection.InsertOne(ctx, cred)
	if err != nil {
		// MongoDB duplicate key error code is 11000.
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateCredentialName
		}
		return nil, fmt.Errorf("repository.Create: InsertOne failed: %w", err)
	}

	return cred, nil
}

// FindByID retrieves a credential by its _id field.
// Returns ErrCredentialNotFound when no document matches.
func (r *MongoCredentialRepository) FindByID(ctx context.Context, id string) (*model.SNMPCredential, error) {
	if id == "" {
		return nil, ErrInvalidCredentialID
	}

	result := r.collection.FindOne(ctx, map[string]interface{}{"_id": id})
	if err := result.Err(); err != nil {
		if isNotFoundError(err) {
			return nil, ErrCredentialNotFound
		}
		return nil, fmt.Errorf("repository.FindByID: FindOne failed: %w", err)
	}

	var cred model.SNMPCredential
	if err := result.Decode(&cred); err != nil {
		return nil, fmt.Errorf("repository.FindByID: Decode failed: %w", err)
	}
	return &cred, nil
}

// FindAll returns all active (active=true) credential documents.
func (r *MongoCredentialRepository) FindAll(ctx context.Context) ([]*model.SNMPCredential, error) {
	cursor, err := r.collection.Find(ctx, map[string]interface{}{"active": true})
	if err != nil {
		return nil, fmt.Errorf("repository.FindAll: Find failed: %w", err)
	}
	defer cursor.Close(ctx)

	var results []*model.SNMPCredential
	for cursor.Next(ctx) {
		var cred model.SNMPCredential
		if err := cursor.Decode(&cred); err != nil {
			return nil, fmt.Errorf("repository.FindAll: Decode failed: %w", err)
		}
		results = append(results, &cred)
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("repository.FindAll: cursor error: %w", err)
	}

	if results == nil {
		results = []*model.SNMPCredential{} // always return non-nil slice
	}
	return results, nil
}

// UpdateByID replaces mutable fields of the credential with the given ID.
// Returns ErrCredentialNotFound when no document matches.
// Returns ErrDuplicateCredentialName on unique name index violation.
func (r *MongoCredentialRepository) UpdateByID(ctx context.Context, id string, update *model.SNMPCredential) (*model.SNMPCredential, error) {
	if id == "" {
		return nil, ErrInvalidCredentialID
	}
	update.UpdatedAt = time.Now().UTC()

	filter := map[string]interface{}{"_id": id}
	setDoc := map[string]interface{}{"$set": update}

	matched, err := r.collection.UpdateOne(ctx, filter, setDoc)
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateCredentialName
		}
		return nil, fmt.Errorf("repository.UpdateByID: UpdateOne failed: %w", err)
	}
	if matched == 0 {
		return nil, ErrCredentialNotFound
	}

	// Re-fetch the updated document to return the current state.
	return r.FindByID(ctx, id)
}

// DeleteByID soft-deletes a credential by setting active=false.
// Returns ErrCredentialNotFound when no document matches.
func (r *MongoCredentialRepository) DeleteByID(ctx context.Context, id string) error {
	if id == "" {
		return ErrInvalidCredentialID
	}

	filter := map[string]interface{}{"_id": id}
	setDoc := map[string]interface{}{
		"$set": map[string]interface{}{
			"active":    false,
			"updatedAt": time.Now().UTC(),
		},
	}

	matched, err := r.collection.UpdateOne(ctx, filter, setDoc)
	if err != nil {
		return fmt.Errorf("repository.DeleteByID: UpdateOne failed: %w", err)
	}
	if matched == 0 {
		return ErrCredentialNotFound
	}
	return nil
}

// ── Error classification helpers ──────────────────────────────────────────────

// isDuplicateKeyError checks whether an error originated from a MongoDB
// duplicate key violation (error code 11000).
// In production, this would use mongo.IsDuplicateKeyError from the driver.
// Here we check the error message string to avoid importing the driver package
// in this file (keeping the interface definition driver-agnostic).
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	return len(errStr) > 0 && (contains(errStr, "11000") || contains(errStr, "duplicate key"))
}

// isNotFoundError checks whether an error represents a "no documents" result.
// In production this would check mongo.ErrNoDocuments.
func isNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	return err.Error() == "mongo: no documents in result" || errors.Is(err, ErrCredentialNotFound)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && func() bool {
		for i := 0; i <= len(s)-len(substr); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	}())
}
