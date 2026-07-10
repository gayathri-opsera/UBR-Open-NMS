/**
 * V2 Actor Attribution (WO-018)
 * Returns the current user's identity for use in API calls that track
 * who performed an action (acknowledge alarm, push config, etc.).
 */
import { useAuth } from '../../contexts/AuthContext';

export function useActor(): string {
  const { user } = useAuth();
  return user?.username ?? 'nms-operator';
}

/** Pure helper (for use outside React) — reads from localStorage directly. */
export function getActor(): string {
  try {
    const raw = localStorage.getItem('nms_user');
    if (!raw) return 'nms-operator';
    const user = JSON.parse(raw) as { username?: string };
    return user?.username ?? 'nms-operator';
  } catch {
    return 'nms-operator';
  }
}
