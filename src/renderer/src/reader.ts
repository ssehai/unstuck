import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
// pdf_viewer.mjs reads the core library from globalThis, so it must be set
// before the viewer module is evaluated (hence the dynamic import below).
;(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib
const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import('pdfjs-dist/web/pdf_viewer.mjs')

const MIN_SCALE = 0.25
const MAX_SCALE = 5

export interface ReaderView {
  page: number
  scale: string
}

export interface ReaderEvents {
  onPageChange?: (page: number, total: number) => void
  onScaleChange?: (scale: number) => void
  onDocumentLoaded?: (doc: PDFDocumentProxy) => void
  onTextLayer?: (page: number) => void
}

/** Thin wrapper around pdf.js's PDFViewer: scrolling, text layer, zoom. */
export class Reader {
  readonly container: HTMLDivElement
  private readonly eventBus = new EventBus()
  private readonly linkService = new PDFLinkService({ eventBus: this.eventBus })
  private readonly viewer: InstanceType<typeof PDFViewer>
  private readonly finder: InstanceType<typeof PDFFindController>
  /** Called with match counts while searching (⌘F). */
  onFindCount?: (current: number, total: number) => void
  private readonly events: ReaderEvents
  private doc: PDFDocumentProxy | null = null
  private pendingView: ReaderView | null = null

  constructor(container: HTMLDivElement, viewerEl: HTMLDivElement, events: ReaderEvents = {}) {
    this.container = container
    this.events = events
    this.finder = new PDFFindController({ linkService: this.linkService, eventBus: this.eventBus })
    this.viewer = new PDFViewer({
      findController: this.finder,
      container,
      viewer: viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      textLayerMode: 1, // enable selectable text
      removePageBorders: false
    })
    this.linkService.setViewer(this.viewer)

    this.eventBus.on('pagesinit', () => {
      const v = this.pendingView
      this.pendingView = null
      this.viewer.currentScaleValue = v?.scale || 'page-width'
      if (v && v.page > 1 && v.page <= (this.doc?.numPages ?? 0)) this.viewer.currentPageNumber = v.page
    })
    this.eventBus.on('pagechanging', (e: { pageNumber: number }) => {
      events.onPageChange?.(e.pageNumber, this.doc?.numPages ?? 0)
    })
    const reportCount = (e: { matchesCount?: { current: number; total: number } }): void => {
      if (e.matchesCount) this.onFindCount?.(e.matchesCount.current, e.matchesCount.total)
    }
    this.eventBus.on('updatefindmatchescount', reportCount)
    this.eventBus.on('updatefindcontrolstate', reportCount)
    this.eventBus.on('textlayerrendered', (e: { pageNumber: number }) => {
      events.onTextLayer?.(e.pageNumber)
    })
    this.eventBus.on('scalechanging', (e: { scale: number }) => {
      events.onScaleChange?.(e.scale)
    })

    window.addEventListener('resize', () => {
      if (this.doc && this.viewer.currentScaleValue === 'page-width') {
        this.viewer.currentScaleValue = 'page-width'
      }
    })
  }

  get isOpen(): boolean {
    return this.doc !== null
  }

  get document(): PDFDocumentProxy | null {
    return this.doc
  }

  /** Resolves once the given page's text layer is rendered (or after a timeout). */
  waitForTextLayer(page: number, timeoutMs = 3000): Promise<void> {
    const el = this.container.querySelector(`.page[data-page-number="${page}"] .textLayer span`)
    if (el) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        this.eventBus.off('textlayerrendered', onRendered)
        clearTimeout(timer)
        resolve()
      }
      const onRendered = (e: { pageNumber: number }): void => {
        if (e.pageNumber === page) done()
      }
      const timer = setTimeout(done, timeoutMs)
      this.eventBus.on('textlayerrendered', onRendered)
    })
  }

  /** Where the reader is: page and zoom, so it can be restored next time. */
  get view(): ReaderView {
    return { page: this.viewer.currentPageNumber, scale: String(this.viewer.currentScaleValue) }
  }

  /** Opens a PDF, optionally returning to a saved page and zoom. */
  async open(data: Uint8Array, view?: ReaderView): Promise<PDFDocumentProxy> {
    // pdf.js transfers the buffer to its worker, so give it a copy.
    const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
    if (this.doc) await this.doc.destroy()
    this.doc = doc
    this.pendingView = view ?? null
    this.viewer.setDocument(doc)
    this.linkService.setDocument(doc)
    this.finder.setDocument(doc)
    this.events.onDocumentLoaded?.(doc)
    this.events.onPageChange?.(1, doc.numPages)
    return doc
  }

  /**
   * Renders part of a page to a PNG at a fixed resolution, independent of the
   * current zoom. The region is given as fractions of the page size.
   */
  async renderRegion(
    pageNumber: number,
    region: { x: number; y: number; width: number; height: number },
    pixelsPerPoint = 3
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    if (!this.doc) return null
    const page = await this.doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: pixelsPerPoint })
    const sx = region.x * viewport.width
    const sy = region.y * viewport.height
    const width = Math.max(1, Math.round(region.width * viewport.width))
    const height = Math.max(1, Math.round(region.height * viewport.height))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    // Shift the page so the region's corner lands at the canvas origin.
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -sx, -sy] }).promise
    return { dataUrl: canvas.toDataURL('image/png'), width, height }
  }

  /** Search the whole PDF (pdf.js highlights matches in the text layer). */
  find(query: string, direction: 'new' | 'next' | 'prev'): void {
    if (!this.doc) return
    this.eventBus.dispatch('find', {
      source: this,
      type: direction === 'new' ? '' : 'again',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: direction === 'prev',
      matchDiacritics: false
    })
  }

  /** Removes search highlights. */
  clearFind(): void {
    this.eventBus.dispatch('findbarclose', { source: this })
  }

  get scale(): number {
    return this.viewer.currentScale
  }

  setScale(scale: number): void {
    this.viewer.currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  }

  zoomIn(): void {
    this.viewer.increaseScale()
  }

  zoomOut(): void {
    this.viewer.decreaseScale()
  }

  /**
   * Multiplies the zoom by `factor`, keeping the point under (clientX, clientY)
   * fixed on screen (used for trackpad pinch). Without a point, the centre of
   * the view stays fixed.
   */
  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    if (!this.doc) return
    const c = this.container.getBoundingClientRect()
    const origin = [clientX ?? c.left + c.width / 2, clientY ?? c.top + c.height / 2]
    // pdf.js rounds each step to 2 decimals, so small pinch steps would get
    // lost. Track the intended scale across a gesture and steer towards it.
    const now = performance.now()
    if (now - this.pinchLast > 300) this.pinchTarget = this.viewer.currentScale
    this.pinchLast = now
    this.pinchTarget = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.pinchTarget * factor))
    const scaleFactor = this.pinchTarget / this.viewer.currentScale
    if (Math.abs(scaleFactor - 1) < 0.005) return
    // drawingDelay: while the gesture continues, pdf.js stretches the pages
    // it already drew (no blank flash) and re-renders sharply once it pauses.
    this.viewer.updateScale({ scaleFactor, origin, drawingDelay: 400 })
  }

  private pinchTarget = 1
  private pinchLast = 0

  /**
   * Call before the viewer's width starts changing (the side panel slides or
   * is resized). `update()` is called on every frame of the change and
   * `finish()` once at the end:
   * - if the whole page width was visible, the pages keep fitting the width
   *   while it changes (scaled with CSS, re-rendered sharply at the end);
   * - if the reader had zoomed in, the zoom is kept and the point at the
   *   centre of the view stays at the centre.
   */
  beginResize(): { update(): void; finish(): void } {
    const none = { update: () => undefined, finish: () => undefined }
    if (!this.doc) return none
    const c = this.container
    const page = c.querySelector<HTMLElement>('.page')
    const fitted = this.viewer.currentScaleValue === 'page-width' || (!!page && page.offsetWidth <= c.clientWidth + 2)
    const centreX = (c.scrollLeft + c.clientWidth / 2) / Math.max(1, c.scrollWidth)
    const s0 = this.viewer.currentScale
    const w0 = c.clientWidth
    const PAD = 40 // pdf.js's horizontal padding for "page-width"
    const keepCentre = (): void => {
      c.scrollLeft = centreX * c.scrollWidth - c.clientWidth / 2
    }
    return {
      update: () => {
        if (!fitted) return keepCentre()
        const target = (s0 * (c.clientWidth - PAD)) / Math.max(1, w0 - PAD)
        const factor = target / this.viewer.currentScale
        // drawingDelay: stretch what is drawn now, re-render once it settles.
        if (Math.abs(factor - 1) > 0.004) this.viewer.updateScale({ scaleFactor: factor, drawingDelay: 300 })
      },
      finish: () => {
        if (fitted) this.viewer.currentScaleValue = 'page-width'
        else keepCentre()
      }
    }
  }

  fitWidth(): void {
    this.viewer.currentScaleValue = 'page-width'
  }

  goToPage(page: number): void {
    this.viewer.currentPageNumber = page
  }
}
