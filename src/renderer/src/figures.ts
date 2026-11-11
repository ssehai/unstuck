/**
 * Figures of a paper, found once when the paper is first opened and saved in
 * the library with their captions, so a figure can be clicked and asked about
 * like a text selection.
 *
 * Papers draw most figures as vector graphics (plots), not embedded images,
 * so figures are found from their captions instead:
 *
 *  1. A caption is a text line that starts with "Figure N:" / "Fig. N." (a
 *     colon or period right after the number; "Figure 3 shows…" in running
 *     text does not match), plus the lines of the same block below it.
 *  2. The figure sits above its caption, in the caption's column (or across
 *     the page for a wide caption), up to the nearest line of body text, i.e.
 *     a line that fills most of the column. Labels inside plots are short.
 *  3. The region is then trimmed to the ink actually drawn there; a region
 *     with no ink is not a figure.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PaperFigure {
  /** "Figure 3" */
  label: string
  page: number
  /** Region as fractions (0–1) of the page, like CaptureRegion. */
  x: number
  y: number
  width: number
  height: number
  /** Full caption text, starting with the label. */
  caption: string
}

/** Bump when detection changes, so saved figures are found again. */
export const FIGURES_VERSION = 2

/** Points from the page top where content can start (page headers sit above). */
const TOP_MARGIN = 24

const CAPTION = /^\s*(Figure|Fig\.)\s*(\d+)\s*[:.]/i

interface Line {
  text: string
  x0: number
  x1: number
  top: number
  bottom: number
}

/** Text lines of a page, in PDF points with y growing downwards. */
async function pageLines(page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, pageHeight: number): Promise<Line[]> {
  const content = await page.getTextContent()
  const items: { str: string; x: number; y: number; w: number; h: number }[] = []
  for (const it of content.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const [, , c, d, e, f] = it.transform as number[]
    const h = Math.hypot(c, d) || it.height
    items.push({ str: it.str, x: e, y: pageHeight - f, w: it.width, h })
  }
  // Group items by baseline into lines.
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: { y: number; h: number; parts: typeof items }[] = []
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, l.h * 0.4))
    if (line) line.parts.push(it)
    else lines.push({ y: it.y, h: it.h, parts: [it] })
  }
  // A line can hold two columns' text at the same baseline; split it at wide gaps.
  const out: Line[] = []
  for (const l of lines) {
    const parts = l.parts.sort((a, b) => a.x - b.x)
    let run: typeof parts = []
    const flush = (): void => {
      if (!run.length) return
      out.push({
        text: run.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim(),
        x0: run[0].x,
        x1: Math.max(...run.map((p) => p.x + p.w)),
        top: l.y - l.h * 0.85,
        bottom: l.y + l.h * 0.25
      })
      run = []
    }
    for (const p of parts) {
      const prev = run[run.length - 1]
      if (prev && p.x - (prev.x + prev.w) > l.h * 2.5) flush()
      run.push(p)
    }
    flush()
  }
  return out.sort((a, b) => a.top - b.top || a.x0 - b.x0)
}

/**
 * Body text fills most of the column with many characters. Plot titles and
 * legend rows ("MAPPO IPPO QMix …") can be as wide, but are short in text.
 */
function isBodyLine(l: Line, colW: number): boolean {
  return l.x1 - l.x0 > colW * 0.6 && l.text.length >= colW / 7 && !CAPTION.test(l.text)
}

/** Finds the figures of a paper. Pages are rendered once at low resolution to trim regions to their ink. */
export async function extractFigures(doc: PDFDocumentProxy, onSkip?: (label: string, page: number, why: string) => void): Promise<PaperFigure[]> {
  const figures: PaperFigure[] = []
  const seen = new Set<string>()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const lines = await pageLines(page, vp.height)
    const captions = lines.filter((l) => CAPTION.test(l.text))
    if (captions.length === 0) continue

    // The text area, from lines long enough to be body text.
    const long = lines.filter((l) => l.x1 - l.x0 > vp.width * 0.25)
    if (long.length === 0) continue
    const left = Math.min(...long.map((l) => l.x0))
    const right = Math.max(...long.map((l) => l.x1))
    const mid = (left + right) / 2

    const found: { label: string; caption: string; x0: number; x1: number; top: number; bottom: number }[] = []
    // Each caption's block: following lines close below it in the same column.
    const blocks = captions.map((cap) => {
      const block = [cap]
      for (const l of lines) {
        const last = block[block.length - 1]
        if (l.top <= last.top || block.includes(l)) continue
        const gap = l.top - last.bottom
        const overlaps = l.x0 < cap.x1 + 5 && l.x1 > cap.x0 - 5
        if (overlaps && gap < (last.bottom - last.top) * 0.9) block.push(l)
        else if (overlaps && gap >= 0) break
      }
      return {
        cap,
        lines: block,
        x0: Math.min(...block.map((l) => l.x0)),
        x1: Math.max(...block.map((l) => l.x1)),
        bottom: Math.max(...block.map((l) => l.bottom))
      }
    })

    for (const b of blocks) {
      const { cap } = b
      const label = `Figure ${cap.text.match(CAPTION)![2]}`
      if (seen.has(label)) {
        onSkip?.(label, n, 'duplicate')
        continue
      }
      // Column of the figure: the whole width for a wide caption.
      const wide = b.x1 - b.x0 > (right - left) * 0.55 || (b.x0 < mid - 20 && b.x1 > mid + 20)
      const x0 = wide ? left : b.x0 < mid ? left : mid
      const x1 = wide ? right : b.x0 < mid ? mid : right
      const colW = x1 - x0
      // The figure ends upwards at the nearest body text or another figure's
      // caption above it in that column; else at the page's top margin (an
      // image-only figure has no text of its own). The ink trims it.
      const ceilings = [
        ...lines.filter((l) => l.bottom <= cap.top + 1 && l.x0 < x1 && l.x1 > x0 && isBodyLine(l, colW)).map((l) => l.bottom),
        ...blocks.filter((o) => o !== b && o.bottom <= cap.top + 1 && o.x0 < x1 && o.x1 > x0).map((o) => o.bottom)
      ]
      const top = ceilings.length ? Math.max(...ceilings) + 1 : TOP_MARGIN
      if (cap.top - top < 30) {
        onSkip?.(label, n, 'no room above the caption')
        continue
      }
      found.push({
        label,
        caption: b.lines.map((l) => l.text).join(' ').replace(/-\s(?=[a-z])/g, ''),
        x0,
        x1,
        top,
        bottom: cap.top - 1
      })
    }
    if (found.length === 0) continue

    // Trim each region to its ink.
    const scale = 1.5
    const rvp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(rvp.width)
    canvas.height = Math.ceil(rvp.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) continue
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport: rvp }).promise
    for (const f of found) {
      const ink = inkBox(ctx, f.x0 * scale, f.top * scale, f.x1 * scale, f.bottom * scale)
      if (!ink) {
        onSkip?.(f.label, n, 'no ink')
        continue
      }
      const pad = 3 * scale
      const bx0 = Math.max(0, ink.x0 - pad) / scale
      const by0 = Math.max(0, ink.y0 - pad) / scale
      const bx1 = Math.min(canvas.width, ink.x1 + pad) / scale
      const by1 = Math.min(canvas.height, ink.y1 + pad) / scale
      if (by1 - by0 < 20 || bx1 - bx0 < 20) {
        onSkip?.(f.label, n, 'too small')
        continue
      }
      seen.add(f.label)
      figures.push({
        label: f.label,
        page: n,
        x: bx0 / vp.width,
        y: by0 / vp.height,
        width: (bx1 - bx0) / vp.width,
        height: (by1 - by0) / vp.height,
        caption: f.caption
      })
    }
  }
  return figures
}

/** Bounding box of non-white pixels inside a canvas rectangle. */
function inkBox(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const sx = Math.max(0, Math.floor(x0))
  const sy = Math.max(0, Math.floor(y0))
  const w = Math.min(ctx.canvas.width, Math.ceil(x1)) - sx
  const h = Math.min(ctx.canvas.height, Math.ceil(y1)) - sy
  if (w <= 0 || h <= 0) return null
  const data = ctx.getImageData(sx, sy, w, h).data
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x0: sx + minX, y0: sy + minY, x1: sx + maxX + 1, y1: sy + maxY + 1 }
}
