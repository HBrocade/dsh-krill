import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const __ROOT__ = dirname(fileURLToPath(import.meta.url))
const shared = resolve(__ROOT__, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__ROOT__, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__ROOT__, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__ROOT__, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__ROOT__, 'src/renderer/index.html') } },
  },
})
