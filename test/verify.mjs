// Verifies the browser core against an xLights-generated sparse file.
// Usage: node test/verify.mjs "<full.fseq>" "<reference sparse.fseq>" start length
import { openAsBlob } from 'node:fs'
import { splitFseq } from '../src/fseq.js'
import { parseNetworks } from '../src/networks.js'
import { readFileSync } from 'node:fs'

const [full, ref, start, length] = process.argv.slice(2)
const chunks = []
const res = await splitFseq(
  await openAsBlob(full),
  [{ key: 'x', ranges: [[+start, +length]] }],
  async () => ({ write: (b) => chunks.push(Buffer.from(b)), close: () => {} }),
)
const out = Buffer.concat(chunks)
const expected = readFileSync(ref)
console.log('written', res.written, 'bytes', out.length, 'identical', out.equals(expected))
process.exit(out.equals(expected) ? 0 : 1)
