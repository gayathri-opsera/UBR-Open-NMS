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
      // Proxy all /api calls to the deployed cluster's nginx ingress ELB.
      // The Host header tells nginx which virtual host (ingress rule) to use,
      // bypassing the DNS lookup that fails outside the Opsera VPC.
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
