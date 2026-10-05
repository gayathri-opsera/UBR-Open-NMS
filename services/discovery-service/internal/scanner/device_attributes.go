package scanner

import (
	"context"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// DeviceAttributes holds device-reported facts that go beyond the MIB-II system
// group: the operational role (e.g. BTS vs CPE) and GPS coordinates.
// Every field is optional — an empty value means the device did not report it,
// never a guessed default.
type DeviceAttributes struct {
	// Role is the normalised device role (BTS, CPE, IDU, …). Empty when unknown.
	Role string
	// RoleSource describes where Role came from, e.g. "snmp .1.3.6...=1".
	RoleSource string
	// Latitude and Longitude are decimal degrees. Nil when not reported.
	Latitude  *float64
	Longitude *float64
	// LocationSource describes where the coordinates came from.
	LocationSource string
}

// vendorAttributeProfile describes the vendor-specific OIDs that report a
// device's role and GPS position. Profiles are matched by enterprise prefix of
// sysObjectID; the longest matching prefix wins.
type vendorAttributeProfile struct {
	enterprisePrefix string

	// roleOID reports the device role. It may be a scalar (.0), a bare column
	// OID, or a table column — the first instance found is used.
	roleOID string
	// roleValues maps raw SNMP values (integer enums) to a role.
	roleValues map[string]string

	// latitudeOID / longitudeOID report GPS position; see parseCoordinate for
	// the accepted encodings. coordScale divides integer-encoded values
	// (e.g. 1e7 for degrees×10⁷); 0 means values are already in degrees.
	latitudeOID  string
	longitudeOID string
	coordScale   float64
}

// attributeProfiles is the per-vendor attribute map. Add a vendor's role and GPS
// OIDs here when its MIB is known.
var attributeProfiles = []vendorAttributeProfile{
	// EOC Networks (enterprise 52619) — radioMode from the Configurations_GUI
	// product definition: 1 = BTS(ap), 2 = CPE(sta).
	{
		enterprisePrefix: ".1.3.6.1.4.1.52619",
		roleOID:          ".1.3.6.1.4.1.52619.1.1.1.1.1.2",
		roleValues:       map[string]string{"1": "BTS", "2": "CPE"},
	},
}

// FetchDeviceAttributes reads role and GPS position from the device. It is
// best-effort: SNMP failures leave the corresponding fields empty.
func FetchDeviceAttributes(ctx context.Context, client SNMPClient, host, sysObjectID, sysLocation string) DeviceAttributes {
	var attrs DeviceAttributes

	if p, ok := matchAttributeProfile(sysObjectID); ok {
		if p.roleOID != "" {
			if oid, raw := readFirstInstance(ctx, client, host, p.roleOID); raw != "" {
				if role := normaliseRole(raw, p.roleValues); role != "" {
					attrs.Role = role
					attrs.RoleSource = "snmp " + oid + "=" + raw
				}
			}
		}
		if p.latitudeOID != "" && p.longitudeOID != "" {
			_, latRaw := readFirstInstance(ctx, client, host, p.latitudeOID)
			_, lngRaw := readFirstInstance(ctx, client, host, p.longitudeOID)
			lat, latOK := parseCoordinate(latRaw, p.coordScale, 90)
			lng, lngOK := parseCoordinate(lngRaw, p.coordScale, 180)
			if latOK && lngOK && !(lat == 0 && lng == 0) {
				attrs.Latitude, attrs.Longitude = &lat, &lng
				attrs.LocationSource = "snmp " + p.latitudeOID + "," + p.longitudeOID
			}
		}
	}

	// Fall back to a coordinate pair written into sysLocation (e.g. "28.6139,77.2090").
	if attrs.Latitude == nil {
		if lat, lng, ok := ParseLocationCoordinates(sysLocation); ok {
			attrs.Latitude, attrs.Longitude = &lat, &lng
			attrs.LocationSource = "sysLocation"
		}
	}
	return attrs
}

func matchAttributeProfile(sysObjectID string) (vendorAttributeProfile, bool) {
	oid := "." + strings.TrimPrefix(sysObjectID, ".")
	var best vendorAttributeProfile
	found := false
	for _, p := range attributeProfiles {
		if (oid == p.enterprisePrefix || strings.HasPrefix(oid, p.enterprisePrefix+".")) &&
			len(p.enterprisePrefix) > len(best.enterprisePrefix) {
			best, found = p, true
		}
	}
	return best, found
}

// readFirstInstance returns the first non-empty value at oid, trying the bare
// OID, the scalar instance (.0), the first row (.1), then a subtree walk.
func readFirstInstance(ctx context.Context, client SNMPClient, host, oid string) (string, string) {
	oid = "." + strings.TrimPrefix(oid, ".")
	candidates := []string{oid, oid + ".0", oid + ".1"}
	if values, err := client.GetOIDs(ctx, host, candidates); err == nil {
		for _, c := range candidates {
			if v := strings.TrimSpace(values[c]); v != "" {
				return c, v
			}
		}
	}
	if walker, ok := client.(MACWalker); ok {
		if entries, err := walker.WalkOID(ctx, host, oid); err == nil {
			for _, e := range entries {
				if v := strings.TrimSpace(e.Value); v != "" {
					return e.OID, v
				}
			}
		}
	}
	return "", ""
}

// normaliseRole maps a raw role value to BTS/CPE/IDU. Integer enums use the
// profile's map; text values such as "BTS(ap)" or "CPE(sta)" are matched by keyword.
func normaliseRole(raw string, enum map[string]string) string {
	if role, ok := enum[raw]; ok {
		return role
	}
	v := strings.ToLower(raw)
	switch {
	case strings.Contains(v, "bts") || strings.Contains(v, "(ap)") || v == "ap" ||
		strings.Contains(v, "access point") || strings.Contains(v, "master"):
		return "BTS"
	case strings.Contains(v, "cpe") || strings.Contains(v, "(sta)") || v == "sta" ||
		strings.Contains(v, "station") || strings.Contains(v, "slave"):
		return "CPE"
	case strings.Contains(v, "idu"):
		return "IDU"
	}
	return ""
}

var nmeaPattern = regexp.MustCompile(`^(\d{2,3})(\d{2}\.\d+)\s*([NSEW])$`)

// parseCoordinate converts a device-reported coordinate to decimal degrees.
// Accepted encodings: decimal degrees ("28.6139", "-77.2"), decimal with a
// hemisphere suffix ("28.6139N"), NMEA ddmm.mmmm ("2836.834N"), and integers
// scaled by `scale` when scale > 0.
func parseCoordinate(raw string, scale, limit float64) (float64, bool) {
	s := strings.ToUpper(strings.TrimSpace(raw))
	if s == "" {
		return 0, false
	}
	if m := nmeaPattern.FindStringSubmatch(s); m != nil {
		deg, _ := strconv.ParseFloat(m[1], 64)
		min, _ := strconv.ParseFloat(m[2], 64)
		v := deg + min/60
		if m[3] == "S" || m[3] == "W" {
			v = -v
		}
		return v, math.Abs(v) <= limit
	}
	sign := 1.0
	if n := len(s); n > 1 && strings.ContainsAny(s[n-1:], "NSEW") {
		if s[n-1] == 'S' || s[n-1] == 'W' {
			sign = -1
		}
		s = strings.TrimSpace(s[:n-1])
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	if scale > 0 {
		v /= scale
	}
	v *= sign
	return v, math.Abs(v) <= limit
}

// locationPairPattern matches two decimal numbers (each with a fractional part)
// such as "28.6139,77.2090", "lat:28.61 lng:77.20" or "(28.61, 77.20)".
var locationPairPattern = regexp.MustCompile(`(-?\d{1,3}\.\d+)\s*[NS]?[\s,;/]+(?:[a-zA-Z]+\s*[:=]\s*)?(-?\d{1,3}\.\d+)`)

// ParseLocationCoordinates extracts a latitude/longitude pair from free-text
// sysLocation. Requiring a fractional part on both numbers avoids matching
// strings like "Floor 2, Room 5".
func ParseLocationCoordinates(sysLocation string) (float64, float64, bool) {
	m := locationPairPattern.FindStringSubmatch(sysLocation)
	if m == nil {
		return 0, 0, false
	}
	lat, err1 := strconv.ParseFloat(m[1], 64)
	lng, err2 := strconv.ParseFloat(m[2], 64)
	if err1 != nil || err2 != nil || math.Abs(lat) > 90 || math.Abs(lng) > 180 {
		return 0, 0, false
	}
	return lat, lng, true
}
