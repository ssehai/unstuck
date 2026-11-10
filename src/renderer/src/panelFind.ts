/**
 * Find in the side panel (⌘⇧F): explanations, follow-ups, notes and the
 * stuck-point list. Matches are marked with the CSS Custom Highlight API, so
 * the panel's DOM is not touched (answers may still be streaming in).
 */
import { FindBar, type FindDirection } from './findBar'

const ALL = 'unstuck-find'
const CURRENT = 'unstuck-find-current'

export class PanelFind {
  readonly bar: FindBar
  private matches: Range[] = []
  private index = -1
  private query = ''
  private observer: MutationObserver | null = null

  constructor(private readonly panel: HTMLElement) {
    this.bar = new FindBar(panel, {
      placeholder: '패널에서 찾기',
      className: 'find-panel',
      onSearch: (q, dir) => this.search(q, dir),
      onClose: () => this.clear()
    })
  }

  open(): void {
    this.bar.open()
    // Keep counts right while answers stream in or the panel changes.
    this.observer?.disconnect()
    this.observer = new MutationObserver((records) => {
      // Ignore the find bar's own updates (its counter), or this would loop.
      if (records.every((r) => this.bar.el.contains(r.target))) return
      if (this.query) this.search(this.query, 'refresh')
    })
    this.observer.observe(this.panel, { childList: true, subtree: true, characterData: true })
  }

  private search(query: string, direction: FindDirection | 'refresh'): void {
    this.query = query
    const previous = this.matches[this.index]
    this.matches = query ? this.collect(query) : []
    if (this.matches.length === 0) this.index = -1
    else if (direction === 'new') this.index = 0
    else if (direction === 'next') this.index = (this.index + 1) % this.matches.length
    else if (direction === 'prev') this.index = (this.index - 1 + this.matches.length) % this.matches.length
    else {
      // refresh: stay on the same match if it still exists
      const same = previous ? this.matches.findIndex((r) => sameRange(r, previous)) : -1
      this.index = same >= 0 ? same : Math.min(Math.max(this.index, 0), this.matches.length - 1)
    }
    this.paint()
    if (direction !== 'refresh') this.reveal()
    this.bar.setCount(this.index + 1, this.matches.length)
  }

  /** All case-insensitive occurrences inside visible panel text. */
  private collect(query: string): Range[] {
    const q = query.toLowerCase()
    const out: Range[] = []
    const walker = document.createTreeWalker(this.panel, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const el = n.parentElement
        if (!el || el.closest('.find-bar, .katex-mathml, [hidden], textarea, script, style')) return NodeFilter.FILTER_REJECT
        return el.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      }
    })
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n as Text).data.toLowerCase()
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + q.length)
        out.push(r)
      }
    }
    return out
  }

  private paint(): void {
    CSS.highlights.set(ALL, new Highlight(...this.matches))
    const cur = this.matches[this.index]
    if (cur) CSS.highlights.set(CURRENT, new Highlight(cur))
    else CSS.highlights.delete(CURRENT)
  }

  /** Scrolls the current match into view inside its scrolling area. */
  private reveal(): void {
    const r = this.matches[this.index]
    if (!r) return
    const el = r.startContainer.parentElement
    const scroller = el?.closest<HTMLElement>('.sp-body, .panel-home')
    if (!scroller) return
    const box = r.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (box.top < view.top + 40 || box.bottom > view.bottom - 20) {
      scroller.scrollTop += box.top - view.top - view.height / 3
    }
  }

  private clear(): void {
    this.observer?.disconnect()
    this.observer = null
    this.matches = []
    this.index = -1
    this.query = ''
    CSS.highlights.delete(ALL)
    CSS.highlights.delete(CURRENT)
  }
}

function sameRange(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endOffset === b.endOffset
}
