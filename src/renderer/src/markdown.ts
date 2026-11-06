/**
 * A tiny Markdown renderer for LLM answers: headings, bullet lists,
 * paragraphs, **bold**, `code`, LaTeX math ($...$ and $$...$$ via KaTeX), and
 * citation tags like [p.4 ¶2], which become clickable chips.
 *
 * Evidence bullets of the form  - [p.4 ¶2] "exact quote"  are rendered as
 * evidence items; the caller verifies and wires them up.
 */
import katex from 'katex'
import 'katex/dist/katex.min.css'

const CITE = /\[p\.\s?(\d+)(?:\s*¶\s?(\d+))?\]/g
const EVIDENCE = /^\s*[-*]\s*\[p\.\s?(\d+)(?:\s*¶\s?(\d+))?\]\s*["“](.+?)["”]?\s*$/

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function tex(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'html' })
  } catch {
    return escapeHtml(src)
  }
}

function citeChip(page: string, para?: string): string {
  const label = para ? `p.${page} ¶${para}` : `p.${page}`
  return `<button class="cite" data-page="${page}"${para ? ` data-para="${para}"` : ''} title="Jump to ${label}">${label}</button>`
}

/** Inline formatting. Math is cut out first so its characters aren't touched. */
function inline(src: string): string {
  const math: string[] = []
  let s = src.replace(/\$\$([^$]+)\$\$|\$([^$\n]+?)\$/g, (_m, d, i) => {
    math.push(d !== undefined ? tex(d, true) : tex(i, false))
    return `\u0000${math.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(CITE, (_m, p, q) => citeChip(p, q))
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => math[Number(i)])
}

export function renderMarkdown(md: string): string {
  const out: string[] = []
  let list: string[] = []
  let para: string[] = []
  const flushList = (): void => {
    if (list.length) out.push(`<ul>${list.join('')}</ul>`)
    list = []
  }
  const flushPara = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }

  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Display math block spanning lines: $$ ... $$
    if (line.trim().startsWith('$$') && !line.trim().slice(2).includes('$$')) {
      flushPara()
      flushList()
      const body: string[] = [line.trim().slice(2)]
      while (++i < lines.length && !lines[i].includes('$$')) body.push(lines[i])
      if (i < lines.length) body.push(lines[i].slice(0, lines[i].indexOf('$$')))
      out.push(`<div class="math-block">${tex(body.join('\n'), true)}</div>`)
      continue
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      flushList()
      out.push(`<h4>${inline(h[1])}</h4>`)
      continue
    }
    const ev = EVIDENCE.exec(line)
    if (ev) {
      flushPara()
      const [, page, paraNo, quote] = ev
      list.push(
        `<li class="evidence" data-page="${page}"${paraNo ? ` data-para="${paraNo}"` : ''} data-quote="${escapeHtml(quote)}">` +
          `<span class="ev-status" title="Checking…">…</span>${citeChip(page, paraNo)}` +
          `<span class="ev-quote">“${inline(quote)}”</span></li>`
      )
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      list.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return out.join('')
}
