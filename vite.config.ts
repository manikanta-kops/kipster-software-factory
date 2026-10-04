import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEFAULT_PORT } from './src/config.ts'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${DEFAULT_PORT}` },
  },
})
