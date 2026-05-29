// Browser stub for `node:stream/promises` — see node-crypto.ts. The
// agent-toolset (unused here) imports `pipeline`.
export function pipeline(): never {
  throw new Error('node:stream/promises is not available in the browser')
}

export default { pipeline }
