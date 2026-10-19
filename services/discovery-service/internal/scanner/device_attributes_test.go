package scanner

import (
	"context"
	"strconv"
	"testing"
	"time"
)

type attrFakeClient struct {
	values map[string]string
	walk   map[string][]WalkEntry
}

func (f *attrFakeClient) GetOIDs(_ context.Context, _ string, oids []string) (map[string]string, error) {
	out := make(map[string]string, len(oids))
	for _, o := range oids {
		out[o] = f.values[o]
	}
	return out, nil
}

func (f *attrFakeClient) WalkOID(_ context.Context, _ string, root string) ([]WalkEntry, error) {
	return f.walk[root], nil
}

const eocRoleOID = ".1.3.6.1.4.1.52619.1.1.1.1.1.2"

func TestFetchDeviceAttributes_EOCRoleFromScalar(t *testing.T) {
	c := &attrFakeClient{values: map[string]string{eocRoleOID: "2"}}
	a := FetchDeviceAttributes(context.Background(), c, "10.0.0.1", ".1.3.6.1.4.1.52619.1.1", "")
	if a.Role != "CPE" {
		t.Fatalf("role = %q, want CPE", a.Role)
	}
}

func TestFetchDeviceAttributes_EOCRoleFromTableWalk(t *testing.T) {
	c := &attrFakeClient{walk: map[string][]WalkEntry{
		eocRoleOID: {{OID: eocRoleOID + ".1", Value: "1"}},
	}}
	a := FetchDeviceAttributes(context.Background(), c, "10.0.0.1", ".1.3.6.1.4.1.52619", "")
	if a.Role != "BTS" || a.RoleSource != "snmp "+eocRoleOID+".1=1" {
		t.Fatalf("got role=%q source=%q", a.Role, a.RoleSource)
	}
}

func TestFetchDeviceAttributes_UnknownVendorHasNoRole(t *testing.T) {
	c := &attrFakeClient{values: map[string]string{eocRoleOID: "1"}}
	a := FetchDeviceAttributes(context.Background(), c, "10.0.0.1", ".1.3.6.1.4.1.526190", "office")
	if a.Role != "" || a.Latitude != nil {
		t.Fatalf("expected no attributes, got %+v", a)
	}
}

func TestFetchDeviceAttributes_CoordinatesFromSysLocation(t *testing.T) {
	a := FetchDeviceAttributes(context.Background(), &attrFakeClient{}, "10.0.0.1", ".1.3.6.1.4.1.9.1", "Tower 4 (28.6139, 77.2090)")
	if a.Latitude == nil || *a.Latitude != 28.6139 || *a.Longitude != 77.2090 || a.LocationSource != "sysLocation" {
		t.Fatalf("got %+v", a)
	}
}

func TestParseLocationCoordinates_RejectsNonCoordinates(t *testing.T) {
	for _, s := range []string{"office", "Floor 2, Room 5", "", "Rack 12 / Slot 3"} {
		if _, _, ok := ParseLocationCoordinates(s); ok {
			t.Errorf("%q parsed as coordinates", s)
		}
	}
}

func TestParseCoordinate_Encodings(t *testing.T) {
	cases := []struct {
		raw   string
		scale float64
		want  float64
	}{
		{"28.6139", 0, 28.6139},
		{"-77.2", 0, -77.2},
		{"28.5N", 0, 28.5},
		{"77.25W", 0, -77.25},
		{"2836.834N", 0, 28 + 36.834/60},
		{"286139000", 1e7, 28.6139},
	}
	for _, c := range cases {
		got, ok := parseCoordinate(c.raw, c.scale, 180)
		if !ok || got-c.want > 1e-9 || c.want-got > 1e-9 {
			t.Errorf("parseCoordinate(%q) = %v,%v want %v", c.raw, got, ok, c.want)
		}
	}
}

func TestNormaliseRole_Text(t *testing.T) {
	for raw, want := range map[string]string{"BTS(ap)": "BTS", "CPE(sta)": "CPE", "station": "CPE", "unknown": ""} {
		if got := normaliseRole(raw, nil); got != want {
			t.Errorf("normaliseRole(%q) = %q want %q", raw, got, want)
		}
	}
}

// ── multi-radio units: the role comes from the whole radio-mode column ─────────

func radioColumn(root string, modes ...string) map[string][]WalkEntry {
	var entries []WalkEntry
	for i, m := range modes {
		entries = append(entries, WalkEntry{OID: root + "." + strconv.Itoa(i+1), Value: m})
	}
	return map[string][]WalkEntry{root: entries}
}

func TestFetchDeviceAttributes_AllRadiosAPIsBTS(t *testing.T) { // 10.0.150.6
	c := &attrFakeClient{walk: radioColumn(eocRoleOID, "ap", "ap", "ap")}
	a := FetchDeviceAttributes(context.Background(), c, "h", ".1.3.6.1.4.1.52619", "")
	want := "snmp " + eocRoleOID + ".1=ap (radios: 1=ap, 2=ap, 3=ap)"
	if a.Role != "BTS" || a.RoleSource != want {
		t.Fatalf("got role=%q source=%q", a.Role, a.RoleSource)
	}
}

func TestFetchDeviceAttributes_StationRadioMakesItACPE(t *testing.T) { // 10.0.150.16 (new firmware root)
	root := ".1.3.6.1.4.1.14125.123.1.1.1.1.1.2"
	c := &attrFakeClient{walk: radioColumn(root, "ap", "sta", "ap")}
	a := FetchDeviceAttributes(context.Background(), c, "h", "1.3.6.1.4.1.14125.123", "")
	want := "snmp " + root + ".2=sta (radios: 1=ap, 2=sta, 3=ap)"
	if a.Role != "CPE" || a.RoleSource != want {
		t.Fatalf("got role=%q source=%q", a.Role, a.RoleSource)
	}
}

func TestFetchDeviceAttributes_TwoRadioCPE(t *testing.T) { // 10.0.150.12
	root := ".1.3.6.1.4.1.14125.123.1.1.1.1.1.2"
	c := &attrFakeClient{walk: radioColumn(root, "ap", "sta")}
	if a := FetchDeviceAttributes(context.Background(), c, "h", ".1.3.6.1.4.1.14125.123", ""); a.Role != "CPE" {
		t.Fatalf("role = %q, want CPE", a.Role)
	}
}

func TestFetchDeviceAttributes_NewRootDeviceIsAskedUnderItsOwnRoot(t *testing.T) {
	// data only exists under the canonical root: a new-root device must NOT be read from there
	c := &attrFakeClient{walk: radioColumn(eocRoleOID, "ap", "sta")}
	if a := FetchDeviceAttributes(context.Background(), c, "h", ".1.3.6.1.4.1.14125.123", ""); a.Role != "" {
		t.Fatalf("role = %q, want none (nothing is served under the new root in this fake)", a.Role)
	}
}

func TestSplitAttemptTimeout(t *testing.T) {
	cases := []struct {
		total     time.Duration
		perTry    time.Duration
		extraTrys int
	}{
		{5 * time.Second, 1250 * time.Millisecond, 3}, // the default 5 s attempt → 4 transmissions
		{10 * time.Second, 2500 * time.Millisecond, 3},
		{2 * time.Second, time.Second, 1},              // short timeouts keep >= 1 s per transmission
		{500 * time.Millisecond, 500 * time.Millisecond, 0},
		{0, 0, 0},
	}
	for _, c := range cases {
		per, extra := splitAttemptTimeout(c.total)
		if per != c.perTry || extra != c.extraTrys {
			t.Errorf("splitAttemptTimeout(%v) = (%v, %d), want (%v, %d)", c.total, per, extra, c.perTry, c.extraTrys)
		}
		if c.total > 0 && per*time.Duration(extra+1) > c.total {
			t.Errorf("splitAttemptTimeout(%v) waits longer than the attempt: %v x %d", c.total, per, extra+1)
		}
	}
}
