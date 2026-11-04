import { decompress } from 'fzstd'

const u16 = (d, o) => d[o] | (d[o + 1] << 8)
const u24 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0

export async function readHeader(blob) {
  const start = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  if (String.fromCharCode(...start.subarray(0, 4)) !== 'PSEQ') throw new Error('Not an FSEQ file')
  const offset = u16(start, 4)
  const major = start[7]
  if (major !== 2) throw new Error(`Unsupported FSEQ version ${major}.${start[6]} (only v2 is supported)`)
  const hdr = new Uint8Array(await blob.slice(0, offset).arrayBuffer())
  const compression = hdr[20] & 0x0f
  const blockCount = ((hdr[20] >> 4) << 8) | hdr[21]
  const sparseCount = hdr[22]
  const info = {
    offset,
    channels: u32(hdr, 10),
    frames: u32(hdr, 14),
    stepTime: hdr[18],
    compression,
    uid: hdr.slice(24, 32),
    blocks: [],
    ranges: [],
    varHeaders: [],
  }
  let p = 32
  for (let i = 0; i < blockCount; i++, p += 8) info.blocks.push(u32(hdr, p + 4))
  for (let i = 0; i < sparseCount; i++, p += 6) info.ranges.push([u24(hdr, p), u24(hdr, p + 3)])
  if (!info.ranges.length) info.ranges.push([0, info.channels])
  while (p + 4 <= offset) {
    const len = u16(hdr, p)
    if (len === 0) break
    info.varHeaders.push(hdr.slice(p, p + len))
    p += len
  }
  return info
}

// Reads the compact frames of a full FSEQ file one chunk at a time.
// Calls onChunk(Uint8Array of N whole frames).
async function forEachChunk(blob, info, onChunk, shouldCancel) {
  if (info.compression === 0) {
    const perChunk = Math.max(1, Math.floor((4 << 20) / info.channels))
    for (let f = 0; f < info.frames; f += perChunk) {
      if (shouldCancel?.()) return
      const n = Math.min(perChunk, info.frames - f)
      const begin = info.offset + f * info.channels
      await onChunk(new Uint8Array(await blob.slice(begin, begin + n * info.channels).arrayBuffer()))
    }
    return
  }
  if (info.compression !== 1) throw new Error('Only uncompressed or zstd FSEQ files are supported')
  let pos = info.offset
  for (const size of info.blocks) {
    if (size === 0) continue
    if (shouldCancel?.()) return
    const packed = new Uint8Array(await blob.slice(pos, pos + size).arrayBuffer())
    pos += size
    await onChunk(decompress(packed))
  }
}

// Maps wanted absolute channel ranges onto compact-frame offsets.
export function buildCopies(srcRanges, wanted) {
  const copies = []
  let dst = 0
  for (const [ws, wl] of wanted) {
    let pos = 0
    for (const [rs, rl] of srcRanges) {
      const lo = Math.max(ws, rs)
      const hi = Math.min(ws + wl, rs + rl)
      if (lo < hi) copies.push([pos + lo - rs, hi - lo, dst + lo - ws])
      pos += rl
    }
    dst += wl
  }
  return { copies, size: dst }
}

export function buildHeader(info, wanted, outSize) {
  const keep = info.varHeaders.filter((v) => {
    const c = String.fromCharCode(v[2], v[3])
    return c === 'mf' || c === 'sp'
  })
  const varLen = keep.reduce((a, v) => a + v.length, 0)
  const hlen = 32 + 6 * wanted.length
  const offset = Math.ceil((hlen + varLen) / 4) * 4 // FPP Connect pads to 4 bytes
  const out = new Uint8Array(offset)
  const dv = new DataView(out.buffer)
  out.set([0x50, 0x53, 0x45, 0x51]) // PSEQ
  dv.setUint16(4, offset, true)
  out[6] = 0
  out[7] = 2
  dv.setUint16(8, hlen, true)
  dv.setUint32(10, outSize, true)
  dv.setUint32(14, info.frames, true)
  out[18] = info.stepTime
  out[22] = wanted.length
  out.set(info.uid, 24)
  wanted.forEach(([s, l], i) => {
    const p = 32 + i * 6
    out[p] = s & 255
    out[p + 1] = (s >> 8) & 255
    out[p + 2] = (s >> 16) & 255
    out[p + 3] = l & 255
    out[p + 4] = (l >> 8) & 255
    out[p + 5] = (l >> 16) & 255
  })
  let p = hlen
  for (const v of keep) {
    out.set(v, p)
    p += v.length
  }
  return out
}

/**
 * Splits one full FSEQ into several sparse FSEQs in a single pass.
 * targets: [{ key, ranges: [[start, length], ...] }]
 * openSink(target) -> Promise<{ write(Uint8Array), close() }>
 * Returns the keys that were written (targets with no channels in the file are skipped).
 */
export async function splitFseq(blob, targets, openSink, { onProgress, shouldCancel } = {}) {
  const info = await readHeader(blob)
  const jobs = []
  const skipped = []
  for (const t of targets) {
    const { copies, size } = buildCopies(info.ranges, t.ranges)
    if (!copies.length) {
      skipped.push(t.key)
      continue
    }
    const sink = await openSink(t)
    await sink.write(buildHeader(info, t.ranges, size))
    jobs.push({ t, copies, size, sink, pending: [], pendingBytes: 0 })
  }

  const FLUSH = 4 << 20
  let framesDone = 0
  const flush = async (j) => {
    if (!j.pending.length) return
    const buf = new Uint8Array(j.pendingBytes)
    let p = 0
    for (const c of j.pending) {
      buf.set(c, p)
      p += c.length
    }
    j.pending = []
    j.pendingBytes = 0
    await j.sink.write(buf)
  }

  try {
    await forEachChunk(
      blob,
      info,
      async (chunk) => {
        const n = chunk.length / info.channels
        for (const j of jobs) {
          const out = new Uint8Array(n * j.size)
          for (let f = 0; f < n; f++) {
            const sb = f * info.channels
            const db = f * j.size
            for (const [so, len, d] of j.copies) {
              out.set(chunk.subarray(sb + so, sb + so + len), db + d)
            }
          }
          j.pending.push(out)
          j.pendingBytes += out.length
          if (j.pendingBytes >= FLUSH) await flush(j)
        }
        framesDone += n
        onProgress?.(framesDone / info.frames)
      },
      shouldCancel,
    )
    if (shouldCancel?.()) {
      await Promise.all(jobs.map((j) => j.sink.abort?.() ?? j.sink.close()))
      return { written: [], skipped, cancelled: true, info }
    }
    for (const j of jobs) await flush(j)
    if (framesDone !== info.frames) throw new Error(`Expected ${info.frames} frames but read ${framesDone}`)
    await Promise.all(jobs.map((j) => j.sink.close()))
  } catch (e) {
    await Promise.all(jobs.map((j) => (j.sink.abort ? j.sink.abort() : j.sink.close()).catch?.(() => {})))
    throw e
  }
  return { written: jobs.map((j) => j.t.key), skipped, cancelled: false, info }
}
