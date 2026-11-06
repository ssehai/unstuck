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
 * Handles selection inside the PDF viewer. The highlight is drawn on the page
 * (inside the scroll container, so it scrolls with the text); the card with
 * the explanation lives in the side panel, so it never covers the paper.
 */
export class SelectionPopup {
  private readonly container: HTMLElement
  private readonly card: HTMLDivElement
  private readonly emptyHint: HTMLElement | null
  /** The highlight, as page fractions; drawn inside each page's text layer. */
  private hl: PageBox[] = []
  private current: StuckSelection | null = null
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
      isIgnored: () => false,
      onStart: () => undefined,
      onUpdate: (raw) => this.preview(raw),
      onEnd: (raw) => (raw ? this.commit(raw) : this.refreshHighlight())
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide()
    })
  }

  get selection(): StuckSelection | null {
    return this.current
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
   * Redraws the stored highlight (e.g. after a cancelled drag, or when pdf.js
   * re-created a page's text layer). Zooming needs nothing: the boxes are in
   * percent of the page and scale with it.
   */
  refreshHighlight(): void {
    this.renderHighlights()
  }

  /** Highlights a saved passage (reopened from the stuck-point list). */
  showSavedHighlight(range: Range): void {
    this.drawHighlights(selectionBoxes(range, this.container))
  }

  /** Live highlight while dragging, already snapped to whole words. */
  private preview(raw: Range): void {
    const range = snapToWords(raw, this.container)
    this.drawHighlights(range ? selectionBoxes(range, this.container) : [])
  }

  /** Finalize a selection: snap to words, highlight, fill the panel. */
  commit(raw: Range): void {
    const range = snapToWords(raw, this.container)
    if (!range) return this.refreshHighlight()
    const startPage = pageOf(range.startContainer)
    const endPage = pageOf(range.endContainer)
    const boxes = selectionBoxes(range, this.container)
    const text = rangeText(range, this.container)
    if (startPage === null || endPage === null || boxes.length === 0 || text.length < MIN_CHARS) {
      return this.refreshHighlight()
    }

    if (!this.card.hidden) this.onHide?.() // stop the previous explanation
    const sel: StuckSelection = { text, pageStart: startPage, pageEnd: endPage, range }
    this.current = sel
    this.drawHighlights(boxes)
    this.locate = () => this.scrollToSelection()
    this.render(sel, (body) => this.onSelect?.(sel, body))
  }

  /**
   * Shows a saved stuck point in the panel (no live selection). `locate`
   * brings its passage into view; `fill` receives the card body.
   */
  openSaved(info: { text: string; pageStart: number; pageEnd: number }, locate: () => void, fill: (body: HTMLElement) => void): void {
    if (!this.card.hidden) this.onHide?.()
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
        <button class="sp-close" title="Clear (Esc)">×</button>
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
