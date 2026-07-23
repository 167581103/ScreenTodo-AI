import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// React 源码在 src/ (入口 src/index.html → src/src/main.tsx)，构建产物输出到项目根 dist/
export default defineConfig({
  root: 'src',
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
