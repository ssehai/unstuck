/**
 * Custom mouse selection for pdf.js pages.
 *
 * Native selection only starts when the mouse goes down exactly on a glyph's
 * invisible <span>, and its character positions come from a fallback font.
 * We handle the drag ourselves instead: every pointer position is mapped to
 * the nearest *word* using the page's line model (see lineModel.ts), so a
 * drag can start in the margin and always covers whole words.
 */
import { before, wordAt, type Caret, type Hit } from './lineModel'

export interface DragHandlers {
  /** Elements where a mousedown should keep its normal behaviour. */
  isIgnored: (target: Element) => boolean
  onStart: () => void
  /** Called continuously while dragging (for a live highlight). */
  onUpdate: (range: Range) => void
  /** Called on release; null means it was a plain click, not a selection. */
  onEnd: (range: Range | null) => void
}

const DRAG_THRESHOLD = 4 // px before a press becomes a drag
const EDGE = 40 // px from the container edge where auto-scroll kicks in
const MAX_SCROLL_SPEED = 22 // px per frame

/**
 * The text span a pointer position stands for: the whole word under it, or
 * an empty point at the start/end of a line when the pointer is in a margin.
 */
function span(hit: Hit): { from: Caret; to: Caret } {
  if (hit.side === 'before') return { from: hit.word.from, to: hit.word.from }
  if (hit.side === 'after') return { from: hit.word.to, to: hit.word.to }
  return { from: hit.word.from, to: hit.word.to }
}

/** Smallest range covering both spans, in reading order. */
function cover(a: Hit, b: Hit): Range {
  const sa = span(a)
  const sb = span(b)
  const from = before(sb.from, sa.from) ? sb.from : sa.from
  const to = before(sa.to, sb.to) ? sb.to : sa.to
  const r = document.createRange()
  r.setStart(from.node, from.offset)
  r.setEnd(to.node, to.offset)
  return r
}

export function installDragSelect(container: HTMLElement, h: DragHandlers): void {
  let anchor: Hit | null = null
  let origin = { x: 0, y: 0 }
  let pointer = { x: 0, y: 0 }
  let dragging = false
  let frame = 0

  const current = (): Range | null => {
    if (!anchor) return null
    const focus = wordAt(container, pointer.x, pointer.y)
    return focus ? cover(anchor, focus) : null
  }

  const update = (): void => {
    if (!dragging) return
    const r = current()
    if (r) h.onUpdate(r)
  }

  // Auto-scroll while the pointer is held near the top/bottom edge.
  const tick = (): void => {
    const c = container.getBoundingClientRect()
    let dy = 0
    if (pointer.y < c.top + EDGE) dy = -Math.min(MAX_SCROLL_SPEED, (c.top + EDGE - pointer.y) / 2)
    else if (pointer.y > c.bottom - EDGE) dy = Math.min(MAX_SCROLL_SPEED, (pointer.y - (c.bottom - EDGE)) / 2)
    if (dragging && dy !== 0) {
      container.scrollTop += dy
      update()
    }
    frame = requestAnimationFrame(tick)
  }

  const onMove = (e: MouseEvent): void => {
    pointer = { x: e.clientX, y: e.clientY }
    if (!dragging && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) return
    dragging = true
    update()
  }

  const onUp = (e: MouseEvent): void => {
    document.removeEventListener('mousemove', onMove)
    cancelAnimationFrame(frame)
    pointer = { x: e.clientX, y: e.clientY }
    // A release far from the press is a drag even if no mousemove arrived.
    if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) >= DRAG_THRESHOLD) dragging = true
    h.onEnd(dragging ? current() : null)
    anchor = null
    dragging = false
  }

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (h.isIgnored(target)) return
    // Keep PDF links and form widgets clickable.
    if (target.closest('.annotationLayer a, .annotationLayer input, .annotationLayer textarea')) return
    // Clicks on the container's own scrollbar.
    if (target === container && (e.offsetX >= container.clientWidth || e.offsetY >= container.clientHeight)) return
    if (!container.querySelector('.textLayer span')) return

    e.preventDefault() // we draw our own selection
    window.getSelection()?.removeAllRanges()
    h.onStart()

    const hit = wordAt(container, e.clientX, e.clientY)
    if (!hit) return

    // Double-click: select the word under the pointer.
    if (e.detail === 2) {
      if (hit.side === 'inside') h.onEnd(cover(hit, hit))
      return
    }

    anchor = hit
    origin = pointer = { x: e.clientX, y: e.clientY }
    dragging = false
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp, { once: true })
    frame = requestAnimationFrame(tick)
  })
}
