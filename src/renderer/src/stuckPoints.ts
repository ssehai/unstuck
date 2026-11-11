/**
 * The paper's stuck points: the list on the panel's home view, and small
 * markers in the page margin next to each passage (orange = still open,
 * green = understood). Clicking either reopens the saved conversation.
 */
import { selectionBoxes } from './lineModel'
import { findInPage } from './locate'
import { renderMarkdown } from './markdown'
import { clearOverlays, pageOverlay, toPageBoxes } from './overlay'
import { anchorsOf, type NotesStore, type StuckRecord } from './notes'

interface Deps {
  container: HTMLElement
  store: NotesStore
  open: (rec: StuckRecord) => void
  /** Clicking a dot: opens it, or closes it when it is already open. */
  toggle?: (rec: StuckRecord) => void
  /** Called after a stuck point was deleted. */
  onDeleted?: (rec: StuckRecord) => void
}

/** Where a passage sits, as fractions of its page (survives zooming). */
interface Spot {
  page: number
  top: number
  bottom: number
  left: number
  /** Page height / width, to make the dot round in percent units. */
  aspect: number
}

/** Spots are per place: a stuck point asked about several places has a dot at each. */
const spotKey = (rec: StuckRecord, i: number): string => `${rec.id}#${i}`

/** Dot diameter relative to the passage's line height. */
const DOT_OF_LINE = 0.6
/**
 * The dot sits diagonally up-left of the passage's first character, mostly in
 * the space before the word and the gap above the line, so it never covers
 * glyphs. These are how far it overlaps the passage's corner (fractions of
 * the dot size).
 */
const OVERLAP_X = 0.15
const OVERLAP_Y = 0.25

export class StuckPoints {
  private records: StuckRecord[] = []
  private paperId: string | null = null
  private spots = new Map<string, Spot>()
  constructor(private readonly deps: Deps) {}

  async load(paperId: string): Promise<void> {
    this.paperId = paperId
    this.spots.clear()
    const list = await this.deps.store.list(paperId).catch(() => [] as StuckRecord[])
    if (this.paperId !== paperId) return
    this.records = list.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
    this.renderList()
    this.renderMarkers()
  }

  upsert(rec: StuckRecord): void {
    if (rec.paperId !== this.paperId) return
    const i = this.records.findIndex((r) => r.id === rec.id)
    if (i >= 0) this.records[i] = rec
    else this.records.push(rec)
    this.records.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
    this.renderList()
    this.renderMarkers()
  }

  /** Deletes a stuck point with its conversation and note. */
  async remove(rec: StuckRecord): Promise<void> {
    if (!this.paperId) return
    await this.deps.store.remove(this.paperId, rec.id)
    this.records = this.records.filter((r) => r.id !== rec.id)
    for (const k of [...this.spots.keys()]) if (k.startsWith(`${rec.id}#`)) this.spots.delete(k)
    this.renderList()
    this.renderMarkers()
    this.deps.onDeleted?.(rec)
  }

  /** A small right-click menu for a dot: open it, or delete the record. */
  private showMenu(rec: StuckRecord, x: number, y: number): void {
    document.querySelector('.marker-menu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'marker-menu'
    menu.innerHTML = `
      <button data-act="open">${rec.status === 'understood' ? '노트 보기' : '대화 다시 보기'}</button>
      <button data-act="delete" class="danger">기록 삭제</button>`
    document.body.appendChild(menu)
    // Keep it inside the window.
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`

    const close = (): void => {
      menu.remove()
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      this.deps.container.removeEventListener('scroll', close)
    }
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    this.deps.container.addEventListener('scroll', close, { once: true })
    menu.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.act
      if (!act) return
      close()
      if (act === 'open') this.deps.open(rec)
      else void this.remove(rec)
    })
  }

  // --- Panel list ---------------------------------------------------------------
  renderList(): void {
    const box = document.querySelector<HTMLElement>('.ph-stuck')
    const hint = document.querySelector<HTMLElement>('.ph-hint')
    const ul = document.getElementById('stuckList')
    const count = document.getElementById('stuckCount')
    if (!box || !hint || !ul || !count) return
    box.hidden = this.records.length === 0
    hint.classList.toggle('compact', this.records.length > 0)
    const done = this.records.filter((r) => r.status === 'understood').length
    count.textContent = `${this.records.length}개 · 이해함 ${done}`
    ul.replaceChildren(
      ...this.records.map((rec) => {
        const li = document.createElement('li')
        li.className = `stuck-item ${rec.status}`
        const title = rec.note ? /^#{1,6}\s*(.+)$/m.exec(rec.note)?.[1] : undefined
        li.innerHTML = `
          <button class="si-open" title="Open this stuck point">
            <span class="si-top"><span class="si-dot"></span><span class="si-page">p.${rec.page}</span><span class="si-state">${rec.status === 'understood' ? '이해함' : '진행 중'}</span></span>
            <span class="si-title"></span>
            <span class="si-quote"></span>
          </button>
          <button class="si-remove" title="Delete this stuck point">×</button>`
        const t = li.querySelector<HTMLElement>('.si-title')!
        if (title) t.innerHTML = renderMarkdown(title).replace(/^<p>|<\/p>$/g, '')
        else t.remove()
        const more = anchorsOf(rec).length - 1
        li.querySelector<HTMLElement>('.si-quote')!.textContent =
          `“${rec.quote.length > 110 ? rec.quote.slice(0, 109) + '…' : rec.quote}”` + (more ? ` 외 ${more}곳` : '')
        li.querySelector('.si-open')!.addEventListener('click', () => this.deps.open(rec))
        li.querySelector('.si-remove')!.addEventListener('click', (e) => {
          e.stopPropagation()
          if (confirm('이 막힘 기록과 대화·노트를 삭제할까요?')) this.remove(rec)
        })
        return li
      })
    )
  }

  // --- Margin markers -------------------------------------------------------------
  /**
   * Finds passages on pages whose text layer is ready, then draws a dot in the
   * margin next to each. Dots live in the page's text layer, positioned in
   * percent, so they move smoothly with pinch-zoom.
   */
  renderMarkers(): void {
    const c = this.deps.container
    for (const rec of this.records) {
      anchorsOf(rec).forEach((a, i) => {
        const key = spotKey(rec, i)
        if (this.spots.has(key)) return
        const pageEl = c.querySelector<HTMLElement>(`.page[data-page-number="${a.page}"]`)
        if (!pageEl) return
        const aspect = pageEl.clientHeight / pageEl.clientWidth
        if (a.figure) {
          // A figure's dot sits at the figure's top-left corner, sized like a body line.
          const f = a.figure
          this.spots.set(key, { page: f.page, top: f.y, bottom: f.y + 0.0125, left: f.x, aspect })
          return
        }
        if (!pageEl.querySelector('.textLayer span')) return
        const range = findInPage(pageEl, a.quote)
        if (!range) return
        const boxes = toPageBoxes(selectionBoxes(range, c), c).filter((b) => b.page === a.page)
        if (boxes.length === 0) return
        this.spots.set(key, {
          page: a.page,
          top: boxes[0].top,
          bottom: boxes[0].top + boxes[0].height,
          left: Math.min(...boxes.map((b) => b.left)),
          aspect
        })
      })
    }

    clearOverlays(c, 'markers')
    for (const rec of this.records) for (let i = 0; i < anchorsOf(rec).length; i++) {
      const s = this.spots.get(spotKey(rec, i))
      const overlay = s && pageOverlay(c, s.page, 'markers')
      if (!s || !overlay) continue
      const m = document.createElement('button')
      m.className = `stuck-marker ${rec.status}`
      m.title = (rec.status === 'understood' ? '이해한 곳 · 노트 보기' : '막혔던 곳 · 대화 다시 보기') + ' (오른쪽 클릭: 메뉴)'
      // Sized from the first line's height, all in percent of the page, so the
      // dot scales with the text when zooming.
      const h = (s.bottom - s.top) * DOT_OF_LINE // fraction of page height
      const w = h * s.aspect // the same length as a fraction of page width
      const left = Math.max(0.002, s.left - w * (1 - OVERLAP_X))
      const top = Math.max(0.002, s.top - h * (1 - OVERLAP_Y))
      Object.assign(m.style, {
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`
      })
      m.addEventListener('mousedown', (e) => e.stopPropagation()) // not a text selection
      m.addEventListener('click', () => (this.deps.toggle ?? this.deps.open)(rec))
      m.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.showMenu(rec, e.clientX, e.clientY)
      })
      overlay.appendChild(m)
    }
  }
}
