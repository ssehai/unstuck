/**
 * Word-accurate geometry for a pdf.js page.
 *
 * pdf.js's invisible text layer is drawn in a generic fallback font
 * (e.g. sans-serif) and only stretched so each run has the right total width.
 * Positions *inside* a run therefore drift from the real glyphs (Times,
 * Computer Modern, ...), by up to about a character.
 *
 * Fix: read the rendered canvas. Each text line's ink is split into words at
 * the blank gaps between them. When the number of ink words matches the
 * number of text words, word i of the text gets the exact pixels of ink
 * word i. Otherwise (formulas, odd spacing) we fall back to the text layer's
 * estimate for that line.
 */

export interface Caret {
  node: Text
  offset: number
}

export interface Word {
  text: string
  from: Caret // first character
  to: Caret // just after the last character
  /** Horizontal extent in page-local CSS px (relative to the canvas). */
  x0: number
  x1: number
}

export interface Line {
  top: number // page-local CSS px
  bottom: number
  words: Word[]
  inkAligned: boolean
}

interface SpanInfo {
  node: Text
  left: number
  right: number
  top: number
  bottom: number
}

const WS = /\s/

const cache = new WeakMap<Element, { key: string; canvas: HTMLCanvasElement; lines: Line[] }>()

export function pageCanvas(page: Element): HTMLCanvasElement | null {
  return page.querySelector<HTMLCanvasElement>('.canvasWrapper canvas')
}

/** Lines of a rendered page, cached until the page is re-rendered or zoomed. */
export function getLines(page: HTMLElement): Line[] {
  const layer = page.querySelector('.textLayer')
  const canvas = pageCanvas(page)
  if (!layer || !canvas) return []
  const cRect = canvas.getBoundingClientRect()
  const key = `${canvas.width}x${canvas.height}|${cRect.width.toFixed(1)}|${layer.childElementCount}`
  const hit = cache.get(layer)
  if (hit && hit.key === key && hit.canvas === canvas) return hit.lines

  const lines = buildLines(layer, canvas, cRect)
  // Right after a zoom the canvas may still be blank (re-rendering). Then no
  // line lines up with ink; don't cache that, so the next call measures again.
  const multiWord = lines.filter((l) => l.words.length > 1)
  if (multiWord.length === 0 || multiWord.some((l) => l.inkAligned)) cache.set(layer, { key, canvas, lines })
  return lines
}

function buildLines(layer: Element, canvas: HTMLCanvasElement, cRect: DOMRect): Line[] {
  // 1) Text spans with page-local boxes, in reading (DOM) order.
  const spans: SpanInfo[] = []
  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    const node = span.firstChild
    if (!(node instanceof Text) || !node.data.trim()) continue
    const r = span.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    spans.push({
      node,
      left: r.left - cRect.left,
      right: r.right - cRect.left,
      top: r.top - cRect.top,
      bottom: r.bottom - cRect.top
    })
  }

  // 2) Group consecutive spans that sit on the same visual line.
  const groups: SpanInfo[][] = []
  for (const s of spans) {
    const g = groups[groups.length - 1]
    const last = g?.[g.length - 1]
    if (last) {
      const h = Math.min(last.bottom - last.top, s.bottom - s.top)
      const overlap = Math.min(last.bottom, s.bottom) - Math.max(last.top, s.top)
      const gap = s.left - last.right
      if (overlap > h * 0.5 && gap > -h && gap < h * 2) {
        g.push(s)
        continue
      }
    }
    groups.push([s])
  }

  // 3) Words + ink alignment per line.
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  } catch {
    ctx = null
  }
  const k = canvas.width / cRect.width // canvas px per CSS px
  return groups.map((g) => {
    const top = Math.min(...g.map((s) => s.top))
    const bottom = Math.max(...g.map((s) => s.bottom))
    const words = splitWords(g, cRect)
    const inkAligned = ctx ? alignToInk(ctx, k, top, bottom, words) : false
    return { top, bottom, words, inkAligned }
  })
}

/** Text words of a line, with the text layer's (approximate) x extents. */
function splitWords(group: SpanInfo[], cRect: DOMRect): Word[] {
  const words: Word[] = []
  let cur: { from: Caret; to: Caret; text: string } | null = null
  const flush = (): void => {
    if (cur) words.push({ ...cur, x0: 0, x1: 0 })
    cur = null
  }
  group.forEach((s, si) => {
    const prev = group[si - 1]
    // Spans with visible space between them are separate words.
    if (prev && s.left - prev.right > (s.bottom - s.top) * 0.15) flush()
    const data = s.node.data
    for (let i = 0; i < data.length; i++) {
      if (WS.test(data[i])) {
        flush()
        continue
      }
      if (!cur) cur = { from: { node: s.node, offset: i }, to: { node: s.node, offset: i + 1 }, text: '' }
      cur.to = { node: s.node, offset: i + 1 }
      cur.text += data[i]
    }
  })
  flush()

  for (const w of words) {
    const [x0, x1] = estimateX(w.from, w.to, cRect)
    w.x0 = x0
    w.x1 = x1
  }
  return words
}

/** Horizontal extent of a text range according to the text layer. */
export function estimateX(from: Caret, to: Caret, cRect: DOMRect): [number, number] {
  const r = document.createRange()
  r.setStart(from.node, from.offset)
  r.setEnd(to.node, to.offset)
  const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0)
  if (rects.length === 0) return [0, 0]
  return [Math.min(...rects.map((x) => x.left)) - cRect.left, Math.max(...rects.map((x) => x.right)) - cRect.left]
}

/**
 * Moves each word's x0/x1 onto the real ink of the canvas.
 *
 * The text layer tells us roughly where each word boundary is (within about a
 * character). Around each estimated boundary we look for the widest blank gap
 * in the rendered ink: that is the real word space. Word edges then snap to
 * the ink on either side of those gaps. Boundaries without a convincing gap
 * keep the estimate. Returns true if every boundary was found in the ink.
 */
function alignToInk(
  ctx: CanvasRenderingContext2D,
  k: number,
  top: number,
  bottom: number,
  words: Word[]
): boolean {
  const h = bottom - top
  if (words.length === 0 || h <= 0 || h > 60) return false // skip empty and rotated/huge runs
  const left = words[0].x0 - h * 0.6
  const right = words[words.length - 1].x1 + h * 0.6
  // A horizontal band through the letters' bodies; it avoids ascenders and
  // descenders of the neighbouring lines.
  const y0 = Math.round((top + h * 0.3) * k)
  const y1 = Math.round((top + h * 0.9) * k)
  const x0 = Math.max(0, Math.floor(left * k))
  const x1 = Math.min(ctx.canvas.width, Math.ceil(right * k))
  const w = x1 - x0
  const hh = y1 - y0
  if (w <= 0 || hh <= 0) return false

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x0, y0, w, hh).data
  } catch {
    return false
  }
  const inked = new Array<boolean>(w).fill(false)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < hh; y++) {
      const i = (y * w + x) * 4
      if (data[i + 3] > 40 && data[i] + data[i + 1] + data[i + 2] < 600) {
        inked[x] = true
        break
      }
    }
  }

  // Runs of inked columns and the blank gaps between them (canvas px, local).
  const runs: [number, number][] = []
  let start = -1
  for (let x = 0; x <= w; x++) {
    const on = x < w && inked[x]
    if (on && start < 0) start = x
    if (!on && start >= 0) {
      runs.push([start, x])
      start = -1
    }
  }
  if (runs.length === 0) return false
  const gaps = runs.slice(1).map((r, i) => ({ from: runs[i][1], to: r[0], width: r[0] - runs[i][1] }))

  const toLocal = (css: number): number => css * k - x0
  const toCss = (local: number): number => (local + x0) / k
  const reach = h * 0.7 * k // how far the real boundary may be from the estimate
  const minSpace = Math.max(2, h * 0.1 * k) // narrower blanks are letter gaps

  // Outer edges: the ink nearest to the estimated start of the first word and
  // end of the last word.
  const firstRun = runs.find((r) => r[1] > toLocal(words[0].x0) - reach)
  const lastRun = [...runs].reverse().find((r) => r[0] < toLocal(words[words.length - 1].x1) + reach)
  if (firstRun && Math.abs(firstRun[0] - toLocal(words[0].x0)) < reach) words[0].x0 = toCss(firstRun[0])
  if (lastRun && Math.abs(lastRun[1] - toLocal(words[words.length - 1].x1)) < reach) {
    words[words.length - 1].x1 = toCss(lastRun[1])
  }

  // Inner boundaries: the widest gap near each estimated word space.
  let allFound = true
  let minFrom = -Infinity
  for (let b = 0; b < words.length - 1; b++) {
    const est = (toLocal(words[b].x1) + toLocal(words[b + 1].x0)) / 2
    let best: (typeof gaps)[number] | null = null
    for (const g of gaps) {
      if (g.from <= minFrom || g.width < minSpace) continue
      const center = (g.from + g.to) / 2
      if (Math.abs(center - est) > reach) continue
      if (!best || g.width > best.width || (g.width === best.width && Math.abs(center - est) < Math.abs((best.from + best.to) / 2 - est))) {
        best = g
      }
    }
    if (best) {
      words[b].x1 = toCss(best.from)
      words[b + 1].x0 = toCss(best.to)
      minFrom = best.from
    } else {
      allFound = false
    }
  }
  return allFound
}

/** The page under (or nearest to) a viewport y coordinate. */
export function nearestPage(container: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestDist = Infinity
  for (const page of container.querySelectorAll<HTMLElement>('.page')) {
    if (!page.querySelector('.textLayer span')) continue
    const r = page.getBoundingClientRect()
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
    if (d < bestDist) {
      bestDist = d
      best = page
    }
  }
  return best
}

/** True if caret a comes strictly before caret b in document order. */
export function before(a: Caret, b: Caret): boolean {
  const r = document.createRange()
  r.setStart(a.node, a.offset)
  r.collapse(true)
  return r.comparePoint(b.node, b.offset) > 0
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** A selected piece of one text-layer line, before rows are formed. */
interface Piece extends Box {
  canvas: HTMLCanvasElement
}

/**
 * Highlight boxes (viewport coordinates) for a range: one box per visual row,
 * spanning exactly the selected words' ink. Partially selected words (e.g. a
 * trailing comma left out) are trimmed using the text layer's proportions.
 */
export function selectionBoxes(range: Range, container: HTMLElement): Box[] {
  const start: Caret = { node: range.startContainer as Text, offset: range.startOffset }
  const end: Caret = { node: range.endContainer as Text, offset: range.endOffset }
  const pieces: Piece[] = []
  for (const page of container.querySelectorAll<HTMLElement>('.page')) {
    const layer = page.querySelector('.textLayer')
    const canvas = pageCanvas(page)
    if (!layer || !canvas || !range.intersectsNode(layer)) continue
    const c = canvas.getBoundingClientRect()
    for (const line of getLines(page)) {
      const sel = line.words.filter((w) => before(w.from, end) && before(start, w.to))
      if (sel.length === 0) continue
      const first = sel[0]
      const last = sel[sel.length - 1]
      let x0 = first.x0
      let x1 = last.x1
      if (before(first.from, start)) x0 += trimmed(first, first.from, start, c)
      if (before(end, last.to)) x1 -= trimmed(last, end, last.to, c)
      pieces.push({ left: c.left + x0, right: c.left + x1, top: c.top + line.top, bottom: c.top + line.bottom, canvas })
    }
  }
  return toRows(pieces)
}

/**
 * Merges pieces into uniform rows, like a normal text selection.
 *
 * In display math, pdf.js reports big delimiters ([ ( ) ]), superscripts,
 * subscripts and operators as separate runs whose boxes sit higher or lower
 * than the main text (and often not where the glyph really is). The widest
 * piece of each visual row sets the row's band. A piece whose vertical centre
 * lies within half a band height of it belongs to the row. Such "irregular"
 * members are then measured on the canvas, and the row grows to cover their
 * real ink, so brackets and sub/superscripts sit inside the highlight.
 * Normal text lines are ~1.2 rows apart, so neighbouring lines never merge.
 */
function toRows(pieces: Piece[]): Box[] {
  interface Row extends Box {
    band: Box
    members: Piece[]
  }
  const rows: Row[] = []
  const widestFirst = [...pieces].sort((a, b) => b.right - b.left - (a.right - a.left))
  for (const p of widestFirst) {
    const center = (p.top + p.bottom) / 2
    const row = rows.find((r) => {
      const h = r.band.bottom - r.band.top
      const gap = Math.max(p.left - r.right, r.left - p.right)
      return center > r.band.top - h * 0.5 && center < r.band.bottom + h * 0.5 && gap < h * 3
    })
    if (row) {
      row.left = Math.min(row.left, p.left)
      row.right = Math.max(row.right, p.right)
      row.members.push(p)
    } else {
      const band = { left: p.left, right: p.right, top: p.top, bottom: p.bottom }
      rows.push({ ...band, band, members: [p] })
    }
  }

  // Equation numbers etc. far to the right of a row get the row's height.
  for (const r of rows) {
    const h = r.band.bottom - r.band.top
    for (const other of rows) {
      if (other === r || other.members.length !== 1 || other.band.bottom - other.band.top > h * 1.2) continue
      const c = (other.top + other.bottom) / 2
      if (c > r.band.top && c < r.band.bottom && (other.right - other.left) < (r.right - r.left)) {
        other.band = { ...other.band, top: r.band.top, bottom: r.band.bottom }
        other.top = r.band.top
        other.bottom = r.band.bottom
      }
    }
  }

  // Grow rows to the real ink of members that don't line up with the band.
  for (const r of rows) {
    const h = r.band.bottom - r.band.top
    for (const m of r.members) {
      const offBand = Math.abs(m.top - r.band.top) > h * 0.15 || Math.abs(m.bottom - r.band.bottom) > h * 0.15
      if (!offBand) continue
      const ink = inkExtent(m)
      if (!ink) continue
      r.top = Math.max(Math.min(r.top, ink[0]), r.band.top - h)
      r.bottom = Math.min(Math.max(r.bottom, ink[1]), r.band.bottom + h)
    }
  }
  return rows.map(({ left, top, right, bottom }) => ({ left, top, right, bottom })).sort((a, b) => a.top - b.top || a.left - b.left)
}

/**
 * Vertical extent (viewport px) of the glyph cluster drawn in a piece's
 * columns, searching up to one piece-height above and below its box and
 * starting from the ink nearest the box's centre. Small blank gaps (e.g.
 * between "max" and the subscript under it) are bridged; larger ones stop it.
 */
function inkExtent(p: Piece): [number, number] | null {
  const c = p.canvas.getBoundingClientRect()
  const k = p.canvas.width / c.width
  const h = p.bottom - p.top
  const x0 = Math.max(0, Math.floor((p.left - c.left) * k))
  const x1 = Math.min(p.canvas.width, Math.ceil((p.right - c.left) * k))
  const y0 = Math.max(0, Math.floor((p.top - h - c.top) * k))
  const y1 = Math.min(p.canvas.height, Math.ceil((p.bottom + h - c.top) * k))
  const w = x1 - x0
  const hh = y1 - y0
  if (w <= 0 || hh <= 0) return null
  let data: Uint8ClampedArray
  try {
    const ctx = p.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    data = ctx.getImageData(x0, y0, w, hh).data
  } catch {
    return null
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
  // Start from the inked row nearest the piece's centre.
  const mid = Math.round(((p.top + p.bottom) / 2 - c.top) * k) - y0
  let seed = -1
  for (let d = 0; d < hh && seed < 0; d++) {
    if (inked[mid - d]) seed = mid - d
    else if (inked[mid + d]) seed = mid + d
  }
  if (seed < 0) return null
  const maxGap = Math.max(2, h * 0.15 * k)
  let top = seed
  for (let y = seed, gap = 0; y >= 0; y--) {
    if (inked[y]) {
      top = y
      gap = 0
    } else if (++gap > maxGap) break
  }
  let bottom = seed
  for (let y = seed, gap = 0; y < hh; y++) {
    if (inked[y]) {
      bottom = y
      gap = 0
    } else if (++gap > maxGap) break
  }
  return [c.top + (y0 + top) / k, c.top + (y0 + bottom + 1) / k]
}

/** Width of the part [a, b) of a word, scaled to the word's real (ink) width. */
function trimmed(word: Word, a: Caret, b: Caret, c: DOMRect): number {
  const [w0, w1] = estimateX(word.from, word.to, c)
  const [p0, p1] = estimateX(a, b, c)
  if (w1 - w0 <= 0) return 0
  return ((p1 - p0) / (w1 - w0)) * (word.x1 - word.x0)
}

export interface Hit {
  line: Line
  word: Word
  /** Pointer is before the line's first word / after its last word. */
  side: 'before' | 'inside' | 'after'
}

/** The word nearest to a viewport point, preferring words on the same line. */
export function wordAt(container: HTMLElement, x: number, y: number): Hit | null {
  const page = nearestPage(container, y)
  const canvas = page && pageCanvas(page)
  if (!page || !canvas) return null
  const c = canvas.getBoundingClientRect()
  const px = x - c.left
  const py = y - c.top

  let best: Hit | null = null
  let bestScore = Infinity
  for (const line of getLines(page)) {
    if (line.words.length === 0) continue
    const lineLeft = line.words[0].x0
    const lineRight = line.words[line.words.length - 1].x1
    const dy = py < line.top ? line.top - py : py > line.bottom ? py - line.bottom : 0
    const dx = px < lineLeft ? lineLeft - px : px > lineRight ? px - lineRight : 0
    const score = dy * 4 + dx // being on the same line matters most
    if (score >= bestScore) continue
    bestScore = score
    if (px < lineLeft) best = { line, word: line.words[0], side: 'before' }
    else if (px > lineRight) best = { line, word: line.words[line.words.length - 1], side: 'after' }
    else {
      // Word under the pointer, or the closest one when in a gap.
      let w = line.words[0]
      let wd = Infinity
      for (const cand of line.words) {
        const d = px < cand.x0 ? cand.x0 - px : px > cand.x1 ? px - cand.x1 : 0
        if (d < wd) {
          wd = d
          w = cand
        }
      }
      best = { line, word: w, side: 'inside' }
    }
  }
  return best
}
