/**
 * Standalone web build of the renderer (no Electron).
 *
 *   npm run dev:web     -> http://localhost:5174
 *   npm run build:web   -> out/web (static files, can be served anywhere)
 *
 * `window.api` is provided by src/renderer/src/platform/web-api.ts, which
 * reads .dat/.spr chosen or dropped by the user via the File API.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  mode: 'web',
  define: {
    'import.meta.env.VITE_PLATFORM': JSON.stringify('web')
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5174,
    host: true,
    fs: { allow: [resolve(__dirname, 'src'), resolve(__dirname, 'node_modules')] }
  },
  preview: { port: 4174, host: true },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  }
})
