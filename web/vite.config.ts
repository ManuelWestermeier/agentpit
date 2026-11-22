import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: `npm run dev:web` (Port 5173) talks to the cockpit server on 4317.
// Start the server with DEV_ORIGINS=http://localhost:5173 so it accepts this origin,
// and open the server's ?token= link once so the cookie exists.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4317',
      '/media': 'http://localhost:4317',
      '/ws': { target: 'ws://localhost:4317', ws: true },
    },
  },
});
