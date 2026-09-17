package com.ubrnms.productdef.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.Builder;
import lombok.AllArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.CompoundIndexes;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.List;

/**
 * Runtime fingerprint lookup entry generated from an activated Product Definition.
 *
 * <p>Each activated definition may produce multiple entries — one per fingerprint
 * declared in its normalised metadata.  Registry rebuild replaces all entries for
 * a given {@code productDefinitionId} atomically so consumers always see a
 * consistent snapshot.
 *
 * <p>Indexed for fast lookup by {@code registryVersion} and fingerprint value so
 * the discovery service can resolve device fingerprints without scanning the full
 * collection.
 *
 * <p><b>Credential policy:</b> no community strings, passwords, or vault paths
 * may appear in any field of this document.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "fingerprint_registry_entries")
@CompoundIndexes({
    @CompoundIndex(name = "idx_freg_def_ver", def = "{'productDefinitionId': 1, 'registryVersion': 1}"),
    @CompoundIndex(name = "idx_freg_oid_fw",  def = "{'fingerprintValue': 1, 'firmwareFrom': 1, 'firmwareTo': 1}", unique = false)
})
public class FingerprintRegistryEntry {

    @Id
    private String id;

    /** Stable ID of the product definition this entry belongs to (e.g. cisco-asr-1000). */
    @Indexed
    private String productDefinitionId;

    /** The activated version that produced this entry. */
    private String versionId;

    /**
     * Fingerprint type: {@code SNMP_OID}, {@code BANNER}, or {@code HEADER}.
     * SNMP_OID is the primary type; BANNER and HEADER are based on sysDescr patterns.
     */
    private String fingerprintType;

    /**
     * The fingerprint value.  For SNMP_OID entries this is the dotted-numeric OID
     * (e.g. {@code .1.3.6.1.4.1.9.1.1045}).  For BANNER / HEADER entries this is
     * the regex pattern matched against sysDescr or banner text.
     */
    @Indexed
    private String fingerprintValue;

    // ── Product identity ────────────────────────────────────────────────────

    private String vendor;
    private String model;
    private String productFamily;

    /** Lower bound of the firmware version range this fingerprint covers (inclusive). */
    private String firmwareFrom;

    /** Upper bound of the firmware version range this fingerprint covers (inclusive). */
    private String firmwareTo;

    // ── Discovery hints ──────────────────────────────────────────────────────

    /** Ordered list of protocols supported by this product (e.g. SNMP, REST, CLI). */
    private List<String> supportedProtocols;

    // ── Registry versioning ──────────────────────────────────────────────────

    /**
     * Monotonically increasing counter advanced on every activation or rollback.
     * Allows downstream consumers to detect and discard stale cached data.
     */
    private long registryVersion;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}
