import './style.css'
import { startConversation } from './explainUi'
import { getEvalStore, startEvaluation } from './evaluation'
import { FindBar } from './findBar'
import { PanelFind } from './panelFind'
import { selectionBoxes } from './lineModel'
import { clearOverlays, pageOverlay, placeBox, toPageBoxes } from './overlay'
import { jumpTo } from './locate'
import { getNotesStore, type StuckRecord } from './notes'
import { StuckPoints } from './stuckPoints'
import { getLibrary, type PaperMeta } from './library'
import { Reader } from './reader'
import { SelectionPopup } from './selection'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const container = $<HTMLDivElement>('viewerContainer')
const fileInput = $<HTMLInputElement>('fileInput')
const fileName = $('fileName')
const pageInfo = $('pageInfo')
const zoomLabel = $('zoomLabel')
const emptyState = $('emptyState')
const dropOverlay = $('dropOverlay')
const libraryBtn = $<HTMLButtonElement>('libraryBtn')
const libraryPanel = $('libraryPanel')
const zoomButtons = ['zoomIn', 'zoomOut', 'fitWidth'].map((id) => $<HTMLButtonElement>(id))

const library = getLibrary()
let currentId: string | null = null

const popup = new SelectionPopup(container, $('sidePanel'))

// --- Side panel ------------------------------------------------------------------
// Shown by default; toggled with the toolbar button or ⌘← / ⌘→, resized by
// dragging its left edge. Its slide is animated in JS so the PDF can be
// rescaled on the very same frames (see Reader.beginResize).
const panelBtn = $<HTMLButtonElement>('panelBtn')
const sidePanel = $('sidePanel')
const PANEL_MIN = 300
const panelMax = (): number => Math.max(PANEL_MIN, Math.round(innerWidth * 0.6))
let panelW = Math.round(Math.min(460, Math.max(320, innerWidth * 0.32)))
let panelShown = 0 // how many px of the panel are on screen (0 … panelW)
const panelOpen = (): boolean => !document.body.classList.contains('panel-closed')

function layoutPanel(): void {
  sidePanel.style.width = `${panelW}px`
  sidePanel.style.transform = `translateX(${panelW - panelShown}px)`
  sidePanel.style.visibility = panelShown > 0 ? 'visible' : 'hidden'
  container.style.right = `${panelShown}px`
  document.documentElement.style.setProperty('--panel-shown', `${panelShown}px`)
}

let slideFrame = 0
function setPanel(open: boolean): void {
  if (open === panelOpen()) return
  document.body.classList.toggle('panel-closed', !open)
  panelBtn.setAttribute('aria-pressed', String(open))
  try {
    localStorage.setItem('unstuck.panel', open ? 'open' : 'closed')
  } catch {
    /* storage unavailable: fine */
  }
  const resize = reader.beginResize()
  const from = panelShown
  const to = open ? panelW : 0
  const start = performance.now()
  const DURATION = 260
  cancelAnimationFrame(slideFrame)
  const step = (now: number): void => {
    const t = document.hidden ? 1 : Math.min(1, (now - start) / DURATION)
    const eased = 1 - Math.pow(1 - t, 3)
    panelShown = from + (to - from) * eased
    layoutPanel()
    resize.update()
    if (t < 1) slideFrame = requestAnimationFrame(step)
    else resize.finish()
  }
  slideFrame = requestAnimationFrame(step)
}
panelBtn.addEventListener('click', () => setPanel(!panelOpen()))

// Drag the panel's left edge to resize it.
const resizer = document.createElement('div')
resizer.className = 'panel-resizer'
resizer.title = 'Drag to resize'
sidePanel.appendChild(resizer)
resizer.addEventListener('mousedown', (e) => {
  e.preventDefault()
  const startX = e.clientX
  const startW = panelW
  const resize = reader.beginResize()
  document.body.classList.add('resizing-panel')
  const onMove = (ev: MouseEvent): void => {
    panelW = Math.min(panelMax(), Math.max(PANEL_MIN, startW + (startX - ev.clientX)))
    panelShown = panelW
    layoutPanel()
    resize.update()
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.body.classList.remove('resizing-panel')
    resize.finish()
    try {
      localStorage.setItem('unstuck.panelWidth', String(panelW))
    } catch {
      /* ignore */
    }
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp, { once: true })
})

try {
  const w = Number(localStorage.getItem('unstuck.panelWidth'))
  if (w >= PANEL_MIN) panelW = Math.min(panelMax(), w)
  if (localStorage.getItem('unstuck.panel') === 'closed') {
    document.body.classList.add('panel-closed')
    panelBtn.setAttribute('aria-pressed', 'false')
  }
} catch {
  /* ignore */
}
panelShown = panelOpen() ? panelW : 0
layoutPanel()
addEventListener('resize', () => {
  const w = Math.min(panelMax(), Math.max(PANEL_MIN, panelW))
  if (panelShown === panelW) panelShown = w
  panelW = w
  layoutPanel()
})

// --- Find: ⌘F in the PDF, ⌘⇧F in the side panel ------------------------------------
const pdfFind = new FindBar($('stage'), {
  placeholder: '논문에서 찾기',
  className: 'find-pdf',
  onSearch: (q, dir) => (q ? reader.find(q, dir) : reader.clearFind()),
  onClose: () => {
    reader.clearFind()
    clearOverlays(container, 'find')
  }
})

/**
 * pdf.js marks matches in its invisible text layer, whose glyph positions come
 * from a fallback font, so its own marks drift off the real letters. Its marks
 * are hidden (CSS) and redrawn here with the ink-aligned geometry used for
 * selections, in percent of the page so they follow zooming.
 */
let findFrame = 0
function drawFindMarks(): void {
  cancelAnimationFrame(findFrame)
  findFrame = requestAnimationFrame(() => {
    clearOverlays(container, 'find')
    if (!pdfFind.isOpen) return
    // A match spanning several text runs is marked begin / middle… / end:
    // join them so the match is one mark, not one box per word.
    const matches: HTMLElement[][] = []
    for (const el of container.querySelectorAll<HTMLElement>('.textLayer .highlight')) {
      const cont = el.classList.contains('middle') || el.classList.contains('end')
      if (cont && matches.length) matches[matches.length - 1].push(el)
      else matches.push([el])
    }
    for (const els of matches) {
      const texts: Text[] = []
      for (const el of els) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
      }
      if (texts.length === 0) continue
      const range = document.createRange()
      range.setStart(texts[0], 0)
      range.setEnd(texts[texts.length - 1], texts[texts.length - 1].length)
      const current = els[0].classList.contains('selected')
      for (const b of toPageBoxes(selectionBoxes(range, container), container)) {
        const overlay = pageOverlay(container, b.page, 'find')
        if (!overlay) continue
        const d = document.createElement('div')
        d.className = 'find-hl' + (current ? ' current' : '')
        placeBox(d, b, 1)
        overlay.appendChild(d)
      }
    }
  })
}
const panelFind = new PanelFind(sidePanel)
let lastFind: 'pdf' | 'panel' = 'pdf'
function openPdfFind(): void {
  if (!reader.isOpen) return
  lastFind = 'pdf'
  // Start from words just selected (not asked about yet), like macOS ⌘E/⌘F.
  const sel = popup.pendingText
  pdfFind.open(sel && sel.length < 80 ? sel : undefined)
}
function openPanelFind(): void {
  setPanel(true)
  lastFind = 'panel'
  panelFind.open()
}
function findStep(dir: 'next' | 'prev'): void {
  if (lastFind === 'panel' && panelFind.bar.isOpen) panelFind.bar.step(dir)
  else if (pdfFind.isOpen) pdfFind.step(dir)
  else openPdfFind()
}

// --- Panel text size (View menu, ⌘⇧+ / ⌘⇧−) ----------------------------------------
const FONT_STEPS = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.55]
let fontScale = 1
function setPanelFont(scale: number): void {
  fontScale = scale
  document.documentElement.style.setProperty('--panel-zoom', String(scale))
  try {
    localStorage.setItem('unstuck.panelFont', String(scale))
  } catch {
    /* ignore */
  }
}
function stepFont(dir: 1 | -1): void {
  const i = FONT_STEPS.findIndex((v) => v >= fontScale - 1e-6)
  setPanelFont(FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, (i < 0 ? FONT_STEPS.length - 1 : i) + dir))])
}
try {
  const saved = Number(localStorage.getItem('unstuck.panelFont'))
  setPanelFont(saved > 0 ? saved : 1)
} catch {
  setPanelFont(1)
}

// --- Preferences (app menu, ⌘,) ------------------------------------------------------
// Nothing to configure yet; the window is the place for future settings.
const prefs = $('prefsDialog')
function openPreferences(): void {
  prefs.hidden = false
}
prefs.addEventListener('mousedown', (e) => {
  if (e.target === prefs) prefs.hidden = true // click on the backdrop
})
prefs.querySelector('.prefs-close')!.addEventListener('click', () => (prefs.hidden = true))

// Selecting a passage asks Claude for an explanation (see explainUi.ts);
// each explained passage becomes a stuck point that can be reopened.
const notesStore = getNotesStore()
let cancelExplain: (() => void) | null = null
const conversationDeps = () => ({
  reader,
  container,
  title: () => fileName.textContent ?? 'paper',
  paperId: () => currentId,
  store: notesStore,
  onRecord: (rec: StuckRecord) => {
    shownRecordId = rec.id
    stuck.upsert(rec)
  }
})
/** The stuck point currently shown in the panel, if any. */
let shownRecordId: string | null = null
popup.onSelect = (sel, body) => {
  setPanel(true) // asking a question always shows the panel
  cancelExplain?.()
  cancelExplain = evalMode
    ? startEvaluation(sel, body, { reader, container, title: () => fileName.textContent ?? 'paper', store: evalStore })
    : startConversation({ sel }, body, conversationDeps())
}

// --- Evaluation mode (M5): blind A/B against a passage-only baseline ------------
const evalStore = getEvalStore()
const evalBadge = $<HTMLButtonElement>('evalBadge')
let evalMode = false
function setEvalMode(on: boolean): void {
  evalMode = on
  evalBadge.hidden = !on
  document.body.classList.toggle('eval-mode', on)
  popup.hide()
}
evalBadge.addEventListener('click', () => setEvalMode(false))
popup.onHide = () => {
  cancelExplain?.()
  cancelExplain = null
  shownRecordId = null
}
const openStuck = (rec: StuckRecord): void => {
  setPanel(true)
  shownRecordId = rec.id
  // Go to the passage and show it highlighted, as when it was first selected.
  const locate = async (): Promise<void> => {
    const range = await jumpTo(reader, container, rec.page, rec.quote, { flash: false })
    if (!range || !popup.cardOpen) return
    popup.showSavedHighlight(range)
    // Right after a zoom the page may still be re-rendering; measure again
    // once it has, so the highlight hugs the glyphs exactly.
    setTimeout(() => {
      if (popup.cardOpen && !popup.selection && range.startContainer.isConnected) popup.showSavedHighlight(range)
    }, 700)
  }
  popup.openSaved({ text: rec.quote, pageStart: rec.page, pageEnd: rec.pageEnd }, () => void locate(), (body) => {
    cancelExplain?.()
    cancelExplain = startConversation({ record: rec }, body, conversationDeps())
  })
  locate()
}
const stuck = new StuckPoints({
  container,
  store: notesStore,
  open: openStuck,
  // A dot toggles its conversation: a second click closes it again.
  toggle: (rec) => {
    if (shownRecordId === rec.id && popup.cardOpen) popup.hide()
    else openStuck(rec)
  },
  // Deleting the stuck point that is open in the panel closes the panel.
  onDeleted: (rec) => {
    if (shownRecordId === rec.id) popup.hide()
  }
})

const reader = new Reader(container, $<HTMLDivElement>('viewer'), {
  onPageChange: (page, total) => {
    pageInfo.textContent = total ? `Page ${page} / ${total}` : ''
    saveViewSoon()
  },
  onScaleChange: (scale) => {
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
    // Highlights and markers are in percent of the page: nothing to redo.
    saveViewSoon()
  },
  // pdf.js (re)created a page's text layer: put our overlays back on it.
  onTextLayer: () => {
    popup.refreshHighlight()
    stuck.renderMarkers()
    if (pdfFind.isOpen) drawFindMarks()
  },
  // Find marks measure the drawn glyphs; a page drawn after its text layer
  // (e.g. after zooming) needs them measured again.
  onPageRendered: () => {
    if (pdfFind.isOpen) drawFindMarks()
  }
})
reader.onFindCount = (current, total) => pdfFind.setCount(current, total)
reader.onFindMatches = drawFindMarks

// --- Remember where the reader is in each paper ---------------------------------
let saveTimer = 0
function saveViewSoon(): void {
  if (!currentId) return
  const id = currentId
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    if (id === currentId) library.update(id, { view: reader.view }).catch(() => undefined)
  }, 600)
}

// --- Opening papers -------------------------------------------------------------
async function openPaper(meta: PaperMeta, data?: Uint8Array): Promise<void> {
  try {
    popup.hide()
    const bytes = data ?? (await library.read(meta.id))
    currentId = null // don't save view changes caused by loading
    await reader.open(bytes, meta.view)
    currentId = meta.id
    stuck.load(meta.id)
    fileName.textContent = meta.name
    document.title = `${meta.name} — Unstuck`
    emptyState.hidden = true
    zoomButtons.forEach((b) => (b.disabled = false))
    await library.update(meta.id, { lastOpenedAt: Date.now() })
  } catch (err) {
    alert(`Could not open "${meta.name}".\n\n${(err as Error).message}`)
  }
}

/** A new file from disk: save it to the library, then open it. */
async function importPdf(data: Uint8Array, name: string): Promise<void> {
  try {
    const meta = await library.add(name, data)
    await openPaper(meta, data)
  } catch (err) {
    alert(`Could not save "${name}" to the library.\n\n${(err as Error).message}`)
  }
}

async function importFile(file: File): Promise<void> {
  await importPdf(new Uint8Array(await file.arrayBuffer()), file.name)
}

// --- Library list (toolbar dropdown + empty-state "Recent papers") --------------
function timeAgo(t: number): string {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function renderList(ul: HTMLElement, papers: PaperMeta[]): void {
  ul.replaceChildren()
  if (papers.length === 0) {
    const li = document.createElement('li')
    li.className = 'paper-empty'
    li.textContent = 'No saved papers yet. Open a PDF and it will be kept here.'
    ul.appendChild(li)
    return
  }
  for (const p of papers) {
    const li = document.createElement('li')
    li.className = 'paper-item' + (p.id === currentId ? ' current' : '')
    const info = document.createElement('button')
    info.className = 'paper-open'
    info.title = `Open ${p.name}`
    const name = document.createElement('span')
    name.className = 'paper-name'
    name.textContent = p.name
    const sub = document.createElement('span')
    sub.className = 'paper-sub'
    sub.textContent = `${p.view ? `p.${p.view.page} · ` : ''}${timeAgo(p.lastOpenedAt)} · ${sizeText(p.size)}`
    info.append(name, sub)
    info.addEventListener('click', () => {
      closeLibrary()
      if (p.id !== currentId) openPaper(p)
    })
    const del = document.createElement('button')
    del.className = 'paper-remove'
    del.title = 'Remove from library'
    del.textContent = '×'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(`Remove "${p.name}" from the library?\nThe saved copy will be deleted.`)) return
      await library.remove(p.id)
      refreshLists()
    })
    li.append(info, del)
    ul.appendChild(li)
  }
}

async function refreshLists(): Promise<PaperMeta[]> {
  const papers = await library.list().catch(() => [] as PaperMeta[])
  renderList($('libraryList'), papers)
  renderList($('recentList'), papers.slice(0, 6))
  $('recentBox').hidden = papers.length === 0
  return papers
}

function closeLibrary(): void {
  libraryPanel.hidden = true
}

libraryBtn.addEventListener('click', async (e) => {
  e.stopPropagation()
  if (!libraryPanel.hidden) return closeLibrary()
  await refreshLists()
  libraryPanel.style.left = `${libraryBtn.getBoundingClientRect().left}px`
  libraryPanel.hidden = false
})
document.addEventListener('mousedown', (e) => {
  if (!libraryPanel.hidden && !libraryPanel.contains(e.target as Node) && e.target !== libraryBtn) closeLibrary()
})

// --- Opening files: button, ⌘O, drag & drop -------------------------------------
/** Typing in a text field: keep the platform's own shortcuts there. */
const isTyping = (e: KeyboardEvent): boolean => !!(e.target as HTMLElement | null)?.closest?.('textarea, input')

const pickFile = (): void => fileInput.click()
$('openBtn').addEventListener('click', pickFile)
$('emptyOpenBtn').addEventListener('click', pickFile)
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  if (f) importFile(f)
  fileInput.value = ''
})
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase()
  if ((e.metaKey || e.ctrlKey) && key === 'o') {
    e.preventDefault()
    pickFile()
  } else if ((e.metaKey || e.ctrlKey) && key === 'l') {
    e.preventDefault()
    libraryBtn.click()
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === 'e' && !window.unstuckApi) {
    e.preventDefault() // in Electron the menu handles ⌘⇧E
    setEvalMode(!evalMode)
  } else if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isTyping(e)) {
    e.preventDefault()
    setPanel(e.key === 'ArrowLeft') // ⌘← pulls the panel in, ⌘→ pushes it away
  } else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault()
    panelBtn.click()
  } else if (e.key === 'Escape') {
    closeLibrary()
  }
})

let dragDepth = 0
document.addEventListener('dragenter', (e) => {
  e.preventDefault()
  if (++dragDepth === 1) dropOverlay.hidden = false
})
document.addEventListener('dragleave', () => {
  if (--dragDepth === 0) dropOverlay.hidden = true
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  dropOverlay.hidden = true
  const f = Array.from(e.dataTransfer?.files ?? []).find(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  )
  if (f) importFile(f)
})

// --- Zoom -----------------------------------------------------------------------
$('zoomIn').addEventListener('click', () => reader.zoomIn())
$('zoomOut').addEventListener('click', () => reader.zoomOut())
$('fitWidth').addEventListener('click', () => reader.fitWidth())

// Trackpad pinch arrives as wheel events with ctrlKey set (Chromium). Zoom
// around the cursor, batching events per animation frame.
let pinchFactor = 1
let pinchAt = { x: 0, y: 0 }
let pinchFrame = 0
container.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return // ordinary scrolling
    e.preventDefault()
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    pinchFactor *= Math.exp(-dy * 0.01)
    pinchAt = { x: e.clientX, y: e.clientY }
    if (!pinchFrame) {
      pinchFrame = requestAnimationFrame(() => {
        reader.zoomBy(pinchFactor, pinchAt.x, pinchAt.y)
        pinchFactor = 1
        pinchFrame = 0
      })
    }
  },
  { passive: false }
)

// ⌘+ / ⌘− / ⌘0. In Electron these come from the app menu (which would
// otherwise zoom the whole window); in a browser, from the keyboard.
function zoomCommand(cmd: 'in' | 'out' | 'fit'): void {
  if (!reader.isOpen) return
  if (cmd === 'in') reader.zoomIn()
  else if (cmd === 'out') reader.zoomOut()
  else reader.fitWidth()
}
window.unstuckApi?.onMenu?.((cmd) => {
  if (cmd === 'toggle-eval') setEvalMode(!evalMode)
  else if (cmd === 'preferences') openPreferences()
  else if (cmd === 'find-paper') openPdfFind()
  else if (cmd === 'find-panel') openPanelFind()
  else if (cmd === 'find-next') findStep('next')
  else if (cmd === 'find-prev') findStep('prev')
  else if (cmd === 'panel-font-up') stepFont(1)
  else if (cmd === 'panel-font-down') stepFont(-1)
  else if (cmd === 'panel-font-reset') setPanelFont(1)
  else if (cmd === 'zoom-in') zoomCommand('in')
  else if (cmd === 'zoom-out') zoomCommand('out')
  else if (cmd === 'zoom-fit') zoomCommand('fit')
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !prefs.hidden) {
    prefs.hidden = true
    return
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  // In Electron the menu handles these; this is the plain-browser fallback.
  if (!window.unstuckApi && e.key === ',') {
    e.preventDefault()
    return openPreferences()
  }
  if (!window.unstuckApi && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    return e.shiftKey ? openPanelFind() : openPdfFind()
  }
  if (!window.unstuckApi && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault()
    return findStep(e.shiftKey ? 'prev' : 'next')
  }
  if (e.shiftKey) {
    if (window.unstuckApi) return
    if (e.key === '+' || e.key === '=') stepFont(1)
    else if (e.key === '_' || e.key === '-') stepFont(-1)
    else return
    e.preventDefault()
    return
  }
  if (e.key === '=' || e.key === '+') zoomCommand('in')
  else if (e.key === '-' || e.key === '_') zoomCommand('out')
  else if (e.key === '0') zoomCommand('fit')
  else return
  e.preventDefault()
})

// --- Startup: reopen the last paper where it was left -----------------------------
// The welcome screen starts hidden so it doesn't flash before the last paper loads.
refreshLists().then(async (papers) => {
  if (papers[0]) await openPaper(papers[0])
  if (!currentId) emptyState.hidden = false
})

// --- Dev hook: lets automated checks open a PDF by URL ----------------------------
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__unstuck = {
    openUrl: async (url: string) => {
      const buf = await (await fetch(url)).arrayBuffer()
      await importPdf(new Uint8Array(buf), decodeURIComponent(url.split('/').pop() ?? 'paper.pdf'))
    },
    selection: () => popup.selection,
    library
  }
}
