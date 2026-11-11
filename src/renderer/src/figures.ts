/**
 * Figures and tables of a paper, found once when the paper is first opened
 * and saved in the library with their captions, so one can be clicked and
 * asked about like a text selection.
 *
 * Papers draw most figures as vector graphics (hundreds of lines and glyphs,
 * with nothing marking "this is Figure 3"), so a figure is found from what is
 * drawn rather than from an embedded image:
 *
 *  1. Ink: the page is rendered once at low resolution and every text line
 *     set at body size or larger (paragraphs, headings, captions, "(a) SMAC"
 *     sub-figure labels) is erased. What is left is graphics plus the small
 *     text inside plots, grouped into blobs of nearby ink.
 *  2. Captions: lines that start with "Figure 3:", "Fig. 3.", "Table 2 |",
 *     "FIGURE S1 —", "그림 3." … (the label, then a separator).
 *  3. Pairing: each caption claims the blobs next to it. Figures look above
 *     the caption first, tables below; failing that the other way, then the
 *     side (a caption beside its figure). Blobs keep being claimed outwards,
 *     row after row of sub-plots, until a paragraph line or another caption
 *     is in the way.
 *  4. The figure's region is the box around its claimed blobs.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PaperFigure {
  /** "Figure 3", "Table 2" */
  label: string
  page: number
  /** Region as fractions (0–1) of the page, like CaptureRegion. */
  x: number
  y: number
  width: number
  height: number
  /** Full caption text, starting with the label. */
  caption: string
  /** Sub-figures "(a)", "(b)" … with their own regions, when the figure has them. */
  parts?: PaperFigure[]
}

/** Bump when detection changes, so saved figures are found again. */
export const FIGURES_VERSION = 8

/**
 * A caption's first line: a kind, a number ("3", "S1", "A.2", "3a", "IV"),
 * then a separator, or nothing more on the line (the text continues below).
 * In running text these words don't start a line followed by a separator.
 */
const CAPTION =
  /^\s*(Figure|FIGURE|Fig\.?|FIG\.?|Table|TABLE|Tab\.|그림|표)\s*((?:[A-Z]\.?|S)?\d+(?:\.\d+)*[a-z]?|[IVX]{1,5})\s*(?:[:.|—–-]\s*|$)/

/** "Figure 3", "Table S1" … from a caption line. */
function captionLabel(text: string): { label: string; table: boolean } {
  const m = text.match(CAPTION)!
  const k = m[1].toLowerCase()
  const kind = k.startsWith('fig') ? 'Figure' : k.startsWith('tab') ? 'Table' : m[1]
  return { label: `${kind} ${m[2]}`, table: kind === 'Table' || kind === '표' }
}

/** "(a) SMAC": a sub-figure label; it belongs to the caption, not the figure's image. */
const SUBCAPTION = /^\(([a-z]|[ivx]{1,4}|\d{1,2})\)(\s|$)/i

const FUNCTION_WORDS = /\b(the|of|and|to|in|is|are|we|for|that|with|on|as|by|this|be|it|from|an|or|which|our|이|그|및|의)\b/i

/** Grid cell size for blobs, in PDF points. */
const CELL = 2
/** Ink this close (points) belongs to one blob. */
const JOIN = 6
/** Blobs this far apart (points) can still be claimed by the same caption, unless prose is in between. */
const REACH = 60
/** Points from the page edges where content can be. */
const MARGIN = 8

interface Line {
  text: string
  x0: number
  x1: number
  top: number
  bottom: number
  /** Font size. */
  h: number
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Text lines of a page, in PDF points with y growing downwards. */
async function pageLines(page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, pageHeight: number): Promise<Line[]> {
  const content = await page.getTextContent()
  const items: { str: string; x: number; y: number; w: number; h: number }[] = []
  for (const it of content.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const [a, b, c, d, e, f] = it.transform as number[]
    // Rotated text (a sideways table, a y-axis label) is left as graphics.
    if (Math.abs(b) > Math.abs(a) * 0.2) continue
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
  // Text at one baseline can belong to two columns or table cells; split at wide gaps.
  const out: Line[] = []
  for (const l of lines) {
    const parts = l.parts.sort((a, b) => a.x - b.x)
    let run: typeof parts = []
    const flush = (): void => {
      if (!run.length) return
      const h = Math.max(...run.map((p) => p.h))
      out.push({
        text: run.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim(),
        x0: run[0].x,
        x1: Math.max(...run.map((p) => p.x + p.w)),
        top: l.y - h * 0.85,
        bottom: l.y + h * 0.25,
        h
      })
      run = []
    }
    for (const p of parts) {
      const prev = run[run.length - 1]
      // A caption starts its own line even when a figure label shares its baseline.
      if (prev && (p.x - (prev.x + prev.w) > l.h * 2.5 || CAPTION.test(p.str) || SUBCAPTION.test(p.str))) flush()
      run.push(p)
    }
    flush()
  }
  return out.sort((a, b) => a.top - b.top || a.x0 - b.x0)
}

const overlapX = (a: Rect, x0: number, x1: number): number => Math.min(a.x1, x1) - Math.max(a.x0, x0)
const overlapY = (a: Rect, y0: number, y1: number): number => Math.min(a.y1, y1) - Math.max(a.y0, y0)

/** Finds the figures and tables of a paper. Each page with a caption is rendered once at low resolution. */
export async function extractFigures(doc: PDFDocumentProxy, onSkip?: (label: string, page: number, why: string) => void): Promise<PaperFigure[]> {
  // Body font size: the most common size of long lines across the paper (a
  // page that is mostly a table would mislead a per-page estimate).
  const pages: Line[][] = []
  const sizes: number[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const lines = await pageLines(page, vp.height)
    pages.push(lines)
    for (const l of lines) if (l.x1 - l.x0 > vp.width * 0.25) sizes.push(Math.round(l.h * 2) / 2)
  }
  const count = (v: number): number => sizes.filter((s) => s === v).length
  const bodySize = [...new Set(sizes)].sort((a, b) => count(b) - count(a))[0] ?? 10

  // Tables put their caption either above or below, consistently within a
  // paper. Where both sides of a table caption hold rows (two tables stacked
  // on a page), the paper's own convention decides; it is learned in a first
  // pass from the tables where only one side does.
  const inks = new Map<number, Uint8Array | null>()
  const first = await scan(null)
  const tally = first.tally
  if (!first.ambiguous || tally.up === tally.down) return first.figures
  return (await scan(tally.up > tally.down ? 'up' : 'down')).figures

  async function scan(prefer: 'up' | 'down' | null): Promise<{ figures: PaperFigure[]; tally: { up: number; down: number }; ambiguous: boolean }> {
  const figures: PaperFigure[] = []
  const seen = new Set<string>()
  const tally = { up: 0, down: 0 }
  let ambiguous = false
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const lines = pages[n - 1]
    const capLines = lines.filter((l) => CAPTION.test(l.text))
    if (capLines.length === 0) continue

    // Text area and body font size, from lines long enough to be body text.
    const long = lines.filter((l) => l.x1 - l.x0 > vp.width * 0.25)
    if (long.length === 0) continue
    const left = Math.min(...long.map((l) => l.x0))
    const right = Math.max(...long.map((l) => l.x1))
    const mid = (left + right) / 2
    // Text at body size or larger is prose (or a heading, caption, sub-figure
    // label), never a figure's own graphics; plot labels are smaller.
    const isProseSize = (l: Line): boolean => (l.h >= bodySize * 0.92 && l.text.length >= 2) || SUBCAPTION.test(l.text)
    // A paragraph line, which a figure never extends across.
    const isParagraph = (l: Line, colW: number): boolean =>
      l.h >= bodySize * 0.92 &&
      l.x1 - l.x0 > colW * 0.6 &&
      l.text.length >= colW / 7 &&
      !CAPTION.test(l.text) &&
      (l.text.match(/\d/g)?.length ?? 0) < l.text.length * 0.3 &&
      // Prose is mostly lowercase; a table's header row ("Map MAPPO(FP) IPPO QMix") is not.
      (l.text.match(/[a-z]/g)?.length ?? 0) > (l.text.match(/[A-Za-z]/g)?.length ?? 0) * 0.6 &&
      // …and reads as sentences: a table header row has no function words.
      FUNCTION_WORDS.test(l.text)

    // --- 1. Ink blobs, with prose erased ---------------------------------------
    const gw = Math.ceil(vp.width / CELL)
    const gh = Math.ceil(vp.height / CELL)
    if (!inks.has(n)) inks.set(n, await inkGrid(page, gw, gh))
    const cached = inks.get(n)
    if (!cached) continue
    const ink = cached.slice()
    for (const l of lines) {
      if (!isProseSize(l)) continue
      const pad = l.h * 0.15
      const cx0 = Math.max(0, Math.floor((l.x0 - pad) / CELL))
      const cx1 = Math.min(gw - 1, Math.ceil((l.x1 + pad) / CELL))
      for (let y = Math.max(0, Math.floor((l.top - pad) / CELL)); y <= Math.min(gh - 1, Math.ceil((l.bottom + pad) / CELL)); y++) {
        ink.fill(0, y * gw + cx0, y * gw + cx1 + 1)
      }
    }
    const blobs = findBlobs(ink, gw, gh, Math.round(JOIN / CELL))
      .map((b) => ({ x0: b.x0 * CELL, y0: b.y0 * CELL, x1: (b.x1 + 1) * CELL, y1: (b.y1 + 1) * CELL }))
      .filter((b) => b.x0 > MARGIN - CELL && b.x1 < vp.width - MARGIN + CELL)
      // Specks (dots, short marks) don't make a figure on their own; long rules (tables) do.
      .filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) > 60 || b.x1 - b.x0 > 40)

    // --- 2. Captions: the label line plus the lines of its block -----------------
    const captions = capLines.map((cap) => {
      const block = [cap]
      for (const l of lines) {
        const last = block[block.length - 1]
        if (l.top <= last.top || block.includes(l)) continue
        const gap = l.top - last.bottom
        // Continuation lines sit under the first one (not in a neighbouring caption or column).
        const overlaps = Math.min(l.x1, cap.x1 + 5) - Math.max(l.x0, cap.x0 - 5) > (l.x1 - l.x0) * 0.7
        // …in the caption's font, and not split into cells like a table row right below it.
        const sameFont = Math.abs(l.h - cap.h) < 0.6
        const cells = lines.some((o) => o !== l && Math.abs(o.top - l.top) < 1)
        // Line spacing, not the larger gap before the next paragraph.
        if (overlaps && sameFont && !cells && gap < cap.h * 0.45 && !CAPTION.test(l.text)) block.push(l)
        else if (overlaps && gap >= 0) break
      }
      const box: Rect = {
        x0: Math.min(...block.map((l) => l.x0)),
        y0: cap.top,
        x1: Math.max(...block.map((l) => l.x1)),
        y1: Math.max(...block.map((l) => l.bottom))
      }
      return { block, box, ...captionLabel(cap.text) }
    })

    // --- 3. Pairing ---------------------------------------------------------------
    const claimed = new Set<number>()
    for (const c of captions) {
      if (seen.has(c.label)) {
        onSkip?.(c.label, n, 'duplicate')
        continue
      }
      const wide = c.box.x1 - c.box.x0 > (right - left) * 0.55 || (c.box.x0 < mid - 20 && c.box.x1 > mid + 20)
      const col = { x0: wide || c.box.x0 < mid ? MARGIN : mid, x1: wide || c.box.x0 >= mid ? vp.width - MARGIN : mid }
      const colW = wide ? right - left : (right - left) / 2
      // Prose and other captions: a figure never reaches across them.
      const walls: Rect[] = [
        ...lines.filter((l) => isParagraph(l, colW)).map((l) => ({ x0: l.x0, y0: l.top, x1: l.x1, y1: l.bottom })),
        ...captions.filter((o) => o !== c).map((o) => o.box)
      ].filter((w) => overlapX(w, col.x0, col.x1) > colW * 0.3)
      const blocked = (y0: number, y1: number): boolean => walls.some((w) => w.y0 < y1 && w.y1 > y0)
      const free = (i: number): boolean => !claimed.has(i) && overlapX(blobs[i], col.x0, col.x1) >= Math.min(blobs[i].x1 - blobs[i].x0, 10)

      /** Claims blobs outwards from the caption, up or down, while they keep coming. */
      const grow = (dir: 'up' | 'down'): number[] => {
        const got: number[] = []
        let edge = dir === 'up' ? c.box.y0 : c.box.y1
        for (;;) {
          let best = -1
          let bestGap = Infinity
          blobs.forEach((b, i) => {
            if (!free(i) || got.includes(i)) return
            const gap = dir === 'up' ? edge - b.y1 : b.y0 - edge
            if (gap < -4 || gap > REACH || gap >= bestGap) return
            if (dir === 'up' ? blocked(b.y1, edge) : blocked(edge, b.y0)) return
            best = i
            bestGap = gap
          })
          if (best < 0) break
          got.push(best)
          // Blobs level with the new one (a row of sub-plots) join too.
          const row = blobs[best]
          blobs.forEach((b, i) => {
            if (free(i) && !got.includes(i) && overlapY(b, row.y0, row.y1) > 0) got.push(i)
          })
          edge = dir === 'up' ? Math.min(...got.map((i) => blobs[i].y0)) : Math.max(...got.map((i) => blobs[i].y1))
        }
        return got
      }
      /** A caption beside its figure: blobs level with the caption, left or right of it. */
      const side = (): number[] =>
        blobs.flatMap((b, i) => {
          if (claimed.has(i) || overlapY(b, c.box.y0, c.box.y1) < Math.min(b.y1 - b.y0, c.box.y1 - c.box.y0) * 0.3) return []
          const gap = b.x1 <= c.box.x0 ? c.box.x0 - b.x1 : b.x0 >= c.box.x1 ? b.x0 - c.box.x1 : -1
          return gap >= 0 && gap < 30 ? [i] : []
        })

      /**
       * A table is mostly text (erased with the prose) and a few rules: take
       * the lines next to its caption, above or below, until a paragraph,
       * another caption or a wide gap, plus the rules among them.
       */
      const tableRows = (dir: 'up' | 'down'): { r: Rect; lines: number } | null => {
        let r: Rect | null = null
        let count = 0
        let edge = dir === 'down' ? c.box.y1 : c.box.y0
        const seq = lines.filter((l) => (dir === 'down' ? l.top >= c.box.y1 - 1 : l.bottom <= c.box.y0 + 1) && !c.block.includes(l))
        if (dir === 'up') seq.reverse()
        for (const l of seq) {
          if (overlapX({ x0: l.x0, y0: 0, x1: l.x1, y1: 0 }, col.x0, col.x1) <= 0) continue
          const gap = dir === 'down' ? l.top - edge : edge - l.bottom
          if (gap > bodySize * 2.2 || isParagraph(l, colW) || CAPTION.test(l.text)) break
          r = r ? { x0: Math.min(r.x0, l.x0), y0: Math.min(r.y0, l.top), x1: Math.max(r.x1, l.x1), y1: Math.max(r.y1, l.bottom) } : { x0: l.x0, y0: l.top, x1: l.x1, y1: l.bottom }
          edge = dir === 'down' ? Math.max(edge, l.bottom) : Math.min(edge, l.top)
          count++
        }
        return r && count >= 2 ? { r, lines: count } : null
      }
      const tableBox = (): Rect | null => {
        const down = tableRows('down')
        const up = tableRows('up')
        if (down && !up) tally.down++
        if (up && !down) tally.up++
        if (down && up) ambiguous = true
        const pick = down && up ? (prefer ? (prefer === 'down' ? down : up) : down.lines >= up.lines ? down : up) : (down ?? up)
        if (!pick) return null
        const t = pick.r
        // Rules just around and among the rows.
        blobs.forEach((b, i) => {
          if (!free(i) || b.y1 < t.y0 - 8 || b.y0 > t.y1 + 8 || overlapX(b, t.x0 - 30, t.x1 + 30) <= 0) return
          if (b.y1 - b.y0 > 6 && (b.y0 < t.y0 - 8 || b.y1 > t.y1 + 8)) return // not a rule
          t.x0 = Math.min(t.x0, b.x0)
          t.x1 = Math.max(t.x1, b.x1)
          t.y0 = Math.min(t.y0, b.y0)
          t.y1 = Math.max(t.y1, b.y1)
          claimed.add(i)
        })
        return t
      }

      const boxOf = (got: number[]): Rect | null =>
        got.length
          ? {
              x0: Math.min(...got.map((i) => blobs[i].x0)),
              y0: Math.min(...got.map((i) => blobs[i].y0)),
              x1: Math.max(...got.map((i) => blobs[i].x1)),
              y1: Math.max(...got.map((i) => blobs[i].y1))
            }
          : null
      let got: number[] = []
      let r: Rect | null = null
      if (c.table) r = tableBox()
      if (!r) {
        const order = c.table ? [() => grow('up'), side] : [() => grow('up'), side, () => grow('down')]
        for (const f of order) {
          got = f()
          if (got.length) break
        }
        r = boxOf(got)
      }
      if (!r) {
        onSkip?.(c.label, n, 'nothing next to the caption')
        continue
      }
      if (r.x1 - r.x0 < 30 || r.y1 - r.y0 < 15) {
        onSkip?.(c.label, n, 'too small')
        continue
      }
      got.forEach((i) => claimed.add(i))
      seen.add(c.label)
      const caption = c.block.map((l) => l.text).join(' ').replace(/-\s(?=[a-z])/g, '')
      const toFigure = (label: string, b: Rect, text: string): PaperFigure => {
        const pad = 2
        const x0 = Math.max(0, b.x0 - pad)
        const y0 = Math.max(0, b.y0 - pad)
        return {
          label,
          page: n,
          x: x0 / vp.width,
          y: y0 / vp.height,
          width: (Math.min(vp.width, b.x1 + pad) - x0) / vp.width,
          height: (Math.min(vp.height, b.y1 + pad) - y0) / vp.height,
          caption: text
        }
      }
      const fig = toFigure(c.label, r, caption)

      // Sub-figures: each "(a) …" label below the figure's blobs owns the
      // blobs right above it (the nearest row of labels, the closest label
      // horizontally), so "(a)" can be asked about on its own.
      if (!c.table && got.length > 1) {
        const area = r
        const subs = lines.filter(
          (l) => SUBCAPTION.test(l.text) && l.top >= area.y0 - 2 && l.bottom <= c.box.y0 + 1 && overlapX({ x0: l.x0, y0: 0, x1: l.x1, y1: 0 }, area.x0, area.x1) > 0
        )
        if (subs.length >= 2) {
          const owner = new Map<Line, number[]>()
          for (const i of got) {
            const b = blobs[i]
            const below = subs.filter((l) => l.top >= b.y1 - 6)
            if (below.length === 0) continue
            const rowTop = Math.min(...below.map((l) => l.top))
            const row = below.filter((l) => l.top - rowTop < 6)
            const cx = (b.x0 + b.x1) / 2
            const best = row.reduce((a, l) => (Math.abs((l.x0 + l.x1) / 2 - cx) < Math.abs((a.x0 + a.x1) / 2 - cx) ? l : a))
            owner.set(best, [...(owner.get(best) ?? []), i])
          }
          const parts = subs
            .filter((l) => owner.has(l))
            .map((l) => {
              const box = boxOf(owner.get(l)!)!
              const letter = l.text.match(SUBCAPTION)![1]
              return toFigure(`${c.label}(${letter})`, box, `${l.text} — part of ${caption}`)
            })
            .filter((p) => p.width * vp.width > 20 && p.height * vp.height > 15)
          if (parts.length >= 2) fig.parts = parts
        }
      }
      figures.push(fig)
    }
  }
  return { figures, tally, ambiguous }
  }
}

/** Renders a page into a grid of CELL-point cells: 1 where anything is drawn. */
async function inkGrid(page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, gw: number, gh: number): Promise<Uint8Array | null> {
  const vp = page.getViewport({ scale: 1 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const grid = new Uint8Array(gw * gh)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) grid[Math.floor(y / CELL) * gw + Math.floor(x / CELL)] = 1
    }
  }
  return grid
}

/** Connected groups of ink cells; cells up to `join` apart are connected. Returns boxes in cells. */
function findBlobs(grid: Uint8Array, gw: number, gh: number, join: number): Rect[] {
  const seen = new Uint8Array(gw * gh)
  const out: Rect[] = []
  const stack: number[] = []
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue
    const box = { x0: gw, y0: gh, x1: -1, y1: -1 }
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()!
      const px = p % gw
      const py = (p - px) / gw
      if (px < box.x0) box.x0 = px
      if (px > box.x1) box.x1 = px
      if (py < box.y0) box.y0 = py
      if (py > box.y1) box.y1 = py
      for (let y = Math.max(0, py - join); y <= Math.min(gh - 1, py + join); y++) {
        for (let x = Math.max(0, px - join); x <= Math.min(gw - 1, px + join); x++) {
          const q = y * gw + x
          if (grid[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }
    out.push(box)
  }
  return out
}
