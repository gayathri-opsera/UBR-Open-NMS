// Package oidalias maps enterprise-root aliases to a canonical root.
//
// Some devices serve the SAME MIB tree under a different enterprise root depending on firmware.
// UBR650/655 firmware 1.0.0.149 reports sysObjectID .1.3.6.1.4.1.52619 and serves its objects under
// .1.3.6.1.4.1.52619.*; firmware 1.0.0.163/.164 reports .1.3.6.1.4.1.14125.123 and serves the identical
// layout under .1.3.6.1.4.1.14125.123.* (and no longer answers under the old root). Verified on hardware:
// every column and row lines up one-to-one, only the prefix differs.
//
// Classification and fingerprint matching compare the CANONICAL form of a device's sysObjectID, so a
// unit on newer firmware is recognised as the same product; reads of vendor objects address the device
// under ITS OWN root (Rebase). This mirrors services/api-gateway/src/live/oidAliases.js — keep the two
// tables in step.
package oidalias

import "strings"

type pair struct{ canonical, alias string }

var pairs = []pair{
	{canonical: ".1.3.6.1.4.1.52619", alias: ".1.3.6.1.4.1.14125.123"},
}

func dotted(oid string) string {
	oid = strings.TrimSpace(oid)
	if oid == "" {
		return ""
	}
	return "." + strings.TrimPrefix(oid, ".")
}

func under(oid, root string) bool {
	return oid == root || strings.HasPrefix(oid, root+".")
}

func aliasOf(sysObjectID string) (pair, bool) {
	oid := dotted(sysObjectID)
	if oid == "" {
		return pair{}, false
	}
	for _, p := range pairs {
		if under(oid, p.alias) {
			return p, true
		}
	}
	return pair{}, false
}

// Canonical returns the OID with an alias enterprise root replaced by its canonical root, and with a
// leading dot. OIDs under no alias are only normalised; the empty string stays empty.
func Canonical(oid string) string {
	d := dotted(oid)
	if p, ok := aliasOf(d); ok {
		return p.canonical + strings.TrimPrefix(d, p.alias)
	}
	return d
}

// Rebase addresses an OID written under the canonical root on a specific device: when the device lives
// under an alias root the prefix is swapped, otherwise the OID is returned (dotted) as is.
func Rebase(oid, deviceSysObjectID string) string {
	d := dotted(oid)
	p, ok := aliasOf(deviceSysObjectID)
	if !ok || !under(d, p.canonical) {
		return d
	}
	return p.alias + strings.TrimPrefix(d, p.canonical)
}
