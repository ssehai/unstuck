/**
 * Text helpers for pdf.js text layers: word snapping and text extraction.
 * (Pixel geometry lives in lineModel.ts.)
 */

const WS = /\s/
// Punctuation that hugs a word but isn't part of what the reader means:
// "large," → "large".
const LEADING = /[\s"'“‘]/
const TRAILING = /[\s,.;:!?"'”’]/
// Brackets are only dropped when they have no partner inside the selection:
// "(BRAC" → "BRAC", but "(BRAC)" and "[g(x)]" stay intact (math!).
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const count = (s: string, ch: string): number => s.split(ch).length - 1

function textNodesOfLayers(root: Element): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('.textLayer') && n.parentElement.tagName === 'SPAN'
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** Two adjacent spans belong to the same word if they sit on one line with no visible gap. */
function glued(a: Text, b: Text): boolean {
  const ra = a.parentElement!.getBoundingClientRect()
  const rb = b.parentElement!.getBoundingClientRect()
  const h = Math.min(ra.height, rb.height)
  const sameLine = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > h * 0.5
  return sameLine && rb.left - ra.right < h * 0.15
}

/**
 * Expands a selection so it never cuts a word in half, then drops whitespace
 * and wrapping punctuation at both ends. Returns null if nothing is left.
 */
export function snapToWords(range: Range, root: Element): Range | null {
  const all = textNodesOfLayers(root)
  const nodes = all.filter((n) => range.intersectsNode(n))
  if (nodes.length === 0) return null

  let sNode = nodes[0]
  let sOff = sNode === range.startContainer ? range.startOffset : 0
  let eNode = nodes[nodes.length - 1]
  let eOff = eNode === range.endContainer ? range.endOffset : eNode.length

  /** Move the start forward past characters matching `re`. */
  const trimStart = (re: RegExp): boolean => {
    for (;;) {
      while (sOff < sNode.length && re.test(sNode.data[sOff])) sOff++
      if (sOff < sNode.length) return true
      const i = all.indexOf(sNode)
      if (sNode === eNode || i < 0 || i + 1 >= all.length) return false
      sNode = all[i + 1]
      sOff = 0
    }
  }
  /** Move the end backward past characters matching `re`. */
  const trimEnd = (re: RegExp): boolean => {
    for (;;) {
      while (eOff > 0 && re.test(eNode.data[eOff - 1])) eOff--
      if (eOff > 0) return true
      const i = all.indexOf(eNode)
      if (eNode === sNode || i <= 0) return false
      eNode = all[i - 1]
      eOff = eNode.length
    }
  }

  // 1) Drop whitespace at both ends.
  if (!trimStart(WS) || !trimEnd(WS)) return null

  // 2) Extend the start backwards to the beginning of its word.
  for (;;) {
    while (sOff > 0 && !WS.test(sNode.data[sOff - 1])) sOff--
    if (sOff > 0) break
    const prev = all[all.indexOf(sNode) - 1]
    if (!prev || !prev.length || WS.test(prev.data[prev.length - 1]) || !glued(prev, sNode)) break
    sNode = prev
    sOff = prev.length
  }
  // 3) Extend the end forwards to the end of its word.
  for (;;) {
    while (eOff < eNode.length && !WS.test(eNode.data[eOff])) eOff++
    if (eOff < eNode.length) break
    const next = all[all.indexOf(eNode) + 1]
    if (!next || !next.length || WS.test(next.data[0]) || !glued(eNode, next)) break
    eNode = next
    eOff = 0
  }

  // 4) Drop wrapping punctuation ("large," → "large") and unmatched brackets.
  const selectedText = (): string => {
    const i = all.indexOf(sNode)
    const j = all.indexOf(eNode)
    if (i === j) return sNode.data.slice(sOff, eOff)
    let t = sNode.data.slice(sOff)
    for (let n = i + 1; n < j; n++) t += all[n].data
    return t + eNode.data.slice(0, eOff)
  }
  for (;;) {
    if (!trimStart(LEADING) || !trimEnd(TRAILING)) return null
    const t = selectedText()
    const first = t[0]
    const last = t[t.length - 1]
    let changed = false
    if (first in PAIRS && count(t, first) > count(t, PAIRS[first])) {
      sOff++ // an opener without its closer
      changed = true
    }
    if (last in CLOSERS && count(t, last) > count(t, CLOSERS[last])) {
      eOff-- // a closer without its opener
      changed = true
    }
    if (!changed) break
    if (sNode === eNode && sOff >= eOff) return null
  }

  const snapped = document.createRange()
  snapped.setStart(sNode, sOff)
  snapped.setEnd(eNode, eOff)
  if (snapped.collapsed) return null
  return snapped
}

/**
 * The selected text, with line breaks turned into spaces. Range.toString()
 * ignores the <br>s pdf.js puts between lines, which glues the last word of
 * one line to the first word of the next ("now" + "build" → "nowbuild").
 */
export function rangeText(range: Range, root: Element): string {
  let out = ''
  let prev: Text | null = null
  for (const node of textNodesOfLayers(root)) {
    if (!range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    const piece = node.data.slice(start, end)
    // A line-final hyphen is kept and joined directly ("multi-" + "agent").
    if (prev && !glued(prev, node) && !out.endsWith('-')) out += ' '
    out += piece
    prev = node
  }
  return out.replace(/\s+/g, ' ').trim()
}
