import { installDragSelect } from './dragSelect'
import { selectionBoxes, type Box } from './lineModel'
import { clearOverlays, pageOverlay, placeBox, toPageBoxes, type PageBox } from './overlay'
import { rangeText, snapToWords } from './textGeometry'

/** A passage the user selected in the PDF. */
export interface StuckSelection {
  text: string
  pageStart: number
  pageEnd: number
  /** The snapped DOM range (renderer-only; used e.g. to capture equations). */
  range: Range
}

const MIN_CHARS = 2

/**
 * Handles selection inside the PDF viewer.
 *
 * Selecting a passage only marks it as *pending*, with a small "질문하기"
 * button at its end; the question starts when that button (or Enter) is
 * pressed. A click elsewhere or Esc drops the pending selection.
 *
 * Highlights are drawn on the page (in percent of the page, see overlay.ts);
 * the card with the explanation lives in the side panel.
 */
export class SelectionPopup {
  private readonly container: HTMLElement
  private readonly card: HTMLDivElement
  private readonly emptyHint: HTMLElement | null
  /** The asked passage's highlight, as page fractions. */
  private hl: PageBox[] = []
  private current: StuckSelection | null = null
  /** Selected but not asked about yet. */
  private pending: { sel: StuckSelection; boxes: PageBox[] } | null = null
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
      onStart: () => this.clearPending(),
      onUpdate: (raw) => this.preview(raw),
      // A plain click (no drag) just drops a pending selection.
      onEnd: (raw) => (raw ? this.commit(raw) : this.clearDraft())
    })
    document.addEventListener('keydown', (e) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('textarea, input')
      if (e.key === 'Escape') {
        if (this.pending) this.clearPending()
        else this.hide()
      } else if (e.key === 'Enter' && this.pending && !typing && !e.isComposing) {
        e.preventDefault()
        this.ask()
      }
    })
  }

  get selection(): StuckSelection | null {
    return this.current
  }

  /** Text of a selection that has not been asked about yet, if any. */
  get pendingText(): string | null {
    return this.pending?.sel.text ?? null
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

  /** Highlights a saved passage (reopened from the stuck-point list). */
  showSavedHighlight(range: Range): void {
    this.drawHighlights(selectionBoxes(range, this.container))
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

  /** Drops a selection that was not asked about. */
  clearPending(): void {
    this.pending = null
    this.draft = []
    this.renderPending()
  }

  /** Finalize a selection: snap to words and offer the "질문하기" button. */
  commit(raw: Range): void {
    this.draft = []
    const range = snapToWords(raw, this.container)
    if (!range) return this.clearPending()
    const startPage = pageOf(range.startContainer)
    const endPage = pageOf(range.endContainer)
    const boxes = selectionBoxes(range, this.container)
    const text = rangeText(range, this.container)
    if (startPage === null || endPage === null || boxes.length === 0 || text.length < MIN_CHARS) {
      return this.clearPending()
    }
    this.pending = { sel: { text, pageStart: startPage, pageEnd: endPage, range }, boxes: toPageBoxes(boxes, this.container) }
    this.renderPending()
  }

  /** Starts the question about the pending selection. */
  ask(): void {
    if (!this.pending) return
    const { sel, boxes } = this.pending
    this.pending = null
    this.renderPending()
    if (!this.card.hidden) this.onHide?.() // stop the previous explanation
    this.current = sel
    this.hl = boxes
    this.renderHighlights()
    this.locate = () => this.scrollToSelection()
    this.render(sel, (body) => this.onSelect?.(sel, body))
  }

  /**
   * Shows a saved stuck point in the panel (no live selection). `locate`
   * brings its passage into view; `fill` receives the card body.
   */
  openSaved(info: { text: string; pageStart: number; pageEnd: number }, locate: () => void, fill: (body: HTMLElement) => void): void {
    if (!this.card.hidden) this.onHide?.()
    this.clearPending()
    this.current = null
    this.hl = []
    this.renderHighlights()
    this.locate = locate
    this.render(info, fill)
  }

  private render(s: { text: string; pageStart: number; pageEnd: number }, fill: (body: HTMLElement) => void): void {
    const pages = s.pageStart === s.pageEnd ? `p.${s.pageStart}` : `pp.${s.pageStart}–${s.pageEnd}`
    this.card.innerHTML = `
      <div class="sp-head">
        <button class="sp-tag" title="Show the selection in the paper">Stuck here · ${pages}</button>
        <button class="sp-close" title="Close (Esc)">×</button>
      </div>
      <blockquote class="sp-quote"></blockquote>
      <div class="sp-body"></div>`
    this.card.querySelector('.sp-quote')!.textContent = truncate(s.text, 280)
    this.card.querySelector('.sp-close')!.addEventListener('click', () => this.hide())
    this.card.querySelector('.sp-tag')!.addEventListener('click', () => this.locate())

    const body = this.card.querySelector<HTMLElement>('.sp-body')!
    this.card.hidden = false
    if (this.emptyHint) this.emptyHint.hidden = true
    fill(body)
  }

  /** Brings the highlighted passage back into view. */
  private scrollToSelection(): void {
    const first = this.container.querySelector<HTMLElement>('.uo-hl .stuck-hl')
    if (!first) return
    const c = this.container.getBoundingClientRect()
    const top = first.getBoundingClientRect().top - c.top + this.container.scrollTop
    this.container.scrollTo({ top: Math.max(0, top - this.container.clientHeight / 3), behavior: 'smooth' })
  }

  private drawHighlights(boxes: Box[]): void {
    this.hl = toPageBoxes(boxes, this.container)
    this.renderHighlights()
  }

  /** The dragged / pending highlight, plus the ask button at its end. */
  private renderPending(): void {
    clearOverlays(this.container, 'pending')
    const boxes = this.pending ? this.pending.boxes : this.draft
    for (const b of boxes) {
      const overlay = pageOverlay(this.container, b.page, 'pending')
      if (!overlay) continue
      const d = document.createElement('div')
      d.className = 'stuck-hl pending'
      placeBox(d, b, 1)
      overlay.appendChild(d)
    }
    if (!this.pending || boxes.length === 0) return
    // The button sits just below the end of the last line.
    const last = boxes[boxes.length - 1]
    const overlay = pageOverlay(this.container, last.page, 'pending')
    if (!overlay) return
    const btn = document.createElement('button')
    btn.className = 'ask-btn'
    btn.innerHTML = '<span class="ask-q">?</span>질문하기'
    btn.title = '이 구절에 대해 질문하기 (Enter)'
    btn.style.left = `calc(${(last.left + last.width) * 100}% - 14px)`
    btn.style.top = `calc(${(last.top + last.height) * 100}% + 4px)`
    btn.addEventListener('mousedown', (e) => e.stopPropagation())
    btn.addEventListener('click', () => this.ask())
    overlay.appendChild(btn)
  }

  private renderHighlights(): void {
    clearOverlays(this.container, 'hl')
    for (const b of this.hl) {
      const overlay = pageOverlay(this.container, b.page, 'hl')
      if (!overlay) continue
      const d = document.createElement('div')
      d.className = 'stuck-hl'
      placeBox(d, b, 1) // a hair of breathing room around the glyphs
      overlay.appendChild(d)
    }
  }
}

function pageOf(node: Node): number | null {
  const el = node instanceof Element ? node : node.parentElement
  const page = el?.closest<HTMLElement>('.page[data-page-number]')
  return page ? Number(page.dataset.pageNumber) : null
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
