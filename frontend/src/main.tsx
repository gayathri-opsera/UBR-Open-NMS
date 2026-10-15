import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// ── Chunk load error auto-recovery ───────────────────────────────────────────
// When the app is rebuilt (new chunk hashes), React lazy imports for old chunks
// fail with "Failed to fetch dynamically imported module". Detect this and do a
// single hard reload to pick up the new index.html + fresh chunk filenames.
window.addEventListener('error', (event) => {
  const msg = event.message || '';
  if (msg.includes('dynamically imported module') || msg.includes('Failed to fetch')) {
    const reloaded = sessionStorage.getItem('chunk_reload');
    if (!reloaded) {
      sessionStorage.setItem('chunk_reload', '1');
      window.location.reload();
    } else {
      // Already tried once — clear flag so future navigations can retry
      sessionStorage.removeItem('chunk_reload');
    }
  }
});
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event.reason?.message || event.reason || '');
  if (msg.includes('dynamically imported module') || msg.includes('Failed to fetch')) {
    const reloaded = sessionStorage.getItem('chunk_reload');
    if (!reloaded) {
      sessionStorage.setItem('chunk_reload', '1');
      window.location.reload();
    } else {
      sessionStorage.removeItem('chunk_reload');
    }
  }
});

// Aggressively remove any stale service workers (e.g. from previous Workbox/PWA
// deployments) that intercept API calls and redirect them to the wrong origin.
if ('serviceWorker' in navigator) {
  // Unregister all existing workers
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((reg) => reg.unregister());
  });

  // Register a tombstone SW that immediately unregisters itself,
  // clearing any browser-cached workers at the root scope.
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    // ignore — tombstone registration is best-effort
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
