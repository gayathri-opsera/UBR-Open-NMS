'use strict';

/**
 * May a Custom UI screen be deleted?
 *   • a draft: yes (as before)
 *   • a published screen: only by an admin, and only when no device is using it — deleting it would leave those devices
 *     with no Node View layout. The caller has to deprovision / relink them first.
 */
function deletePolicy({ status, role, linkedDevices = [] }) {
  if (status !== 'published') return { ok: true };
  const r = String(role || '').toLowerCase();
  if (r !== 'admin' && r !== 'superadmin') {
    return { ok: false, http: 403, code: 'FORBIDDEN', message: 'Only an administrator can delete a published screen' };
  }
  if (linkedDevices.length > 0) {
    const names = linkedDevices.slice(0, 5).map((d) => d.serialNumber || d.ipAddress || String(d._id)).join(', ');
    const more = linkedDevices.length > 5 ? ` and ${linkedDevices.length - 5} more` : '';
    return {
      ok: false, http: 409, code: 'IN_USE',
      message: `${linkedDevices.length} device(s) still use this screen (${names}${more}). Deprovision them or link them to another screen first.`,
      devices: linkedDevices.slice(0, 20).map((d) => ({ id: String(d._id), serialNumber: d.serialNumber || null, ipAddress: d.ipAddress || null })),
    };
  }
  return { ok: true };
}

module.exports = { deletePolicy };
