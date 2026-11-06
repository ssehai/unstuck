/**
 * The whole paper as text, split into numbered paragraphs:
 *
 *   [p.4 ¶2] Encouraging the learned policy to be close to ...
 *
 * These labels are what the LLM cites as evidence, and what the app uses to
 * check citations and jump to them.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface Paragraph {
  page: number
  index: number // 1-based within the page
  text: string
}

interface Item {
  str: string
  x: number
  y: number
  h: number
  eol: boolean
}

const cache = new WeakMap<PDFDocumentProxy, Promise<Paragraph[]>>()

export function paperParagraphs(doc: PDFDocumentProxy): Promise<Paragraph[]> {
  let p = cache.get(doc)
  if (!p) {
    p = extract(doc)
    cache.set(doc, p)
  }
  return p
}

async function extract(doc: PDFDocumentProxy): Promise<Paragraph[]> {
  const out: Paragraph[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const items: Item[] = []
    for (const it of content.items) {
      if (!('str' in it)) continue
      const [a, b, , , x, y] = it.transform as number[]
      if (Math.abs(b) > Math.abs(a) * 0.1) continue // rotated text, e.g. the arXiv side stamp
      items.push({ str: it.str, x, y, h: it.height || Math.abs(a), eol: it.hasEOL })
    }
    out.push(...toParagraphs(n, items))
  }
  return out
}

function toParagraphs(page: number, items: Item[]): Paragraph[] {
  // 1) Lines.
  const lines: { text: string; y: number; h: number }[] = []
  let cur: { text: string; y: number; h: number } | null = null
  for (const it of items) {
    const sameLine = cur && Math.abs(it.y - cur.y) < Math.max(it.h, cur.h) * 0.5
    if (!cur || !sameLine) {
      if (cur && cur.text.trim()) lines.push(cur)
      cur = { text: it.str, y: it.y, h: it.h }
    } else {
      cur.text += it.str
      cur.h = Math.max(cur.h, it.h)
    }
    if (it.eol) {
      if (cur.text.trim()) lines.push(cur)
      cur = null
    }
  }
  if (cur && cur.text.trim()) lines.push(cur)
  if (lines.length === 0) return []

  // 2) Paragraphs: a vertical gap clearly larger than the usual line spacing.
  const gaps = lines.slice(1).map((l, i) => Math.abs(lines[i].y - l.y)).filter((g) => g > 0)
  const sorted = [...gaps].sort((a, b) => a - b)
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12
  const paras: string[] = []
  let text = ''
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    const gap = prev ? Math.abs(prev.y - l.y) : 0
    if (prev && (gap > typical * 1.45 || l.y > prev.y + typical * 0.5)) {
      paras.push(text)
      text = ''
    }
    const s = l.text.replace(/\s+/g, ' ').trim()
    text = text ? (text.endsWith('-') ? text + s : `${text} ${s}`) : s
  })
  paras.push(text)
  return paras.filter((t) => t.trim()).map((t, i) => ({ page, index: i + 1, text: t }))
}

/** The paper formatted for the prompt, limited to `maxChars` (pages near `focusPage` first). */
export function formatPaper(paras: Paragraph[], focusPage: number, maxChars = 150_000): string {
  const byPage = new Map<number, Paragraph[]>()
  for (const p of paras) byPage.set(p.page, [...(byPage.get(p.page) ?? []), p])
  const pages = [...byPage.keys()]
  const pageText = (n: number): string => byPage.get(n)!.map((p) => `[p.${p.page} ¶${p.index}] ${p.text}`).join('\n')

  const total = pages.reduce((s, n) => s + pageText(n).length, 0)
  let keep = new Set(pages)
  if (total > maxChars) {
    keep = new Set()
    let used = 0
    for (const n of [...pages].sort((a, b) => Math.abs(a - focusPage) - Math.abs(b - focusPage))) {
      const len = pageText(n).length
      if (used + len > maxChars) continue
      keep.add(n)
      used += len
    }
  }
  return pages
    .map((n) => (keep.has(n) ? pageText(n) : `[p.${n}] (omitted for length)`))
    .join('\n\n')
}

/** Lowercased, without spaces/hyphens/quotes: robust to PDF extraction quirks. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-‐‑–—'"“”‘’`´]/g, '')
}

export interface CitationCheck {
  found: boolean
  /** Page where the quote was actually found (may differ from the cited one). */
  page?: number
  paragraph?: number
}

/** Does the quoted text really appear in the paper? Prefers the cited page. */
export function checkQuote(paras: Paragraph[], quote: string, citedPage?: number): CitationCheck {
  const q = normalizeForMatch(quote)
  if (q.length < 8) return { found: false }
  const ordered = citedPage ? [...paras].sort((a, b) => Number(b.page === citedPage) - Number(a.page === citedPage)) : paras
  for (const p of ordered) {
    if (normalizeForMatch(p.text).includes(q)) return { found: true, page: p.page, paragraph: p.index }
  }
  // Quotes can straddle a paragraph break: try page-level text.
  const pages = new Map<number, string>()
  for (const p of paras) pages.set(p.page, (pages.get(p.page) ?? '') + normalizeForMatch(p.text))
  for (const [page, t] of pages) if (t.includes(q)) return { found: true, page }
  return { found: false }
}
