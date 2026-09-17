// Package fingerprint — deterministic FingerprintMatcher (WO-010).
//
// The matcher applies each active RegistryEntry against ProbeEvidence and
// returns a deterministic MatchResult.  Conflict resolution is explicit:
// when two entries match the same evidence at equal confidence the result
// is CONFLICT, no inventory write is allowed, and both candidate PD IDs are
// returned to guide operator review.
//
// Matching is a pure function: given the same entries and evidence it always
// returns the same result.  No side effects, no network calls.
package fingerprint

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Matcher applies active registry entries against device probe evidence and
// returns a deterministic MatchResult.
type Matcher struct {
	client *RegistryClient
}

// NewMatcher creates a Matcher backed by the given RegistryClient.
func NewMatcher(client *RegistryClient) *Matcher {
	return &Matcher{client: client}
}

// Match resolves a ProbeEvidence against the active registry.
// Returns a non-nil MatchResult in all cases — callers must check Status.
func (m *Matcher) Match(ctx context.Context, evidence ProbeEvidence) *MatchResult {
	entries, registryVersion, err := m.client.ListActive(ctx)
	if err != nil {
		slog.Warn("fingerprint: matcher could not load registry — skipping match",
			"ip", evidence.IP, "runId", evidence.RunID, "err", err)
		return &MatchResult{Status: FingerprintStatusRegistryUnavailable}
	}
	if len(entries) == 0 {
		return &MatchResult{
			Status:          FingerprintStatusUnknown,
			RegistryVersion: registryVersion,
		}
	}

	type candidate struct {
		entry      RegistryEntry
		confidence float64
		evidence   string
	}

	var matches []candidate

	for _, e := range entries {
		conf, ev := score(e, evidence)
		if conf <= 0 {
			continue
		}

		// Firmware range check — if firmware evidence is present and falls outside
		// the definition range, classify as version mismatch rather than match.
		if evidence.FirmwareVersion != "" {
			if !firmwareInRange(evidence.FirmwareVersion, e.FirmwareMin, e.FirmwareMax) {
				slog.Debug("fingerprint: firmware outside range",
					"ip", evidence.IP, "pd", e.ProductDefinitionID,
					"firmware", evidence.FirmwareVersion,
					"min", e.FirmwareMin, "max", e.FirmwareMax)
				return &MatchResult{
					Status:               FingerprintStatusVersionMismatch,
					RegistryVersion:      registryVersion,
					VersionMismatchEntry: e.ProductDefinitionID,
					FirmwareVersion:      evidence.FirmwareVersion,
					MatchEvidence:        ev,
				}
			}
		}

		matches = append(matches, candidate{entry: e, confidence: conf, evidence: ev})
	}

	switch len(matches) {
	case 0:
		return &MatchResult{
			Status:          FingerprintStatusUnknown,
			RegistryVersion: registryVersion,
		}

	case 1:
		m0 := matches[0]
		return &MatchResult{
			Status:                   FingerprintStatusMatched,
			ProductDefinitionID:      m0.entry.ProductDefinitionID,
			ProductDefinitionVersion: m0.entry.ProductDefinitionVersion,
			RegistryVersion:          registryVersion,
			ActiveAdapterCandidate:   m0.entry.PreferredProtocol,
			FirmwareVersion:          evidence.FirmwareVersion,
			MatchConfidence:          m0.confidence,
			MatchEvidence:            m0.evidence,
		}

	default:
		// Multiple candidates — check for tie at the highest confidence level.
		// If multiple candidates have equal max confidence → CONFLICT.
		// If one candidate has strictly higher confidence → use it.
		best := matches[0]
		hasTie := false
		for _, c := range matches[1:] {
			if c.confidence > best.confidence {
				best = c
				hasTie = false
			} else if c.confidence == best.confidence {
				hasTie = true
			}
		}

		if hasTie {
			// Collect all PD IDs that share the max confidence.
			var candidates []string
			for _, c := range matches {
				if c.confidence == best.confidence {
					candidates = append(candidates, c.entry.ProductDefinitionID)
				}
			}
			slog.Warn("fingerprint: conflicting fingerprint matches — no inventory mutation will occur",
				"ip", evidence.IP, "candidates", candidates)
			return &MatchResult{
				Status:             FingerprintStatusConflict,
				RegistryVersion:    registryVersion,
				ConflictCandidates: candidates,
				ConflictReason: fmt.Sprintf(
					"multiple active definitions matched at confidence %.2f: %s",
					best.confidence, strings.Join(candidates, ", ")),
			}
		}

		// Single winner.
		return &MatchResult{
			Status:                   FingerprintStatusMatched,
			ProductDefinitionID:      best.entry.ProductDefinitionID,
			ProductDefinitionVersion: best.entry.ProductDefinitionVersion,
			RegistryVersion:          registryVersion,
			ActiveAdapterCandidate:   best.entry.PreferredProtocol,
			FirmwareVersion:          evidence.FirmwareVersion,
			MatchConfidence:          best.confidence,
			MatchEvidence:            best.evidence,
		}
	}
}

// ── Scoring ───────────────────────────────────────────────────────────────────

// score returns a confidence score in [0,1] for one registry entry against the
// provided evidence, along with a credential-free human-readable evidence string.
// Returns (0, "") when the entry does not match any evidence.
func score(entry RegistryEntry, ev ProbeEvidence) (float64, string) {
	// SNMP OID — highest confidence (exact) or medium (prefix).
	if entry.SNMPOIDExact != "" && ev.SNMPOIDSysObjectID != "" {
		if normaliseOID(ev.SNMPOIDSysObjectID) == normaliseOID(entry.SNMPOIDExact) {
			return 1.0, fmt.Sprintf("snmpOid exact match: %s", entry.SNMPOIDExact)
		}
	}
	if entry.SNMPOIDPrefix != "" && ev.SNMPOIDSysObjectID != "" {
		if strings.HasPrefix(normaliseOID(ev.SNMPOIDSysObjectID), normaliseOID(entry.SNMPOIDPrefix)) {
			return 0.8, fmt.Sprintf("snmpOid prefix match: %s*", entry.SNMPOIDPrefix)
		}
	}

	// SSH banner substring (case-insensitive).
	if entry.SSHBannerSubstring != "" && ev.SSHBanner != "" {
		if strings.Contains(strings.ToLower(ev.SSHBanner), strings.ToLower(entry.SSHBannerSubstring)) {
			return 0.75, fmt.Sprintf("sshBanner contains %q", entry.SSHBannerSubstring)
		}
	}

	// HTTP header substring.
	if entry.HTTPHeaderKey != "" && entry.HTTPHeaderContains != "" {
		headerVal := ev.HTTPResponseHeaders[strings.ToLower(entry.HTTPHeaderKey)]
		if headerVal == "" {
			// Try canonical-case key.
			headerVal = ev.HTTPResponseHeaders[entry.HTTPHeaderKey]
		}
		if strings.Contains(strings.ToLower(headerVal), strings.ToLower(entry.HTTPHeaderContains)) {
			return 0.7, fmt.Sprintf("httpHeader %s contains %q", entry.HTTPHeaderKey, entry.HTTPHeaderContains)
		}
	}

	// HTTP body substring.
	if entry.HTTPBodyContains != "" && ev.HTTPResponseBody != "" {
		if strings.Contains(ev.HTTPResponseBody, entry.HTTPBodyContains) {
			return 0.65, fmt.Sprintf("httpBody contains %q", entry.HTTPBodyContains)
		}
	}

	// gRPC service exact.
	if entry.GRPCServiceExact != "" {
		for _, svc := range ev.GRPCServices {
			if svc == entry.GRPCServiceExact {
				return 0.9, fmt.Sprintf("grpcService exact: %s", entry.GRPCServiceExact)
			}
		}
	}

	return 0, ""
}

// ── Firmware range ────────────────────────────────────────────────────────────

// firmwareInRange returns true when fw falls within [min, max] (inclusive).
// Empty min or max means no lower/upper bound.
// Comparison uses lexicographic ordering on version strings (semver-comparable
// strings like "23.4.1" compare correctly without parsing).
func firmwareInRange(fw, min, max string) bool {
	if min != "" && fw < min {
		return false
	}
	if max != "" && fw > max {
		return false
	}
	return true
}

// ── OID normalisation ─────────────────────────────────────────────────────────

// normaliseOID ensures the OID begins with a leading dot for consistent comparison.
func normaliseOID(oid string) string {
	if oid == "" {
		return ""
	}
	if !strings.HasPrefix(oid, ".") {
		return "." + oid
	}
	return oid
}
