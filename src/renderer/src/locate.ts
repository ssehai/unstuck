/**
 * Jump to a citation: go to its page, find the quoted text in that page's
 * text layer, zoom so the lines holding the quote fill the view, centre them,
 * and flash a highlight over the quote.
 */
import { getLines, pageCanvas, selectionBoxes, type Box } from './lineModel'
import { normalizeForMatch } from './paperText'
import type { Reader } from './reader'

/** How much of the view the quoted lines may take up. */
const FILL_WIDTH = 0.92
const FILL_HEIGHT = 0.55
/** Never zoom past this when jumping (a short quote shouldn't blow up). */
const MAX_JUMP_SCALE = 3

/** Finds `quote` in a page's text layer and returns it as a DOM range. */
export function findInPage(page: HTMLElement, quote: string): Range | null {
  const q = normalizeForMatch(quote)
  if (!q) return null
  // Normalized page text, with a map from each normalized char to (node, offset).
  const map: { node: Text; offset: number }[] = []
  let norm = ''
  const walker = document.createTreeWalker(page.querySelector('.textLayer') ?? page, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    for (let i = 0; i < node.data.length; i++) {
      const c = normalizeForMatch(node.data[i])
      for (const ch of c) {
        norm += ch
        map.push({ node, offset: i })
      }
    }
  }
  const at = norm.indexOf(q)
  if (at < 0) return null
  const start = map[at]
  const end = map[at + q.length - 1]
  const r = document.createRange()
  r.setStart(start.node, start.offset)
  r.setEnd(end.node, end.offset + 1)
  return r
}

/**
 * The area to bring into view (viewport px): the quote's rows, widened to the
 * full text lines they sit on, so the whole sentence context is readable.
 */
function focusArea(range: Range, container: HTMLElement, pageEl: HTMLElement): { quote: Box[]; area: Box } | null {
  const quote = selectionBoxes(range, container)
  if (quote.length === 0) return null
  const area: Box = {
    left: Math.min(...quote.map((b) => b.left)),
    right: Math.max(...quote.map((b) => b.right)),
    top: Math.min(...quote.map((b) => b.top)),
    bottom: Math.max(...quote.map((b) => b.bottom))
  }
  const canvas = pageCanvas(pageEl)
  if (canvas) {
    const c = canvas.getBoundingClientRect()
    for (const line of getLines(pageEl)) {
      if (line.words.length === 0) continue
      const top = c.top + line.top
      const bottom = c.top + line.bottom
      const left = c.left + line.words[0].x0
      const right = c.left + line.words[line.words.length - 1].x1
      const onQuoteRow = bottom > area.top && top < area.bottom
      const sameColumn = right > area.left && left < area.right
      if (onQuoteRow && sameColumn) {
        area.left = Math.min(area.left, left)
        area.right = Math.max(area.right, right)
      }
    }
  }
  return { quote, area }
}

// A frame, or 60 ms if frames are paused (e.g. the window is in the background).
const nextFrame = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => r())
    setTimeout(r, 60)
  })

export async function jumpTo(
  reader: Reader,
  container: HTMLElement,
  page: number,
  quote?: string
): Promise<boolean> {
  reader.goToPage(page)
  await reader.waitForTextLayer(page)
  const pageEl = container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
  if (!pageEl || !quote) return false
  const range = findInPage(pageEl, quote)
  if (!range) return false

  const focus = focusArea(range, container, pageEl)
  if (!focus) return false

  // Remember everything as fractions of the page, so it survives the zoom
  // (pdf.js re-lays out and may scroll on its own when the scale changes).
  const p0 = pageEl.getBoundingClientRect()
  const frac = (b: Box): Box => ({
    left: (b.left - p0.left) / p0.width,
    right: (b.right - p0.left) / p0.width,
    top: (b.top - p0.top) / p0.height,
    bottom: (b.bottom - p0.top) / p0.height
  })
  const areaF = frac(focus.area)
  const quoteF = focus.quote.map(frac)

  // 1) Zoom so the lines fill the view's width (or a bit over half its height).
  const view = container.getBoundingClientRect()
  const w = focus.area.right - focus.area.left
  const h = focus.area.bottom - focus.area.top
  const fit = Math.min((view.width * FILL_WIDTH) / w, (view.height * FILL_HEIGHT) / h)
  const target = Math.min(MAX_JUMP_SCALE, reader.scale * fit)
  if (Math.abs(target / reader.scale - 1) > 0.04) {
    reader.setScale(target)
    await nextFrame()
  }

  // 2) Centre the area horizontally, and put it a little above the middle.
  const place = (): void => {
    const p = pageEl.getBoundingClientRect()
    const left = p.left + areaF.left * p.width
    const right = p.left + areaF.right * p.width
    const top = p.top + areaF.top * p.height
    const bottom = p.top + areaF.bottom * p.height
    container.scrollLeft += (left + right) / 2 - (view.left + view.width / 2)
    container.scrollTop += top - (view.top + view.height * 0.38 - (bottom - top) / 2)
  }
  place()
  await nextFrame()
  place() // again, in case pdf.js adjusted the scroll after the zoom

  // 3) Flash the quote itself.
  const p = pageEl.getBoundingClientRect()
  flash(
    container,
    quoteF.map((b) => ({
      left: p.left + b.left * p.width,
      right: p.left + b.right * p.width,
      top: p.top + b.top * p.height,
      bottom: p.top + b.bottom * p.height
    }))
  )
  return true
}

function flash(container: HTMLElement, boxes: Box[]): void {
  container.querySelector('.flash-layer')?.remove()
  const layer = document.createElement('div')
  layer.className = 'flash-layer'
  const c = container.getBoundingClientRect()
  for (const b of boxes) {
    const d = document.createElement('div')
    d.className = 'flash-hl'
    Object.assign(d.style, {
      left: `${b.left - c.left + container.scrollLeft - 1}px`,
      top: `${b.top - c.top + container.scrollTop - 1}px`,
      width: `${b.right - b.left + 2}px`,
      height: `${b.bottom - b.top + 2}px`
    })
    layer.appendChild(d)
  }
  container.appendChild(layer)
  setTimeout(() => layer.classList.add('fade'), 1800)
  setTimeout(() => layer.remove(), 2600)
}
