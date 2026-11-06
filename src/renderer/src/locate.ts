/**
 * Jump to a citation: scroll to its page, find the quoted text in that page's
 * text layer, and flash a highlight over it.
 */
import { selectionBoxes } from './lineModel'
import { normalizeForMatch } from './paperText'
import type { Reader } from './reader'

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

  const boxes = selectionBoxes(range, container)
  if (boxes.length === 0) return false
  // Scroll the quote into the middle of the view, then flash it.
  const c = container.getBoundingClientRect()
  container.scrollTop += boxes[0].top - c.top - c.height / 3
  flash(container, selectionBoxes(range, container))
  return true
}

function flash(container: HTMLElement, boxes: { left: number; top: number; right: number; bottom: number }[]): void {
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
