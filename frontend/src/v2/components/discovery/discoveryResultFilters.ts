import type { DiscoveryResult } from '../../../api/discovery.api';

/** Active column filters for discovery results (WO-029). */
export interface DiscoveryResultFilters {
  icmpStatus: string[];
  snmpStatus: string[];
  vendor: string[];
  deviceType: string[];
  globalSearch: string;
}

export const EMPTY_FILTERS: DiscoveryResultFilters = {
  icmpStatus: [],
  snmpStatus: [],
  vendor: [],
  deviceType: [],
  globalSearch: '',
};

function includesIgnoreCase(haystack: string | undefined, needle: string): boolean {
  if (!needle) return true;
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

/**
 * Client-side AND filter over discovery results.
 * Empty filter arrays mean "no restriction" for that dimension.
 */
export function filterDiscoveryResults(
  results: DiscoveryResult[],
  filters: DiscoveryResultFilters,
): DiscoveryResult[] {
  return results.filter((row) => {
    if (filters.icmpStatus.length > 0 && !filters.icmpStatus.includes(row.icmpStatus)) {
      return false;
    }
    if (filters.snmpStatus.length > 0 && !filters.snmpStatus.includes(row.snmpStatus)) {
      return false;
    }
    if (filters.vendor.length > 0 && !filters.vendor.includes(row.vendor ?? '')) {
      return false;
    }
    if (filters.deviceType.length > 0 && !filters.deviceType.includes(row.genericDeviceType ?? '')) {
      return false;
    }
    if (filters.globalSearch.trim()) {
      const q = filters.globalSearch.trim();
      const searchable = [
        row.ip,
        row.vendor,
        row.model,
        row.genericDeviceType,
        row.sysObjectID,
        row.sysDescr,
        row.sysName,
        row.sysContact,
        row.sysLocation,
        row.classificationStatus,
        row.deferReason,
      ];
      if (!searchable.some((v) => includesIgnoreCase(v, q))) {
        return false;
      }
    }
    return true;
  });
}

/** Collect unique non-empty string values for a result field. */
export function uniqueFilterOptions(
  results: DiscoveryResult[],
  pick: (r: DiscoveryResult) => string | undefined,
): string[] {
  const seen = new Set<string>();
  for (const r of results) {
    const v = pick(r)?.trim();
    if (v) seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
