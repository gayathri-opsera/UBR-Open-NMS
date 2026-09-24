package com.ubrnms.productdef.service;

import java.util.regex.Pattern;

/**
 * Redacts secret material from audit record text fields before persistence (WO-020).
 *
 * <p>The redactor applies a deny-list of patterns that are likely to indicate
 * credential values, vault paths, community strings, or other sensitive data
 * that must never appear in the immutable audit log.
 *
 * <p>All patterns are applied to {@code changeSummary} and {@code reason} fields
 * before the event record is saved.  If a pattern matches, the sensitive portion
 * is replaced with {@code [REDACTED]}.
 *
 * <p>This is a best-effort defence-in-depth layer — the primary safeguard is that
 * callers must never pass credential objects or raw file content to audit methods.
 * This utility catches accidental interpolations.
 */
public final class AuditRecordRedactor {

    private AuditRecordRedactor() { /* static utility */ }

    // ── Redaction patterns ────────────────────────────────────────────────────

    /**
     * Patterns that indicate a credential value or secret material.
     *
     * <p>Matched case-insensitively.  Ordered from most-specific to least-specific
     * so the most informative match wins.
     */
    private static final Pattern[] DENY_PATTERNS = {
        // SNMP community strings embedded in text (e.g. "community=public123")
        Pattern.compile("(?i)(community\\s*[:=]\\s*)\\S+"),
        // Passwords in key=value form
        Pattern.compile("(?i)(password\\s*[:=]\\s*)\\S+"),
        // API keys or tokens
        Pattern.compile("(?i)(api[_-]?key\\s*[:=]\\s*)\\S+"),
        Pattern.compile("(?i)(token\\s*[:=]\\s*)\\S+"),
        // Vault paths (e.g. secret/data/myapp/snmp) — no capture group; full match is redacted
        Pattern.compile("(?i)secret/[a-zA-Z0-9/_-]+"),
        // Bearer tokens or JWT-looking strings
        Pattern.compile("(?i)Bearer\\s+[A-Za-z0-9._\\-+/]{20,}"),
        // AWS secret-access-key or similar patterns
        Pattern.compile("(?i)(secret[_-]?access[_-]?key\\s*[:=]\\s*)\\S+"),
        // Base64-looking long strings that could be secrets (≥40 chars, base64 chars only)
        Pattern.compile("[A-Za-z0-9+/]{40,}={0,2}"),
    };

    private static final String REDACTED = "[REDACTED]";

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Redacts known secret patterns from a text field value.
     *
     * @param input the raw text to sanitize; may be {@code null}
     * @return the sanitized text with sensitive substrings replaced by {@code [REDACTED]},
     *         or {@code null} if the input is {@code null}
     */
    public static String redact(String input) {
        if (input == null || input.isBlank()) return input;

        String result = input;
        for (Pattern p : DENY_PATTERNS) {
            result = p.matcher(result).replaceAll((match) -> {
                // For patterns with a capture group (prefix), keep the prefix and redact the rest
                try {
                    String group1 = match.group(1);
                    return group1 + REDACTED;
                } catch (IndexOutOfBoundsException e) {
                    // Pattern has no capture group — redact the entire match
                    return REDACTED;
                }
            });
        }
        return result;
    }

    /**
     * Returns {@code true} if the input contains any pattern that indicates
     * secret material, without performing redaction.
     *
     * <p>Use this to guard against injecting raw objects (e.g. full credential DTOs)
     * into audit summaries.
     */
    public static boolean containsSecretMaterial(String input) {
        if (input == null || input.isBlank()) return false;
        for (Pattern p : DENY_PATTERNS) {
            if (p.matcher(input).find()) return true;
        }
        return false;
    }
}
