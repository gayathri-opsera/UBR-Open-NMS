import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    port: 5173,
    proxy: {
      // Route /api/v1 (NMS application APIs) to the local API gateway.
      // Gateway runs on host:3100 → container:3000 (docker-compose.dev.yml).
      '/api/v1': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
      // Route /api/v3 (Opsera DevSecOps agent telemetry) directly to the
      // Opsera backend so browsers see a same-origin request and CORS is satisfied.
      // Without this the request is routed through the local gateway which
      // redirects it, causing a cross-origin error.
      '/api/v3': {
        target: 'https://ubr-nms-frontend-dev.agent.opsera.dev',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
