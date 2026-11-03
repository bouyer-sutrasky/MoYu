import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/healthz': 'http://127.0.0.1:3100',
      '/readyz': 'http://127.0.0.1:3100',
    },
  },
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/healthz': 'http://127.0.0.1:3100',
      '/readyz': 'http://127.0.0.1:3100',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
