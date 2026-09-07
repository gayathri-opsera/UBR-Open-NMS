/**
 * WO-047: Tests for Device Investigation Panel
 */
import { describe, it, expect } from 'vitest';
import { normalizeDeviceIdentity, buildInvestigationRouteParams } from '../../types/device-investigation-context';

describe('DeviceInvestigationPanel', () => {
  describe('normalizeDeviceIdentity', () => {
    it('normalizes device with deviceId', () => {
      const result = normalizeDeviceIdentity({
        deviceId: 'dev-001',
        displayName: 'Test Device',
      });

      expect(result.deviceId).toBe('dev-001');
      expect(result.displayName).toBe('Test Device');
    });

    it('normalizes device with serialNumber', () => {
      const result = normalizeDeviceIdentity({
        serialNumber: 'SN-001',
        displayName: 'Test Device',
      });

      expect(result.deviceId).toBe('SN-001');
      expect(result.serialNumber).toBe('SN-001');
    });

    it('throws error if neither deviceId nor serialNumber provided', () => {
      expect(() => normalizeDeviceIdentity({})).toThrow();
    });

    it('uses deviceId as displayName fallback', () => {
      const result = normalizeDeviceIdentity({
        deviceId: 'dev-001',
      });

      expect(result.displayName).toBe('dev-001');
    });
  });

  describe('buildInvestigationRouteParams', () => {
    it('builds params with device ID', () => {
      const params = buildInvestigationRouteParams({
        deviceId: 'dev-001',
        displayName: 'Test',
      });

      expect(params.deviceId).toBe('dev-001');
    });

    it('includes optional filters', () => {
      const params = buildInvestigationRouteParams(
        {
          deviceId: 'dev-001',
          serialNumber: 'SN-001',
          displayName: 'Test',
        },
        {
          timeRange: '1h',
          metricName: 'latency',
        }
      );

      expect(params.deviceId).toBe('dev-001');
      expect(params.serialNumber).toBe('SN-001');
      expect(params.timeRange).toBe('1h');
      expect(params.metricName).toBe('latency');
    });

    it('serializes topology filters', () => {
      const params = buildInvestigationRouteParams(
        {
          deviceId: 'dev-001',
          displayName: 'Test',
        },
        {
          topologyFilters: { layer: 'access', status: 'active' },
        }
      );

      expect(params.topologyFilters).toBe(JSON.stringify({ layer: 'access', status: 'active' }));
    });
  });
});
