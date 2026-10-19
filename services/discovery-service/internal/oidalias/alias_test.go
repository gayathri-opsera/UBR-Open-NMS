package oidalias

import "testing"

const (
	oldRoot = ".1.3.6.1.4.1.52619"
	newRoot = ".1.3.6.1.4.1.14125.123"
)

func TestCanonical(t *testing.T) {
	cases := map[string]string{
		"1.3.6.1.4.1.14125.123":    oldRoot,
		".1.3.6.1.4.1.14125.123.5": oldRoot + ".5",
		"1.3.6.1.4.1.52619":        oldRoot,
		"1.3.6.1.4.1.9.1.1":        ".1.3.6.1.4.1.9.1.1",
		"1.3.6.1.4.1.14125.1234":   ".1.3.6.1.4.1.14125.1234", // a longer arc is not the alias
		"":                         "",
	}
	for in, want := range cases {
		if got := Canonical(in); got != want {
			t.Errorf("Canonical(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRebase(t *testing.T) {
	cases := []struct{ oid, dev, want string }{
		{oldRoot + ".1.2.3.1.0", "1.3.6.1.4.1.14125.123", newRoot + ".1.2.3.1.0"},
		{"1.3.6.1.4.1.52619.1.1.1.1.1.2", ".1.3.6.1.4.1.14125.123", newRoot + ".1.1.1.1.1.2"},
		{oldRoot + ".1.2.3.1.0", "1.3.6.1.4.1.52619", oldRoot + ".1.2.3.1.0"}, // canonical device untouched
		{"1.3.6.1.2.1.1.5.0", "1.3.6.1.4.1.14125.123", ".1.3.6.1.2.1.1.5.0"},  // MIB-II untouched
		{oldRoot + ".1", "", oldRoot + ".1"},                                  // unknown device untouched
	}
	for _, c := range cases {
		if got := Rebase(c.oid, c.dev); got != c.want {
			t.Errorf("Rebase(%q, %q) = %q, want %q", c.oid, c.dev, got, c.want)
		}
	}
}
