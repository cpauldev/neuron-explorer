import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Build into FastAPI's existing static directory. Watch mode keeps browser and API
// on the same origin, including the browser-owned MCP event connection.
export default defineConfig({
  root: 'frontend',
  base: '/dist/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./frontend/src', import.meta.url)) } },
  build: {
    outDir: '../explorer/static/dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'], restoreMocks: true },
});
