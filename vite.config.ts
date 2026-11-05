import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://127.0.0.1:4747';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Served from this computer, so one bundle is fine.
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/ws': { target: api, ws: true },
    },
  },
});
