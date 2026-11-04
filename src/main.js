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
const fmtDate = (ms) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
let seqFilter = ''
let seqSort = { key: 'modified', dir: -1 }

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
    if (lower.endsWith('.fseq') && !IP_PREFIX.test(name)) {
      const f = await handle.getFile()
      sequences.push({ name, handle, modified: f.lastModified, size: f.size, selected: true })
    } else if (lower === 'xlights_networks.xml') networksHandle = handle
  }
  seqFilter = ''
  seqSort = { key: 'modified', dir: -1 }
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
    updateRunState()
    return
  }
  const visible = () => {
    const q = seqFilter.trim().toLowerCase()
    const rows = sequences.filter((s) => s.name.toLowerCase().includes(q))
    const dir = seqSort.dir
    return rows.sort((a, b) => {
      const r = seqSort.key === 'name' ? a.name.localeCompare(b.name) : a.modified - b.modified
      return r * dir
    })
  }

  const setVisible = (v) => () => {
    visible().forEach((s) => (s.selected = v))
    renderRows()
  }
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'search'
  search.placeholder = 'Filter sequences by name…'
  search.value = seqFilter
  search.oninput = () => {
    seqFilter = search.value
    renderRows()
  }
  const toolbar = document.createElement('div')
  toolbar.className = 'seq-toolbar'
  toolbar.append(search)
  const count = document.createElement('span')
  count.className = 'meta'
  toolbar.append(count)

  const table = document.createElement('table')
  table.className = 'grid'
  const head = document.createElement('thead')
  const hr = document.createElement('tr')
  const allCb = document.createElement('input')
  allCb.type = 'checkbox'
  allCb.title = 'Select / clear all shown'
  const th0 = document.createElement('th')
  th0.className = 'chk'
  th0.append(allCb)
  hr.append(th0)
  const sortHeaders = {}
  for (const [key, label] of [['name', 'Sequence'], ['modified', 'Last modified']]) {
    const th = document.createElement('th')
    th.className = 'sortable'
    th.onclick = () => {
      seqSort = { key, dir: seqSort.key === key ? -seqSort.dir : key === 'modified' ? -1 : 1 }
      renderRows()
    }
    sortHeaders[key] = th
    th.dataset.label = label
    hr.append(th)
  }
  const thSize = document.createElement('th')
  thSize.textContent = 'Size'
  hr.append(thSize)
  head.append(hr)
  const body = document.createElement('tbody')
  table.append(head, body)
  const wrap = document.createElement('div')
  wrap.className = 'list'
  wrap.append(table)
  box.append(toolbar, wrap)

  function renderRows() {
    const rows = visible()
    for (const [key, th] of Object.entries(sortHeaders)) {
      const active = seqSort.key === key
      th.textContent = th.dataset.label + (active ? (seqSort.dir === 1 ? ' ▲' : ' ▼') : '')
      th.setAttribute('aria-sort', active ? (seqSort.dir === 1 ? 'ascending' : 'descending') : 'none')
    }
    body.innerHTML = ''
    for (const s of rows) {
      const tr = document.createElement('tr')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = s.selected
      cb.onchange = () => {
        s.selected = cb.checked
        syncHeader()
        updateRunState()
      }
      const td0 = document.createElement('td')
      td0.className = 'chk'
      td0.append(cb)
      const tdName = document.createElement('td')
      tdName.textContent = s.name
      const tdMod = document.createElement('td')
      tdMod.textContent = fmtDate(s.modified)
      const tdSize = document.createElement('td')
      tdSize.textContent = fmtMB(s.size)
      tr.append(td0, tdName, tdMod, tdSize)
      tr.onclick = (e) => {
        if (e.target === cb) return
        cb.checked = !cb.checked
        cb.onchange()
      }
      body.append(tr)
    }
    if (!rows.length) body.innerHTML = '<tr><td colspan="4" class="meta">No sequences match the filter.</td></tr>'
    count.textContent = `${rows.length} of ${sequences.length} shown`
    syncHeader()
    updateRunState()
  }
  function syncHeader() {
    const rows = visible()
    const n = rows.filter((s) => s.selected).length
    allCb.checked = rows.length > 0 && n === rows.length
    allCb.indeterminate = n > 0 && n < rows.length
  }
  allCb.onchange = () => setVisible(allCb.checked)()
  renderRows()
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
  const sparseDir = await dirHandle.getDirectoryHandle('Sparser', { create: true })
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
      for (const key of res.written) log(`  created: Sparser\\${key}\\${s.name}`)
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

const root = document.documentElement
const syncThemeIcon = () => ($('themeToggle').textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙')
$('themeToggle').onclick = () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('sparser-light-dark-mode', root.dataset.theme)
  syncThemeIcon()
}
syncThemeIcon()

const buildDate = new Date(__BUILD_TIME__).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
$('version').textContent = `v${__APP_VERSION__} · built ${buildDate}`

$('pick').onclick = pickFolder
$('pickNetworks').onclick = pickNetworks
$('next2').onclick = continueFromNetworks
$('run').onclick = run
$('cancel').onclick = () => (cancelled = true)
