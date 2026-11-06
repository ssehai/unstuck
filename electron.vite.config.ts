import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Defaults: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {}
})
