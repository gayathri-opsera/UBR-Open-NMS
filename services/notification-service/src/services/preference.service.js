'use strict';
/** In-memory per-user notification preferences. Replace with MongoDB for production. */
const preferences = new Map(); // userId → { email, sms, minSeverity }

const SEVERITY_ORDER = { CRITICAL: 0, MAJOR: 1, MINOR: 2, WARNING: 3, INFO: 4 };

function setPreferences(userId, prefs) {
  preferences.set(userId, {
    email: prefs.email !== false,
    sms: prefs.sms !== false,
    minSeverity: prefs.minSeverity || 'WARNING',
  });
}

function getPreferences(userId) {
  return preferences.get(userId) || { email: true, sms: false, minSeverity: 'WARNING' };
}

/**
 * Returns true if the alarm's severity meets the user's minimum.
 */
function shouldNotify(userId, alarmSeverity) {
  const prefs = getPreferences(userId);
  const alarmLevel = SEVERITY_ORDER[alarmSeverity] ?? 99;
  const minLevel = SEVERITY_ORDER[prefs.minSeverity] ?? 99;
  return alarmLevel <= minLevel;
}

module.exports = { setPreferences, getPreferences, shouldNotify };
