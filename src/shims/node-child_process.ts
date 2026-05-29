// Browser stub for `node:child_process` — see node-crypto.ts for why these
// exist. The Anthropic agent-toolset (unused in this app) imports `execFile`.
export function execFile(): never {
  throw new Error('node:child_process is not available in the browser')
}

export default { execFile }
