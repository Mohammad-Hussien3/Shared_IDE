import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // y-monaco still uses Monaco's pre-0.55 deep import; use the current export.
  resolve: { alias: {
    'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor/editor.api.js',
  } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep browser requests/cookies on the frontend's hostname, including WS.
      '/api': {
        target: process.env.DEV_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
