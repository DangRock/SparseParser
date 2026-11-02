import './style.css'
import { splitFseq } from './fseq.js'
import { parseNetworks, folderName } from './networks.js'

const $ = (id) => document.getElementById(id)
const IP_PREFIX = /^\d+_\d+_\d+_\d+_/

let dirHandle = null
let controllers = []
let sequences = [] // { name, handle }
let cancelled = false
let networksName = ''

if (!window.showDirectoryPicker) {
  $('unsupported').hidden = false
  $('pick').disabled = true
}

const log = (msg) => {
  const el = $('log')
  el.textContent += msg + '\n'
  el.scrollTop = el.scrollHeight
}

const fmtMB = (n) => (n / 1048576).toFixed(0) + ' MB'

async function pickFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ id: 'fseq', mode: 'readwrite' })
  } catch {
    return
  }
  $('folderName').textContent = dirHandle.name
  sequences = []
  let networksHandle = null
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue
    const lower = name.toLowerCase()
    if (lower.endsWith('.fseq') && !IP_PREFIX.test(name)) sequences.push({ name, handle })
    else if (lower === 'xlights_networks.xml') networksHandle = handle
  }
  sequences.sort((a, b) => a.name.localeCompare(b.name))
  $('sum1').textContent = `FSEQ Folder: ${dirHandle.name}`
  $('step1').open = false
  $('step2').hidden = false
  $('step2').open = true
  $('step3').hidden = true
  $('progressSection').hidden = true
  await loadNetworks(networksHandle)
  renderSequences()
}

function chips(items) {
  const tools = document.createElement('div')
  tools.className = 'chips'
  for (const [label, fn] of items) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.textContent = label
    b.onclick = fn
    tools.append(b)
  }
  return tools
}

function updateSummaries() {
  const n = controllers.filter((c) => c.selected).length
  $('sum2').textContent = networksName ? `Network file: ${networksName}, ${n} controllers selected` : ''
  $('sum3').textContent = `${sequences.filter((s) => s.selected).length} sequences selected`
}

async function loadNetworks(handle) {
  controllers = []
  networksName = ''
  $('pickNetworks').hidden = !!handle
  $('networksStatus').className = ''
  if (!handle) {
    $('networksStatus').textContent = 'xlights_networks.xml was not found in that folder. Please choose it.'
    $('networksStatus').className = 'error'
    renderControllers()
    return
  }
  try {
    controllers = parseNetworks(await (await handle.getFile()).text())
    networksName = handle.name
    $('networksStatus').textContent = `Loaded ${controllers.length} controllers from ${handle.name}.`
  } catch (e) {
    $('networksStatus').textContent = e.message
    $('networksStatus').className = 'error'
  }
  renderControllers()
}

async function pickNetworks() {
  try {
    const [h] = await window.showOpenFilePicker({
      types: [{ description: 'xLights networks', accept: { 'text/xml': ['.xml'] } }],
    })
    await loadNetworks(h)
    updateRunState()
  } catch {
    /* cancelled */
  }
}

function renderControllers() {
  const box = $('controllers')
  box.innerHTML = ''
  if (!controllers.length) return
  for (const c of controllers) if (c.selected === undefined) c.selected = c.active
  box.append(
    chips(
      [
        ['All', () => true],
        ['None', () => false],
        ['Active only', (c) => c.active],
      ].map(([label, fn]) => [
        label,
        () => {
          controllers.forEach((c) => (c.selected = fn(c)))
          renderControllers()
          updateRunState()
        },
      ]),
    ),
  )
  const list = document.createElement('div')
  list.className = 'list'
  for (const c of controllers) {
    if (c.selected === undefined) c.selected = c.active
    const row = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = c.selected
    cb.onchange = () => {
      c.selected = cb.checked
      updateRunState()
    }
    row.append(cb, ` ${c.ip}  ${c.name}  `)
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `ch ${c.start + 1}–${c.start + c.length}${c.active ? '' : ' (inactive)'}`
    row.append(meta)
    list.append(row)
  }
  box.append(list)
}

function renderSequences() {
  const box = $('sequences')
  box.innerHTML = ''
  if (!sequences.length) {
    box.innerHTML = '<p class="error">No full .fseq files found in this folder.</p>'
  } else {
    const setAll = (v) => () => {
      sequences.forEach((s) => (s.selected = v))
      renderSequences()
    }
    box.append(chips([['All', setAll(true)], ['None', setAll(false)]]))
  }
  for (const s of sequences) {
    if (s.selected === undefined) s.selected = true
    const row = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = s.selected
    cb.onchange = () => {
      s.selected = cb.checked
      updateRunState()
    }
    row.append(cb, ` ${s.name}`)
    box.append(row)
  }
  updateRunState()
}

function updateRunState() {
  const hasControllers = controllers.some((c) => c.selected)
  $('next2').disabled = !hasControllers
  $('run').disabled = !(hasControllers && sequences.some((s) => s.selected))
  updateSummaries()
}

function continueFromNetworks() {
  $('step2').open = false
  $('step3').hidden = false
  $('step3').open = true
}

function showComplete(msg, warn) {
  const el = $('complete')
  el.textContent = msg
  el.className = warn ? 'complete warn' : 'complete'
  el.hidden = false
  $('progress').hidden = true
}

async function run() {
  const chosen = controllers.filter((c) => c.selected)
  const seqs = sequences.filter((s) => s.selected)
  cancelled = false
  $('run').hidden = true
  $('cancel').hidden = false
  $('pick').disabled = true
  for (const id of ['step1', 'step2', 'step3']) $(id).open = false
  $('progressSection').hidden = false
  $('complete').hidden = true
  $('progress').hidden = false
  $('log').textContent = ''
  let filesCreated = 0
  let filesSkipped = 0
  const targets = chosen.map((c) => ({ key: folderName(c), ip: c.ip, ranges: [[c.start, c.length]] }))
  const sparseDir = await dirHandle.getDirectoryHandle('sparse', { create: true })
  const t0 = performance.now()

  try {
    for (const [i, s] of seqs.entries()) {
      if (cancelled) break
      const file = await s.handle.getFile()
      log(`[${i + 1}/${seqs.length}] ${s.name} (${fmtMB(file.size)})`)
      $('progress').value = 0
      const res = await splitFseq(
        file,
        targets,
        async (t) => {
          const d = await sparseDir.getDirectoryHandle(t.key, { create: true })
          const fh = await d.getFileHandle(s.name, { create: true })
          return await fh.createWritable()
        },
        {
          onProgress: (p) => {
            $('progress').value = (i + p) / seqs.length
          },
          shouldCancel: () => cancelled,
        },
      )
      if (res.cancelled) break
      for (const key of res.written) log(`  created: sparse\\${key}\\${s.name}`)
      for (const key of res.skipped) log(`  skipped (no channels in this sequence): ${key}`)
      filesCreated += res.written.length
      filesSkipped += res.skipped.length
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    log(
      cancelled
        ? 'Cancelled.'
        : `Done in ${secs} s. ${filesCreated} files created, ${filesSkipped} skipped.`,
    )
    showComplete(
      cancelled
        ? `Cancelled. ${filesCreated} files created before stopping.`
        : `Sparse file creation is complete. ${filesCreated} files created.`,
      cancelled,
    )
  } catch (e) {
    log('ERROR: ' + (e.message || e))
    showComplete(`Sparse file creation failed: ${e.message || e}`, true)
    console.error(e)
  } finally {
    $('run').hidden = false
    $('cancel').hidden = true
    $('pick').disabled = false
  }
}

$('pick').onclick = pickFolder
$('pickNetworks').onclick = pickNetworks
$('next2').onclick = continueFromNetworks
$('run').onclick = run
$('cancel').onclick = () => (cancelled = true)
