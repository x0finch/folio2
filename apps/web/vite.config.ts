import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    // In development the API runs in `wrangler dev`; in production both share one origin.
    proxy: { '/api': 'http://localhost:8787' },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      // A static SPA: the Worker only answers /api/*, every page is client-rendered.
      spa: { enabled: true, prerender: { outputPath: '/index.html' } },
    }),
    react(),
  ],
})
