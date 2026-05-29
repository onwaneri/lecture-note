import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const shim = (name: string): string =>
  fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url))

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  resolve: {
    // The Anthropic SDK statically pulls in a Node-only agent-toolset (beta
    // sessions) that imports named exports from these `node:` builtins. We
    // never use that path in the browser; alias each to a tiny shim so the
    // bundle builds. Anchored regexes avoid `node:stream` swallowing
    // `node:stream/promises`. See src/shims/*.
    alias: [
      { find: /^node:crypto$/, replacement: shim('node-crypto') },
      { find: /^node:child_process$/, replacement: shim('node-child_process') },
      { find: /^node:util$/, replacement: shim('node-util') },
      { find: /^node:stream$/, replacement: shim('node-stream') },
      { find: /^node:stream\/promises$/, replacement: shim('node-stream-promises') },
    ],
  },
})
