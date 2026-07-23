import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// React 源码在 src/ (入口 src/index.html → src/src/main.tsx)，构建产物输出到项目根 dist/
export default defineConfig({
  root: 'src',
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        workspace: resolve(__dirname, 'src/index.html'),
        suggestion: resolve(__dirname, 'src/suggestion.html'),
      },
    },
  },
})
