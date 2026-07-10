/**
 * V2 API layer — re-exports the V1 typed client and all service modules.
 * V2 pages import from here rather than from the V1 api/ folder directly,
 * which lets us swap the underlying client without touching pages.
 */
export { apiClient } from '../../api/client';
export * from '../../api/alarms.api';
export * from '../../api/alarms.types';
export * from '../../api/devices.api';
export * from '../../api/devices.types';
export * from '../../api/kpi.api';
export * from '../../api/kpi.types';
export * from '../../api/topology.api';
export * from '../../api/topology.types';
export * from '../../api/admin.api';
export * from '../../api/admin.types';
export * from '../../api/auth.api';
export * from '../../api/config.api';
export * from '../../api/config.types';
