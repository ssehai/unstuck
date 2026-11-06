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
      items.push({ str: it.str, x, y, h: it.height || Math.abs(a), eol: it.hasEOL })
    }
    out.push(...toParagraphs(n, items))
  }
  labelSections(out)
  return out
}

const REFERENCES_HEADING = /^(references|bibliography|literature cited)\b/i
// "A Additional Experiment Results", "Appendix", "A.1 Proofs", "Supplementary Material"
const APPENDIX_HEADING = /^(appendix|appendices|supplementary|[A-H](\.\d+)*\s+[A-Z][A-Za-z-]+)/

/**
 * Marks paragraphs as body, references, or appendix. References start at the
 * last "References" heading; an appendix starts at the first appendix-style
 * heading after it (or at an "Appendix" heading before it).
 */
function labelSections(paras: Paragraph[]): void {
  // The last "References" heading after the first fifth of the paper (a long
  // appendix can push the references well before the middle).
  const half = Math.floor(paras.length / 2)
  const minRef = Math.floor(paras.length / 5)
  let refStart = -1
  paras.forEach((p, i) => {
    if (i >= minRef && REFERENCES_HEADING.test(p.text.trim()) && p.text.length < 40) refStart = i
  })
  if (refStart < 0) refStart = paras.length
  let appStart = paras.findIndex((p, i) => i > refStart && APPENDIX_HEADING.test(p.text.trim()) && p.text.length < 120)
  if (appStart < 0) {
    // Some papers put the appendix before the references.
    const a = paras.findIndex((p, i) => i >= half && /^(appendix|appendices)\b/i.test(p.text.trim()) && p.text.length < 60)
    appStart = a >= 0 && a < refStart ? a : -1
  }
  paras.forEach((p, i) => {
    if (appStart >= 0 && appStart < refStart) {
      p.section = i >= refStart ? 'references' : i >= appStart ? 'appendix' : 'body'
    } else {
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
