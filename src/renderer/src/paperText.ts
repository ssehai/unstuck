/**
 * The whole paper as text, split into numbered paragraphs:
 *
 *   [p.4 ¶2] Encouraging the learned policy to be close to ...
 *
 * These labels are what the LLM cites as evidence, and what the app uses to
 * check citations and jump to them.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export type Section = 'body' | 'references' | 'appendix'

export interface Paragraph {
  page: number
  index: number // 1-based within the page
  text: string
  section: Section
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
      items.push({ str: markLostGlyphs(it.str), x, y, h: it.height || Math.abs(a), eol: it.hasEOL })
    }
    out.push(...toParagraphs(n, items))
  }
  labelSections(out)
  return out
}

const REFERENCES_HEADING = /^(references|bibliography|literature cited)\b/i
// "Appendix", "Supplementary Material", or the first lettered section: "A MAPPO Details", "A.1 Proofs"
const APPENDIX_HEADING = /^(appendix|appendices|supplementary\b|A(\.1)?\s+[A-Z][A-Za-z-]+)/
/** Looks like an entry of a reference list. */
const REFERENCE_ENTRY = /^\[\d+\]|\b(19|20)\d{2}[a-z]?\b.*\b(arXiv|Proceedings|Conference|Journal|Transactions|pp\.|In )|et al\./

/**
 * Marks paragraphs as body, references, or appendix.
 *
 * - References start at the last "References" heading (after the first fifth
 *   of the paper: a long appendix can push them well before the middle).
 * - The appendix starts at the first appendix heading ("Appendix", or a
 *   lettered section "A …") in the later part of the paper. It may come
 *   before or after the references.
 * - After the references, paragraphs that are not reference entries (figure
 *   captions, tables) belong to the appendix when there is one; papers often
 *   float appendix figures and tables past the reference list.
 */
function labelSections(paras: Paragraph[]): void {
  const n = paras.length
  let refStart = -1
  paras.forEach((p, i) => {
    if (i >= n / 5 && REFERENCES_HEADING.test(p.text.trim()) && p.text.length < 40) refStart = i
  })
  if (refStart < 0) refStart = n
  const appStart = paras.findIndex((p, i) => i >= n * 0.3 && i !== refStart && p.text.length < 80 && APPENDIX_HEADING.test(p.text.trim()))

  paras.forEach((p, i) => {
    if (appStart >= 0 && appStart < refStart) {
      // body … appendix … references (+ floated appendix material)
      if (i < appStart) p.section = 'body'
      else if (i < refStart) p.section = 'appendix'
      else p.section = i === refStart || REFERENCE_ENTRY.test(p.text) || p.text.length > 600 ? 'references' : 'appendix'
    } else {
      // body … references … appendix
      p.section = appStart >= 0 && i >= appStart ? 'appendix' : i >= refStart ? 'references' : 'body'
    }
  })
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
  return paras.filter((t) => t.trim()).map((t, i) => ({ page, index: i + 1, text: t, section: 'body' as Section }))
}

/**
 * Should the appendix be sent? Only when the passage is in it, or the passage
 * (or its paragraph) points to it. Saves a lot: appendices can be half a paper.
 */
export function needsAppendix(paras: Paragraph[], page: number, ...texts: string[]): boolean {
  const appendixPages = new Set(paras.filter((p) => p.section === 'appendix').map((p) => p.page))
  if (appendixPages.size === 0) return false
  if (appendixPages.has(page) && !paras.some((p) => p.page === page && p.section === 'body')) return true
  if (paras.some((p) => p.page === page && p.section === 'appendix' && texts.some((t) => normalizeForMatch(p.text).includes(normalizeForMatch(t).slice(0, 40))))) return true
  return texts.some((t) => /\b(appendix|appendices|supplementary)\b/i.test(t))
}

/**
 * The paper formatted for the prompt. References are always left out (they
 * rarely help explain a passage); the appendix only when asked for. The output
 * depends only on the paper and that flag, never on which passage was
 * selected, so the prompt prefix stays identical and the model's prompt cache
 * keeps hitting across selections.
 */
export function formatPaper(paras: Paragraph[], opts: { appendix: boolean }, maxChars = 120_000): string {
  const lines: string[] = []
  let used = 0
  let truncatedAt: number | null = null
  let refsOmitted = false
  const appendixPages = new Set<number>()
  for (const p of paras) {
    if (p.section === 'references') {
      refsOmitted = true
      continue
    }
    if (p.section === 'appendix' && !opts.appendix) {
      appendixPages.add(p.page)
      continue
    }
    const line = `[p.${p.page} ¶${p.index}] ${p.text}`
    if (used + line.length > maxChars) {
      truncatedAt ??= p.page
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  if (refsOmitted) lines.push('[References omitted.]')
  if (appendixPages.size) {
    const pages = [...appendixPages]
    lines.push(`[Appendix (pp.${Math.min(...pages)}–${Math.max(...pages)}) omitted. If the answer needs it, say so.]`)
  }
  if (truncatedAt !== null) lines.push(`[Text from p.${truncatedAt} on omitted for length.]`)
  return lines.join('\n')
}

/** Is this paragraph part of what formatPaper sends? */
export function isSent(p: Paragraph, opts: { appendix: boolean }): boolean {
  return p.section === 'body' || (p.section === 'appendix' && opts.appendix)
}

/** Lowercased, without spaces/hyphens/quotes: robust to PDF extraction quirks. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-‐‑–—'"“”‘’`´]/g, '')
}

/**
 * Some PDFs map math glyphs (ε, φ, …) to control characters in their text
 * (a broken font ToUnicode table): "For small \u000f, agents…". Those are
 * shown to the model as "□" so it knows a symbol is missing there.
 */
export const LOST_GLYPH = '□'
export function markLostGlyphs(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, LOST_GLYPH)
}

/**
 * A looser key for matching quotes: ASCII letters and digits only. Quotes that
 * differ from the paper only in symbols (ε vs □ vs nothing, quotes, dashes,
 * math signs) still match. Used only as a fallback, on long enough quotes.
 */
export function looseKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')
}
const LOOSE_MIN = 16

export interface CitationCheck {
  found: boolean
  /** Page where the quote was actually found (may differ from the cited one). */
  page?: number
  paragraph?: number
}

/** Does the quoted text really appear in the paper? Prefers the cited page. */
export function checkQuote(paras: Paragraph[], quote: string, citedPage?: number): CitationCheck {
  const ordered = citedPage ? [...paras].sort((a, b) => Number(b.page === citedPage) - Number(a.page === citedPage)) : paras
  const search = (key: (s: string) => string, minLen: number): CitationCheck | null => {
    const q = key(quote)
    if (q.length < minLen) return null
    for (const p of ordered) {
      if (key(p.text).includes(q)) return { found: true, page: p.page, paragraph: p.index }
    }
    // Quotes can straddle a paragraph break: try page-level text.
    const pages = new Map<number, string>()
    for (const p of paras) pages.set(p.page, (pages.get(p.page) ?? '') + key(p.text))
    for (const [page, t] of pages) if (t.includes(q)) return { found: true, page }
    return null
  }
  // Exact (modulo spaces/quotes/dashes) first; then ignoring symbols.
  return search(normalizeForMatch, 8) ?? search(looseKey, LOOSE_MIN) ?? { found: false }
}
