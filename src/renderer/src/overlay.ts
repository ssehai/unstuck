/**
 * Overlays that stick to the page while zooming.
 *
 * Highlights and markers live inside each page element, positioned in
 * percent of the page's drawing area. The page element is resized by CSS the
 * moment the scale changes (also during pinch), so the overlays follow
 * smoothly with no re-measuring.
 *
 * pdf.js removes unknown children of a page when it re-renders it, and hides
 * the text layer meanwhile. A MutationObserver puts our overlays back right
 * away (in the same frame, before anything is painted), so they never blink.
 */
import type { Box } from './lineModel'

/** A box as fractions (0–1) of a page's drawing area. */
export interface PageBox {
  page: number
  left: number
  top: number
  width: number
  height: number
}

const overlays = new WeakMap<HTMLElement, Map<string, HTMLElement>>()
const watched = new WeakSet<HTMLElement>()

function pageEl(container: HTMLElement, page: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
}

function watch(page: HTMLElement): void {
  if (watched.has(page)) return
  watched.add(page)
  new MutationObserver(() => {
    for (const o of overlays.get(page)?.values() ?? []) {
      if (o.parentElement !== page) page.appendChild(o)
    }
  }).observe(page, { childList: true })
}

/** The overlay of a given kind on a page (created on demand). */
export function pageOverlay(container: HTMLElement, page: number, kind: string): HTMLElement | null {
  const el = pageEl(container, page)
  if (!el) return null
  let byKind = overlays.get(el)
  if (!byKind) overlays.set(el, (byKind = new Map()))
  let o = byKind.get(kind)
  if (!o) {
    o = document.createElement('div')
    o.className = `unstuck-overlay uo-${kind}`
    byKind.set(kind, o)
  }
  if (o.parentElement !== el) el.appendChild(o)
  watch(el)
  return o
}

/** Clears every overlay of a kind on all pages. */
export function clearOverlays(container: HTMLElement, kind: string): void {
  container.querySelectorAll(`.uo-${kind}`).forEach((o) => o.replaceChildren())
}

/** The page's drawing area in viewport px (inside its border). */
function drawingRect(page: HTMLElement): DOMRect {
  const r = page.getBoundingClientRect()
  return new DOMRect(r.left + page.clientLeft, r.top + page.clientTop, page.clientWidth, page.clientHeight)
}

/** Converts viewport boxes to page fractions, assigning each to the page under its centre. */
export function toPageBoxes(boxes: Box[], container: HTMLElement): PageBox[] {
  const pages = Array.from(container.querySelectorAll<HTMLElement>('.page[data-page-number]'))
  const out: PageBox[] = []
  for (const b of boxes) {
    const cx = (b.left + b.right) / 2
    const cy = (b.top + b.bottom) / 2
    for (const page of pages) {
      const r = drawingRect(page)
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
      out.push({
        page: Number(page.dataset.pageNumber),
        left: (b.left - r.left) / r.width,
        top: (b.top - r.top) / r.height,
        width: (b.right - b.left) / r.width,
        height: (b.bottom - b.top) / r.height
      })
      break
    }
  }
  return out
}

export function placeBox(el: HTMLElement, b: PageBox, padPx = 0): void {
  Object.assign(el.style, {
    left: `calc(${b.left * 100}% - ${padPx}px)`,
    top: `calc(${b.top * 100}% - ${padPx}px)`,
    width: `calc(${b.width * 100}% + ${padPx * 2}px)`,
    height: `calc(${b.height * 100}% + ${padPx * 2}px)`
  })
}
