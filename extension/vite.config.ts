import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dist/',
  build: {
    rollupOptions: {
      input: {
        popup: new URL('./index.html', import.meta.url).pathname,
        options: new URL('./options.html', import.meta.url).pathname,
        offscreen: new URL('./src/offscreen.html', import.meta.url).pathname,
        service_worker: new URL('./src/service_worker.ts', import.meta.url).pathname,
      },
      output: {
        entryFileNames: (chunkInfo) => (chunkInfo.name === 'service_worker' ? 'service_worker.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
