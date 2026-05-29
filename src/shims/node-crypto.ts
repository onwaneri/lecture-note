// Browser shim for `node:crypto`.
//
// The Anthropic SDK's client barrel transitively imports its Node-only
// agent-toolset (beta sessions), which does `import { randomUUID } from
// 'node:crypto'`. We never use that toolset in this browser app, but Rollup
// still needs the named export to resolve at build time. Vite's default
// browser-external stub for `node:` modules has no named exports, so we alias
// `node:crypto` to this file (see vite.config.ts). randomUUID is backed by the
// real Web Crypto API so it also works if ever called.

export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export default { randomUUID }
