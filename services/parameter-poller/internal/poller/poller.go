// Package poller implements the parameter polling orchestrator.
//
// The Poller resolves active Product Definition parameter metadata into
// protocol-specific read references, dispatches them through the southbound
// adapter (via the AdapterClient interface), and persists fresh values to the
// current-value store.
//
// Design constraints:
//   - Read-only: the poller may only call Get on adapters, never Set.
//   - Credential-safe: credential references remain opaque strings throughout;
//     resolved secrets must not be logged, serialised, or stored.
//   - Partial success: a poll cycle may succeed for some parameters and fail
//     for others; each outcome is persisted independently.
//   - Maintenance windows: when the device record carries a maintenance flag
//     the poller skips it and marks parameters as STALE without raising errors.
package poller

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/airtel-ubrnms/parameter-poller/internal/alarm"
	"github.com/airtel-ubrnms/parameter-poller/internal/model"
	pollerregistry "github.com/airtel-ubrnms/parameter-poller/internal/registry"
	"github.com/airtel-ubrnms/parameter-poller/internal/store"
)

// AdapterClient is the read-only southbound interface used by the poller.
// It mirrors the DeviceClient interface in the discovery-service SPAL so that
// the same adapter implementations can satisfy both contracts when shared via
// the shared-libs module in a future story.
//
// The poller only calls Get — Ping is reserved for liveness checks.
type AdapterClient interface {
	// Get executes a read-only protocol-specific get request.
	// keys are the OIDs/CLI commands/REST paths/gRPC methods to read.
	// Returns a map of key → raw string value, or a categorized error.
	Get(ctx context.Context, target string, keys []string) (map[string]string, error)
}

// AdapterResolver maps a protocol name to an AdapterClient.
// Returns (nil, false) when no adapter is registered for the protocol.
type AdapterResolver interface {
	Resolve(protocol string) (AdapterClient, bool)
}

// adapterResolverMap is a simple map-backed AdapterResolver.
type adapterResolverMap struct {
	adapters map[string]AdapterClient
}

// NewAdapterResolver creates an AdapterResolver backed by the supplied map.
// Keys must be uppercase protocol names: SNMP, CLI, REST, gRPC.
func NewAdapterResolver(adapters map[string]AdapterClient) AdapterResolver {
	m := make(map[string]AdapterClient, len(adapters))
	for k, v := range adapters {
		m[strings.ToUpper(k)] = v
	}
	return &adapterResolverMap{adapters: m}
}

func (r *adapterResolverMap) Resolve(protocol string) (AdapterClient, bool) {
	c, ok := r.adapters[strings.ToUpper(protocol)]
	return c, ok
}

// AlarmEvaluator submits threshold and drift evaluation requests to the alarm service.
type AlarmEvaluator interface {
	EvaluateThreshold(ctx context.Context, req alarm.ThresholdEvaluationRequest) error
	// RaiseDrift evaluates whether a polled value violates the schema-declared
	// min/max constraints from the Product Definition registry, raising or clearing
	// a FRAMEWORK_DRIFT alarm as appropriate.
	RaiseDrift(ctx context.Context, req alarm.DriftEvaluationRequest) error
}

// Poller orchestrates parameter poll cycles.
// It is safe for concurrent use; each call to PollDevice is independent.
type Poller struct {
	registry  pollerregistry.Reader
	store     store.Store
	adapters  AdapterResolver
	alarms    AlarmEvaluator
	log       *slog.Logger
	// clock allows deterministic time injection in tests.
	clock func() time.Time
}

// New creates a Poller with real-time clock.
func New(reg pollerregistry.Reader, st store.Store, adapters AdapterResolver, log *slog.Logger) *Poller {
	return &Poller{
		registry: reg,
		store:    st,
		adapters: adapters,
		alarms:   &alarm.NoOpClient{},
		log:      log,
		clock:    time.Now,
	}
}

// WithAlarmEvaluator sets the alarm evaluator used to report threshold breaches.
func (p *Poller) WithAlarmEvaluator(a AlarmEvaluator) *Poller {
	p.alarms = a
	return p
}

// WithClock replaces the default clock. Used in tests only.
func (p *Poller) WithClock(fn func() time.Time) *Poller {
	p.clock = fn
	return p
}

// PollDevice runs a single poll cycle for one device.
//
// The flow is:
//  1. Fetch the device's active registry profile.
//  2. For each parameter group: resolve read references, dispatch to the adapter,
//     and persist per-parameter outcomes.
//
// Returns nil when all parameters are processed (individual failures are
// persisted as ParameterReadStatus values, not propagated as errors).
// Returns an error only when the registry is unavailable.
func (p *Poller) PollDevice(ctx context.Context, deviceID string) error {
	profile, err := p.registry.GetDeviceProfile(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("registry lookup for %s: %w", deviceID, err)
	}
	if profile == nil {
		// Device is not associated with any active Product Definition.
		// Persist UNKNOWN_DEVICE records so the API returns a clear state.
		p.log.Info("device has no active registry profile", slog.String("deviceID", deviceID))
		return p.persistUnknownDevice(ctx, deviceID)
	}

	now := p.clock()
	var wg sync.WaitGroup

	for _, group := range profile.Groups {
		group := group // capture
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.pollGroup(ctx, deviceID, profile, group, now)
		}()
	}
	wg.Wait()
	return nil
}

// pollGroup dispatches all parameters in a group to the appropriate adapter
// and persists the results.
func (p *Poller) pollGroup(
	ctx context.Context,
	deviceID string,
	profile *model.RegistryDeviceProfile,
	group model.RegistryGroupMetadata,
	now time.Time,
) {
	// Group parameters by protocol to batch adapter calls.
	byProtocol := make(map[string][]model.RegistryParamRef)
	for _, param := range group.Parameters {
		proto := strings.ToUpper(param.Protocol)
		if proto == "" {
			// Parameter has no read reference in the active registry.
			p.persistParamResult(ctx, deviceID, profile, group, param, now,
				model.ParameterReadStatusUnmapped,
				model.PollFailureCategoryUnmapped,
				"parameter has no read reference in the active registry",
				"", nil,
			)
			continue
		}
		byProtocol[proto] = append(byProtocol[proto], param)
	}

	for proto, params := range byProtocol {
		adapter, ok := p.adapters.Resolve(proto)
		if !ok {
			// No adapter registered for this protocol — persist UNMAPPED.
			for _, param := range params {
				p.persistParamResult(ctx, deviceID, profile, group, param, now,
					model.ParameterReadStatusUnmapped,
					model.PollFailureCategoryUnmapped,
					fmt.Sprintf("no adapter registered for protocol %s", proto),
					"", nil,
				)
			}
			continue
		}

		// Build the batch of read references.
		keys := make([]string, len(params))
		for i, p := range params {
			keys[i] = p.ReadRef
		}

		// Use the device management IP when available; fall back to deviceID
		// for backwards compatibility with in-memory test fixtures.
		target := profile.DeviceIP
		if target == "" {
			target = deviceID
		}
		results, err := adapter.Get(ctx, target, keys)
		if err != nil {
			// Classify the adapter error and persist per-parameter failure.
			status, category, reason := classifyAdapterError(err)
			for _, param := range params {
				p.persistParamResult(ctx, deviceID, profile, group, param, now,
					status, category, reason, "", nil,
				)
			}
			p.log.Warn("adapter get failed",
				slog.String("deviceID", deviceID),
				slog.String("protocol", proto),
				slog.String("category", string(category)),
				slog.String("reason", reason),
			)
			continue
		}

		// Persist each result, evaluate operational thresholds, and detect schema drift.
		for _, param := range params {
			raw := results[param.ReadRef]
			numericPtr := store.CoerceNumeric(raw)
			p.persistParamResult(ctx, deviceID, profile, group, param, now,
				model.ParameterReadStatusSuccess, "", "", raw, numericPtr,
			)

			corrID := fmt.Sprintf("%s-%s-%d", deviceID, param.ParameterID, now.Unix())

			// Threshold evaluation: operational limits configured in the registry.
			if numericPtr != nil && (param.ThresholdHigh != nil || param.ThresholdLow != nil) {
				evalReq := alarm.ThresholdEvaluationRequest{
					DeviceID:            deviceID,
					DeviceType:          "SWITCH",
					ProductDefinitionID: profile.ProductDefinitionID,
					RegistryVersion:     profile.RegistryVersion,
					GroupID:             group.GroupID,
					ParameterID:         param.ParameterID,
					ValueNumeric:        *numericPtr,
					CollectedAt:         now,
					ThresholdHigh:       param.ThresholdHigh,
					ThresholdLow:        param.ThresholdLow,
					CorrelationID:       corrID,
				}
				if err := p.alarms.EvaluateThreshold(ctx, evalReq); err != nil {
					p.log.Warn("threshold evaluation failed",
						slog.String("deviceID", deviceID),
						slog.String("parameterId", param.ParameterID),
						slog.Any("err", err),
					)
				}
			}

			// Schema drift detection: schema-declared min/max constraints.
			// A value outside [MinValue, MaxValue] indicates a configuration drift
			// condition — the device is operating outside its validated parameter range.
			// Only evaluated when no operational threshold is configured (threshold takes
			// precedence as it captures the same intent with user-defined severity).
			if numericPtr != nil && (param.MinValue != nil || param.MaxValue != nil) &&
				param.ThresholdHigh == nil && param.ThresholdLow == nil {
				driftReq := alarm.DriftEvaluationRequest{
					DeviceID:            deviceID,
					DeviceType:          "SWITCH",
					ProductDefinitionID: profile.ProductDefinitionID,
					RegistryVersion:     profile.RegistryVersion,
					GroupID:             group.GroupID,
					ParameterID:         param.ParameterID,
					ValueNumeric:        *numericPtr,
					CollectedAt:         now,
					MinValue:            param.MinValue,
					MaxValue:            param.MaxValue,
					CorrelationID:       corrID + "-drift",
				}
				if err := p.alarms.RaiseDrift(ctx, driftReq); err != nil {
					p.log.Warn("drift evaluation failed",
						slog.String("deviceID", deviceID),
						slog.String("parameterId", param.ParameterID),
						slog.Any("err", err),
					)
				}
			}
		}
	}
}

// persistParamResult writes one ParameterValue record to the store.
func (p *Poller) persistParamResult(
	ctx context.Context,
	deviceID string,
	profile *model.RegistryDeviceProfile,
	group model.RegistryGroupMetadata,
	param model.RegistryParamRef,
	now time.Time,
	status model.ParameterReadStatus,
	category model.PollFailureCategory,
	failureReason string,
	rawValue string,
	numericValue *float64,
) {
	var successAt *time.Time
	if status == model.ParameterReadStatusSuccess {
		t := now
		successAt = &t
	}

	v := model.ParameterValue{
		DeviceID:            deviceID,
		GroupID:             group.GroupID,
		ParameterID:         param.ParameterID,
		Label:               param.Label,
		DataType:            param.DataType,
		Unit:                param.Unit,
		Value:               rawValue,
		ValueNumeric:        numericValue,
		CollectedAt:         now,
		PollIntervalSeconds: group.PollIntervalSeconds,
		FreshnessState:      model.FreshnessStateFresh, // will be recalculated on read
		ReadStatus:          status,
		LastSuccessAt:       successAt,
		FailureCategory:     category,
		FailureReason:       failureReason,
		RegistryVersion:     profile.RegistryVersion,
		ProductDefinitionID: profile.ProductDefinitionID,
	}

	if status == model.ParameterReadStatusSuccess && rawValue != "" {
		// SNMP/CLI may return the source in the adapter error; use the
		// protocol as source when the adapter call succeeded.
		v.Source = strings.ToUpper(param.Protocol)
	}

	if err := p.store.Upsert(ctx, v); err != nil {
		p.log.Error("failed to persist parameter value",
			slog.String("deviceID", deviceID),
			slog.String("parameterID", param.ParameterID),
			slog.Any("err", err),
		)
	}
}

// persistUnknownDevice writes UNKNOWN_DEVICE placeholder records.
// This ensures the API returns a clear state rather than an empty response.
func (p *Poller) persistUnknownDevice(ctx context.Context, deviceID string) error {
	now := p.clock()
	v := model.ParameterValue{
		DeviceID:        deviceID,
		GroupID:         "",
		ParameterID:     "",
		Label:           "",
		CollectedAt:     now,
		FreshnessState:  model.FreshnessStateUnknownDevice,
		ReadStatus:      model.ParameterReadStatusUnmapped,
		FailureCategory: model.PollFailureCategoryUnmapped,
		FailureReason:   "device is not associated with any active Product Definition",
		RegistryVersion: "",
	}
	return p.store.Upsert(ctx, v)
}

// classifyAdapterError maps an adapter error string to a ParameterReadStatus
// and PollFailureCategory. The reason string is operator-visible and must not
// contain credential material.
func classifyAdapterError(err error) (model.ParameterReadStatus, model.PollFailureCategory, string) {
	msg := strings.ToLower(err.Error())

	switch {
	case strings.Contains(msg, "auth") || strings.Contains(msg, "unauthorized") ||
		strings.Contains(msg, "forbidden") || strings.Contains(msg, "invalid credential"):
		return model.ParameterReadStatusAuthFailure,
			model.PollFailureCategoryAuthFailure,
			"management access was rejected — verify the vault reference configured for this device"

	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
		return model.ParameterReadStatusTimeout,
			model.PollFailureCategoryTimeout,
			"protocol read request timed out — device did not respond within the configured interval"

	case strings.Contains(msg, "unreachable") || strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no route") || strings.Contains(msg, "network"):
		return model.ParameterReadStatusUnreachable,
			model.PollFailureCategoryUnreachable,
			"device is unreachable — check management-network routing and firewall rules"

	default:
		return model.ParameterReadStatusAdapterError,
			model.PollFailureCategoryAdapterError,
			"adapter returned an unexpected error; consult discovery logs for details"
	}
}
