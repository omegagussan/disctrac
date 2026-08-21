import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages serves this repo from /disctrac/, but the dev server serves
  // from the root — so only rewrite asset paths for production builds.
  base: command === 'build' ? '/disctrac/' : '/',
}))
