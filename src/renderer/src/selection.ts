import { installDragSelect } from './dragSelect'
import { selectionBoxes } from './lineModel'
import { clearOverlays, pageOverlay, placeBox, toPageBoxes, type PageBox } from './overlay'
import { rangeText, snapToWords } from './textGeometry'
import type { PaperFigure } from './figures'

/** A passage the user selected in the PDF. */
export interface StuckSelection {
  text: string
  pageStart: number
  pageEnd: number
  /** The snapped DOM range (renderer-only; used e.g. to capture equations). Absent for a figure. */
  range?: Range
  /** Set when a whole figure was clicked: `text` is then its caption. */
  figure?: PaperFigure
  /** Several places asked about together (⌘-selection), in selection order. */
  parts?: StuckSelection[]
}

/** What the panel card shows for a passage (several `places` when asked together). */
export interface SavedInfo {
  text: string
  pageStart: number
  pageEnd: number
  places?: string[]
}

const MIN_CHARS = 2
/** Places that can be asked about together (each figure or equation among them is one image). */
export const MAX_PARTS = 10
export const NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩'

/** A highlight box; figures are outlined, text is marked. */
interface Mark {
  box: PageBox
  figure: boolean
}

interface Pending {
  sel: StuckSelection
  marks: Mark[]
}

/**
 * Handles selection inside the PDF viewer.
 *
 * Selecting a passage (dragging, double-clicking a word, or clicking a
 * figure) only marks it as *pending*, with a small "질문하기" button at its
 * end; the question starts when that button (or Enter) is pressed. Holding ⌘
 * adds more places to the pending selection, to ask about them together. A
 * click elsewhere or Esc drops the pending selection.
 *
 * Highlights are drawn on the page (in percent of the page, see overlay.ts);
 * the card with the explanation lives in the side panel.
 */
export class SelectionPopup {
  private readonly container: HTMLElement
  private readonly card: HTMLDivElement
  private readonly emptyHint: HTMLElement | null
  /** The asked passage's highlight, as page fractions. */
  private hl: Mark[] = []
  private current: StuckSelection | null = null
  /** Selected but not asked about yet (several with ⌘). */
  private pending: Pending[] = []
  /** Highlight shown while dragging. */
  private draft: PageBox[] = []
  onSelect?: (sel: StuckSelection, body: HTMLElement) => void
  onHide?: () => void
  private locate: () => void = () => undefined

  constructor(container: HTMLElement, panel: HTMLElement) {
    this.container = container

    this.emptyHint = panel.querySelector('.panel-home')
    this.card = document.createElement('div')
    this.card.className = 'stuck-card'
    this.card.hidden = true
    panel.appendChild(this.card)

    // The explanation stays in the panel until a new passage is selected or
    // it is cleared (× / Esc); a stray click on the page doesn't lose it.
    installDragSelect(container, {
      isIgnored: (t) => !!t.closest('.ask-btn'),
      onStart: (additive) => {
        if (!additive) this.clearPending()
      },
      onUpdate: (raw) => this.preview(raw),
      // A plain click (no drag) drops the pending selection, unless ⌘ is held.
      onEnd: (raw, additive) => (raw ? this.commit(raw, additive) : additive ? this.clearDraftOnly() : this.clearDraft())
    })
    document.addEventListener('keydown', (e) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('textarea, input')
      if (e.key === 'Escape') {
        if (this.pending.length) this.clearPending()
        else this.hide()
      } else if (e.key === 'Enter' && this.pending.length && !typing && !e.isComposing) {
        e.preventDefault()
        this.ask()
      }
    })
  }

  get selection(): StuckSelection | null {
    return this.current
  }

  /** Text of a single selection that has not been asked about yet, if any. */
  get pendingText(): string | null {
    return this.pending.length === 1 && !this.pending[0].sel.figure ? this.pending[0].sel.text : null
  }

  get cardOpen(): boolean {
    return !this.card.hidden
  }

  hide(): void {
    if (!this.card.hidden) this.onHide?.()
    this.card.hidden = true
    if (this.emptyHint) this.emptyHint.hidden = false
    this.hl = []
    this.renderHighlights()
    this.current = null
  }

  /**
   * Redraws the stored highlights (e.g. when pdf.js re-created a page). Zooming
   * needs nothing: the boxes are in percent of the page and scale with it.
   */
  refreshHighlight(): void {
    this.renderHighlights()
    this.renderPending()
  }

  /** Highlights saved places (reopened from a stuck point): text ranges and figures. */
  showSaved(ranges: Range[], figures: PaperFigure[] = []): void {
    this.hl = [
      ...ranges.flatMap((r) => toPageBoxes(selectionBoxes(r, this.container), this.container).map((box) => ({ box, figure: false }))),
      ...figures.map((f) => ({ box: figureBox(f), figure: true }))
    ]
    this.renderHighlights()
  }

  /** Highlights a saved passage (reopened from the stuck-point list). */
  showSavedHighlight(range: Range): void {
    this.showSaved([range])
  }

  /** Outlines a saved figure (reopened from a stuck point). */
  showFigureHighlight(f: PaperFigure): void {
    this.showSaved([], [f])
  }

  /** A click on a figure: offer the "질문하기" button for the whole figure (⌘: add it). */
  commitFigure(f: PaperFigure, additive = false): void {
    this.draft = []
    this.add({ sel: { text: f.caption, pageStart: f.page, pageEnd: f.page, figure: f }, marks: [{ box: figureBox(f), figure: true }] }, additive)
  }

  /** Live highlight while dragging, already snapped to whole words. */
  private preview(raw: Range): void {
    const range = snapToWords(raw, this.container)
    this.draft = range ? toPageBoxes(selectionBoxes(range, this.container), this.container) : []
    this.renderPending()
  }

  private clearDraft(): void {
    this.draft = []
    this.clearPending()
  }

  private clearDraftOnly(): void {
    this.draft = []
    this.renderPending()
  }

  /** Drops the selection(s) not asked about. */
  clearPending(): void {
    this.pending = []
    this.draft = []
    this.renderPending()
  }

  /** Finalize a selection: snap to words and offer the "질문하기" button (⌘: add it to the others). */
  commit(raw: Range, additive = false): void {
    this.draft = []
    const range = snapToWords(raw, this.container)
    if (!range) return additive ? this.renderPending() : this.clearPending()
    const startPage = pageOf(range.startContainer)
    const endPage = pageOf(range.endContainer)
    const boxes = selectionBoxes(range, this.container)
    const text = rangeText(range, this.container)
    if (startPage === null || endPage === null || boxes.length === 0 || text.length < MIN_CHARS) {
      return additive ? this.renderPending() : this.clearPending()
    }
    const marks = toPageBoxes(boxes, this.container).map((box) => ({ box, figure: false }))
    this.add({ sel: { text, pageStart: startPage, pageEnd: endPage, range }, marks }, additive)
  }

  private add(p: Pending, additive: boolean): void {
    if (!additive) this.pending = [p]
    else {
      // ⌘ on a place already selected removes it again.
      const same = this.pending.findIndex((q) => q.sel.text === p.sel.text && q.sel.pageStart === p.sel.pageStart)
      if (same >= 0) this.pending.splice(same, 1)
      else if (this.pending.length < MAX_PARTS) this.pending.push(p)
      else showToast(`최대 ${MAX_PARTS}개까지만 선택할 수 있어요`)
    }
    this.renderPending()
  }

  /** Starts the question about the pending selection(s). */
  ask(): void {
    if (this.pending.length === 0) return
    const items = this.pending
    this.pending = []
    this.renderPending()
    if (!this.card.hidden) this.onHide?.() // stop the previous explanation
    const sel: StuckSelection =
      items.length === 1
        ? items[0].sel
        : {
            text: items.map((p, i) => `${NUMBERS[i]} ${placeLabel(p.sel)}`).join('  '),
            pageStart: Math.min(...items.map((p) => p.sel.pageStart)),
            pageEnd: Math.max(...items.map((p) => p.sel.pageEnd)),
            range: items[0].sel.range,
            parts: items.map((p) => p.sel)
          }
    this.current = sel
    this.hl = items.flatMap((p) => p.marks)
    this.renderHighlights()
    this.locate = () => this.scrollToSelection()
    this.render({ ...sel, places: sel.parts?.map(placeLabel) }, (body) => this.onSelect?.(sel, body))
  }

  /**
   * Shows a saved stuck point in the panel (no live selection). `locate`
   * brings its passage into view; `fill` receives the card body.
   */
  openSaved(info: SavedInfo, locate: () => void, fill: (body: HTMLElement) => void): void {
    if (!this.card.hidden) this.onHide?.()
    this.clearPending()
    this.current = null
    this.hl = []
    this.renderHighlights()
    this.locate = locate
    this.render(info, fill)
  }

  private render(s: SavedInfo, fill: (body: HTMLElement) => void): void {
    const pages = s.pageStart === s.pageEnd ? `p.${s.pageStart}` : `pp.${s.pageStart}–${s.pageEnd}`
    this.card.innerHTML = `
      <div class="sp-head">
        <button class="sp-tag" title="Show the selection in the paper">Stuck here · ${pages}</button>
        <button class="sp-close" title="Close (Esc)">×</button>
      </div>
      <blockquote class="sp-quote"></blockquote>
      <div class="sp-body"></div>`
    const quote = this.card.querySelector('.sp-quote')!
    if (s.places && s.places.length > 1) {
      // Several places: a numbered list, one place per line.
      const ol = document.createElement('ol')
      ol.className = 'sp-places'
      for (const t of s.places) {
        const li = document.createElement('li')
        li.textContent = truncate(t, 160)
        ol.appendChild(li)
      }
      quote.appendChild(ol)
    } else quote.textContent = truncate(s.text, 280)
    this.card.querySelector('.sp-close')!.addEventListener('click', () => this.hide())
    this.card.querySelector('.sp-tag')!.addEventListener('click', () => this.locate())

    const body = this.card.querySelector<HTMLElement>('.sp-body')!
    this.card.hidden = false
    if (this.emptyHint) this.emptyHint.hidden = true
    fill(body)
  }

  /** Brings the highlighted passage back into view. */
  private scrollToSelection(): void {
    const first = this.container.querySelector<HTMLElement>('.uo-hl .stuck-hl, .uo-hl .figure-hl')
    if (!first) return
    const c = this.container.getBoundingClientRect()
    const top = first.getBoundingClientRect().top - c.top + this.container.scrollTop
    this.container.scrollTo({ top: Math.max(0, top - this.container.clientHeight / 3), behavior: 'smooth' })
  }

  /** The dragged / pending highlights, their numbers, and the ask button at the end of the last one. */
  private renderPending(): void {
    clearOverlays(this.container, 'pending')
    const many = this.pending.length + (this.draft.length ? 1 : 0) > 1
    this.pending.forEach((p, i) => {
      p.marks.forEach((m, j) => {
        const overlay = pageOverlay(this.container, m.box.page, 'pending')
        if (!overlay) return
        const d = document.createElement('div')
        d.className = m.figure ? 'figure-hl pending' : 'stuck-hl pending'
        placeBox(d, m.box, m.figure ? 0 : 1)
        overlay.appendChild(d)
        if (many && j === 0) overlay.appendChild(numberBadge(i, m.box))
      })
    })
    for (const b of this.draft) {
      const overlay = pageOverlay(this.container, b.page, 'pending')
      if (!overlay) continue
      const d = document.createElement('div')
      d.className = 'stuck-hl pending'
      placeBox(d, b, 1)
      overlay.appendChild(d)
    }
    const lastItem = this.pending[this.pending.length - 1]
    if (!lastItem || this.draft.length) return
    // The button sits just below the end of the last selection.
    const last = lastItem.marks[lastItem.marks.length - 1].box
    const overlay = pageOverlay(this.container, last.page, 'pending')
    if (!overlay) return
    const n = this.pending.length
    const btn = document.createElement('button')
    btn.className = 'ask-btn'
    btn.innerHTML = `<span class="ask-q">?</span>질문하기${n > 1 ? ` <span class="ask-n">${n}곳</span>` : ''}`
    btn.title =
      (n > 1 ? `선택한 ${n}곳을 함께 질문하기` : lastItem.sel.figure ? '이 그림에 대해 질문하기' : '이 구절에 대해 질문하기') +
      ' (Enter) · ⌘를 누른 채 선택하면 다른 곳을 추가해요'
    btn.style.left = `calc(${(last.left + last.width) * 100}% - 14px)`
    btn.style.top = `calc(${(last.top + last.height) * 100}% + 4px)`
    btn.addEventListener('mousedown', (e) => e.stopPropagation())
    btn.addEventListener('click', () => this.ask())
    overlay.appendChild(btn)
  }

  private renderHighlights(): void {
    clearOverlays(this.container, 'hl')
    for (const m of this.hl) {
      const overlay = pageOverlay(this.container, m.box.page, 'hl')
      if (!overlay) continue
      const d = document.createElement('div')
      d.className = m.figure ? 'figure-hl' : 'stuck-hl'
      placeBox(d, m.box, m.figure ? 0 : 1) // a hair of breathing room around the glyphs
      overlay.appendChild(d)
    }
  }
}

/** What the card shows for a place: a figure by its label, text as selected. */
function placeLabel(s: StuckSelection): string {
  return s.figure ? s.figure.label : s.text
}

/** A short red notice at the bottom of the window. */
let toastTimer = 0
function showToast(message: string): void {
  let t = document.querySelector<HTMLElement>('.limit-toast')
  if (!t) {
    t = document.createElement('div')
    t.className = 'limit-toast'
    t.setAttribute('role', 'alert')
    document.body.appendChild(t)
  }
  t.textContent = message
  t.classList.remove('show')
  void t.offsetWidth // restart the animation when it is already showing
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 2200)
}

/** ①②… at the top-left of a selection, when several are pending. */
function numberBadge(i: number, b: PageBox): HTMLElement {
  const s = document.createElement('span')
  s.className = 'sel-num'
  s.textContent = String(i + 1)
  s.style.left = `${b.left * 100}%`
  s.style.top = `${b.top * 100}%`
  return s
}

function figureBox(f: PaperFigure): PageBox {
  return { page: f.page, left: f.x, top: f.y, width: f.width, height: f.height }
}

function pageOf(node: Node): number | null {
  const el = node instanceof Element ? node : node.parentElement
  const page = el?.closest<HTMLElement>('.page[data-page-number]')
  return page ? Number(page.dataset.pageNumber) : null
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
