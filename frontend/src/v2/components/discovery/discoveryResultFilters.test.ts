import { describe, it, expect } from 'vitest';

import { filterDiscoveryResults, uniqueFilterOptions } from './discoveryResultFilters';
import { mockDiscoveryResults, mockResultCiscoSwitch } from '../../../api/mocks/discovery.mocks';

describe('filterDiscoveryResults', () => {
  it('returns all rows when filters are empty', () => {
    const out = filterDiscoveryResults(mockDiscoveryResults, {
      icmpStatus: [],
      snmpStatus: [],
      vendor: [],
      deviceType: [],
      globalSearch: '',
    });
    expect(out).toHaveLength(mockDiscoveryResults.length);
  });

  it('filters by vendor with AND logic', () => {
    const out = filterDiscoveryResults(mockDiscoveryResults, {
      icmpStatus: [],
      snmpStatus: [],
      vendor: ['Cisco'],
      deviceType: [],
      globalSearch: '',
    });
    expect(out.every((r) => r.vendor === 'Cisco')).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it('combines vendor and snmp filters', () => {
    const out = filterDiscoveryResults(mockDiscoveryResults, {
      icmpStatus: ['reachable'],
      snmpStatus: ['success'],
      vendor: [],
      deviceType: [],
      globalSearch: '',
    });
    expect(out.every((r) => r.icmpStatus === 'reachable' && r.snmpStatus === 'success')).toBe(true);
  });

  it('filters by global search across columns', () => {
    const out = filterDiscoveryResults(mockDiscoveryResults, {
      icmpStatus: [],
      snmpStatus: [],
      vendor: [],
      deviceType: [],
      globalSearch: 'Juniper',
    });
    expect(out).toHaveLength(1);
    expect(out[0].vendor).toBe('Juniper');
  });

  it('returns empty array when no rows match', () => {
    const out = filterDiscoveryResults(mockDiscoveryResults, {
      icmpStatus: [],
      snmpStatus: [],
      vendor: ['NonexistentVendor'],
      deviceType: [],
      globalSearch: '',
    });
    expect(out).toHaveLength(0);
  });
});

describe('uniqueFilterOptions', () => {
  it('collects sorted unique vendors', () => {
    const vendors = uniqueFilterOptions(mockDiscoveryResults, (r) => r.vendor);
    expect(vendors).toContain('Cisco');
    expect(vendors).toEqual([...vendors].sort());
  });

  it('includes sysName from MIB-II fields in search', () => {
    const out = filterDiscoveryResults([mockResultCiscoSwitch], {
      icmpStatus: [],
      snmpStatus: [],
      vendor: [],
      deviceType: [],
      globalSearch: 'core-sw-01',
    });
    expect(out).toHaveLength(1);
  });
});
