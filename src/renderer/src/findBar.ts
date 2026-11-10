/**
 * A small find bar: text field, "3 / 12" counter, previous / next, close.
 * Enter = next, Shift+Enter = previous, Esc = close. Used for both the PDF
 * (⌘F) and the side panel (⌘⇧F); what is searched is up to the caller.
 */

export type FindDirection = 'new' | 'next' | 'prev'

export interface FindBarOptions {
  placeholder: string
  className?: string
  onSearch: (query: string, direction: FindDirection) => void
  onClose: () => void
}

export class FindBar {
  readonly el: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly count: HTMLSpanElement
  private timer = 0

  constructor(host: HTMLElement, private readonly opts: FindBarOptions) {
    this.el = document.createElement('div')
    this.el.className = `find-bar ${opts.className ?? ''}`
    this.el.hidden = true
    this.el.innerHTML = `
      <svg class="fb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2" />
        <line x1="15" y1="15" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <input type="text" spellcheck="false" />
      <span class="fb-count"></span>
      <button class="fb-btn" data-dir="prev" title="Previous (⇧Enter)" aria-label="Previous">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><polyline points="6 15 12 9 18 15" /></svg>
      </button>
      <button class="fb-btn" data-dir="next" title="Next (Enter)" aria-label="Next">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <button class="fb-btn fb-close" title="Close (Esc)" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
      </button>`
    host.appendChild(this.el)
    this.input = this.el.querySelector('input')!
    this.input.placeholder = opts.placeholder
    this.count = this.el.querySelector('.fb-count')!

    this.input.addEventListener('input', () => {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.opts.onSearch(this.input.value, 'new'), 120)
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return // app shortcuts (⌘G, ⌘F …) still work
      e.stopPropagation()
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        this.step(e.shiftKey ? 'prev' : 'next')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      }
    })
    this.el.addEventListener('mousedown', (e) => e.stopPropagation()) // not a PDF text selection
    this.el.querySelectorAll<HTMLButtonElement>('.fb-btn[data-dir]').forEach((b) =>
      b.addEventListener('click', () => this.step(b.dataset.dir as 'next' | 'prev'))
    )
    this.el.querySelector('.fb-close')!.addEventListener('click', () => this.close())
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  get query(): string {
    return this.input.value
  }

  open(prefill?: string): void {
    this.el.hidden = false
    if (prefill) this.input.value = prefill
    this.input.focus()
    this.input.select()
    if (this.input.value) this.opts.onSearch(this.input.value, 'new')
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.setCount(0, 0)
    this.opts.onClose()
  }

  step(direction: 'next' | 'prev'): void {
    if (!this.input.value) return this.input.focus()
    this.opts.onSearch(this.input.value, direction)
  }

  /** Shows "current / total", or "없음" when there is a query but no match. */
  setCount(current: number, total: number): void {
    this.count.textContent = !this.input.value ? '' : total ? `${current} / ${total}` : '없음'
    this.el.classList.toggle('no-match', !!this.input.value && total === 0)
  }
}
