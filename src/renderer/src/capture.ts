/**
 * Equation capture: finds the whole visual block around a selection and
 * returns it as a crisp image, independent of what exactly was highlighted.
 *
 * Why: PDFs don't contain LaTeX, and the text layer turns math into a jumble
 * ("E(s,a,r,s′)∼D a ′∼π θ (·|s ′)"). An image of the rendered equation lets
 * the LLM read the real structure. Selecting just part of an equation must
 * still send the whole equation, so the region is found from the page's ink:
 *
 *  1. Column: the text lines that horizontally overlap the selection give the
 *     column's left/right edges (so two-column papers stay in one column, and
 *     equation numbers are included).
 *  2. Block: starting from the selected rows, grow up and down through ink,
 *     bridging the small blank gaps between lines of one block. Display
 *     equations are set apart by larger gaps, so the growth stops there.
 *  3. If the block turns out to be a whole paragraph (inline math), only the
 *     selected lines (plus a little margin) are kept.
 */
import { getLines, pageCanvas, selectionBoxes, type Box } from './lineModel'

export interface CaptureRegion {
  page: number
  /** Region as fractions (0–1) of the page's width and height, so it is independent of zoom. */
  x: number
  y: number
  width: number
  height: number
}

// Symbols that show up in text extracted from math.
const MATHY = /[=<>≤≥≈≠∼∝∑∏∫∮∂∇∞√±×÷·∘∈∉⊂⊆∪∩∀∃→←↔⇒⇔↦|^_αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ𝔼]/

export function looksMathy(text: string): boolean {
  return MATHY.test(text)
}

const MAX_PARAGRAPH_LINES = 6

/** The block to capture for a selection, on the selection's first page. */
export function findCaptureRegion(range: Range, container: HTMLElement): CaptureRegion | null {
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const page = startEl?.closest<HTMLElement>('.page[data-page-number]')
  const canvas = page && pageCanvas(page)
  if (!page || !canvas) return null
  const c = canvas.getBoundingClientRect()

  // Selected rows on this page, in page-local CSS px.
  const rows: Box[] = selectionBoxes(range, container)
    .map((b) => ({ left: b.left - c.left, right: b.right - c.left, top: b.top - c.top, bottom: b.bottom - c.top }))
    .filter((b) => b.bottom > 0 && b.top < c.height)
  if (rows.length === 0) return null
  const sel: Box = {
    left: Math.min(...rows.map((r) => r.left)),
    right: Math.max(...rows.map((r) => r.right)),
    top: Math.min(...rows.map((r) => r.top)),
    bottom: Math.max(...rows.map((r) => r.bottom))
  }

  // Body text height: the most common line height on the page.
  const lines = getLines(page).filter((l) => l.words.length > 0 && l.bottom - l.top < 60)
  const heights = lines.map((l) => l.bottom - l.top).sort((a, b) => a - b)
  const h = heights.length ? heights[Math.floor(heights.length / 2)] : sel.bottom - sel.top

  // 1) Column edges from nearby lines that overlap the selection horizontally.
  let colLeft = sel.left
  let colRight = sel.right
  for (const l of lines) {
    const lx0 = l.words[0].x0
    const lx1 = l.words[l.words.length - 1].x1
    const near = Math.abs((l.top + l.bottom) / 2 - (sel.top + sel.bottom) / 2) < h * 15
    if (near && lx1 > sel.left && lx0 < sel.right) {
      colLeft = Math.min(colLeft, lx0)
      colRight = Math.max(colRight, lx1)
    }
  }
  colLeft -= h * 0.3
  colRight += h * 0.3

  // 2) Grow vertically through ink inside the column.
  const block = growBlock(canvas, c, colLeft, colRight, sel.top, sel.bottom, h)
  let top = block[0]
  let bottom = block[1]

  // 3) A whole paragraph: keep just the selected lines.
  if (bottom - top > h * 1.25 * MAX_PARAGRAPH_LINES) {
    top = sel.top - h * 0.35
    bottom = sel.bottom + h * 0.35
  }

  const pad = h * 0.4
  const x0 = Math.max(0, colLeft - pad)
  const y0 = Math.max(0, top - pad)
  const x1 = Math.min(c.width, colRight + pad)
  const y1 = Math.min(c.height, bottom + pad)
  return {
    page: Number(page.dataset.pageNumber),
    x: x0 / c.width,
    y: y0 / c.height,
    width: (x1 - x0) / c.width,
    height: (y1 - y0) / c.height
  }
}

/**
 * Rows of ink inside [left, right], grown from [top, bottom] in both
 * directions until a blank gap wider than ~0.45 line heights (or a limit).
 */
function growBlock(
  canvas: HTMLCanvasElement,
  c: DOMRect,
  left: number,
  right: number,
  top: number,
  bottom: number,
  h: number
): [number, number] {
  const k = canvas.width / c.width
  const limit = h * 12 // never look further than this above/below
  const x0 = Math.max(0, Math.floor(left * k))
  const x1 = Math.min(canvas.width, Math.ceil(right * k))
  const y0 = Math.max(0, Math.floor((top - limit) * k))
  const y1 = Math.min(canvas.height, Math.ceil((bottom + limit) * k))
  const w = x1 - x0
  const hh = y1 - y0
  if (w <= 0 || hh <= 0) return [top, bottom]

  let data: Uint8ClampedArray
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return [top, bottom]
    data = ctx.getImageData(x0, y0, w, hh).data
  } catch {
    return [top, bottom]
  }
  const inked: boolean[] = []
  for (let y = 0; y < hh; y++) {
    let on = false
    for (let x = 0; x < w && !on; x++) {
      const i = (y * w + x) * 4
      on = data[i + 3] > 40 && data[i] + data[i + 1] + data[i + 2] < 600
    }
    inked.push(on)
  }

  const maxGap = h * 0.45 * k
  let t = Math.round(top * k) - y0
  let b = Math.round(bottom * k) - y0
  for (let y = t - 1, gap = 0; y >= 0; y--) {
    if (inked[y]) {
      t = y
      gap = 0
    } else if (++gap > maxGap) break
  }
  for (let y = b + 1, gap = 0; y < hh; y++) {
    if (inked[y]) {
      b = y
      gap = 0
    } else if (++gap > maxGap) break
  }
  return [(y0 + t) / k, (y0 + b + 1) / k]
}
