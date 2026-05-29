// Browser stub for `node:util` — see node-crypto.ts. The agent-toolset (unused
// here) imports `promisify`; the identity-ish wrapper is enough to build.
export function promisify<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn
}

export default { promisify }
