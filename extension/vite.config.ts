import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: new URL('./index.html', import.meta.url).pathname,
        options: new URL('./options.html', import.meta.url).pathname,
        offscreen: new URL('./src/offscreen.html', import.meta.url).pathname,
      },
    },
  },
});
