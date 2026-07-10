import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

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
