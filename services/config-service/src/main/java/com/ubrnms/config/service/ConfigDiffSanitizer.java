package com.ubrnms.config.service;

import com.ubrnms.config.model.ConfigVersion.DiffEntry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Utility for computing sanitized configuration diffs (WO-050).
 *
 * <p>Constraint: no inline secrets, rendered credential values, private keys, tokens,
 * or raw unredacted configuration payloads may be stored or returned.
 * This class redacts any value whose field name matches known secret patterns before
 * any diff entry is created.
 */
@Slf4j
@Component
public class ConfigDiffSanitizer {

    /**
     * Field-name patterns that indicate secret-like content.
     * Matched case-insensitively against field names.
     */
    private static final Set<String> SECRET_PATTERNS = Set.of(
            "password", "passwd", "secret", "token", "apikey", "api_key",
            "privatekey", "private_key", "presharedkey", "psk",
            "snmpcommunity", "snmp_community", "community",
            "wpakey", "wpa_key", "wpa_passphrase", "passphrase",
            "credential", "credentials", "auth", "authpassword", "auth_password",
            "privpassword", "priv_password", "key", "cert", "certificate"
    );

    /** Redaction marker prefix so downstream systems can identify redacted fields. */
    private static final String REDACTED_MARKER = "REDACTED_SECRET";

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Build a sanitized diff list from before/after configuration maps.
     * Only fields that actually changed are included.
     *
     * @param before previous configuration values (null treated as empty map)
     * @param after  new configuration values (null treated as empty map)
     * @return list of field-level changes with secret values redacted
     */
    public List<DiffEntry> buildSanitizedDiff(Map<String, Object> before, Map<String, Object> after) {
        Map<String, Object> safeBefore = before != null ? before : Collections.emptyMap();
        Map<String, Object> safeAfter  = after  != null ? after  : Collections.emptyMap();

        Set<String> allKeys = new LinkedHashSet<>();
        allKeys.addAll(safeBefore.keySet());
        allKeys.addAll(safeAfter.keySet());

        List<DiffEntry> diff = new ArrayList<>();
        for (String key : allKeys) {
            Object fromVal = safeBefore.get(key);
            Object toVal   = safeAfter.get(key);

            // Skip unchanged fields
            if (Objects.equals(fromVal, toVal)) {
                continue;
            }

            // Redact secret-like fields before adding to diff
            if (isSecretField(key)) {
                diff.add(new DiffEntry(key, REDACTED_MARKER, REDACTED_MARKER));
            } else {
                diff.add(new DiffEntry(key, fromVal, toVal));
            }
        }

        return diff;
    }

    /**
     * Build a human-readable diff summary string.
     * Example: "Changed 3 fields: txPower, ssid24, channel24"
     */
    public String buildDiffSummary(List<DiffEntry> sanitizedDiff) {
        if (sanitizedDiff == null || sanitizedDiff.isEmpty()) {
            return "No configuration parameters changed";
        }
        List<String> names = sanitizedDiff.stream()
                .map(DiffEntry::getField)
                .collect(Collectors.toList());
        int count = names.size();
        String fieldList = names.stream().limit(5).collect(Collectors.joining(", "));
        String suffix = count > 5 ? " +" + (count - 5) + " more" : "";
        return "Changed " + count + " field" + (count == 1 ? "" : "s") + ": " + fieldList + suffix;
    }

    /**
     * Compute a SHA-256 hash of the sanitized diff for integrity verification.
     * The hash is computed over the sanitized (post-redaction) representation,
     * so it covers only the safe-to-store content.
     *
     * @param sanitizedDiff the already-sanitized diff
     * @return hex-encoded SHA-256 hash, or null on error
     */
    public String computeRenderedHash(List<DiffEntry> sanitizedDiff) {
        if (sanitizedDiff == null) {
            return null;
        }
        try {
            String diffString = sanitizedDiff.stream()
                    .sorted(Comparator.comparing(DiffEntry::getField))
                    .map(e -> e.getField() + "=" + e.getTo())
                    .collect(Collectors.joining(","));
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(diffString.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            log.warn("SHA-256 not available for config hash computation: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Sanitize a configuration parameter map in-place.
     * Returns a copy with secret-like field values replaced by REDACTED_SECRET markers.
     * Safe to call on any arbitrary config map before logging or storing.
     *
     * @param params the raw parameter map to sanitize
     * @return a new sanitized copy; the original is not modified
     */
    public Map<String, Object> sanitizeParams(Map<String, Object> params) {
        if (params == null) {
            return Collections.emptyMap();
        }
        Map<String, Object> sanitized = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : params.entrySet()) {
            if (isSecretField(entry.getKey())) {
                sanitized.put(entry.getKey(), REDACTED_MARKER);
            } else if (entry.getValue() instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nested = (Map<String, Object>) entry.getValue();
                sanitized.put(entry.getKey(), sanitizeParams(nested));
            } else {
                sanitized.put(entry.getKey(), entry.getValue());
            }
        }
        return sanitized;
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Returns true if the field name matches any known secret-like pattern.
     * Matching is case-insensitive and checks if any secret pattern is contained
     * in the field name.
     */
    boolean isSecretField(String fieldName) {
        if (fieldName == null) return false;
        String lower = fieldName.toLowerCase();
        return SECRET_PATTERNS.stream().anyMatch(lower::contains);
    }
}
