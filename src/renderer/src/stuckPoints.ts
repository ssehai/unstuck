/**
 * The paper's stuck points: the list on the panel's home view, and small
 * markers in the page margin next to each passage (orange = still open,
 * green = understood). Clicking either reopens the saved conversation.
 */
import { selectionBoxes } from './lineModel'
import { findInPage } from './locate'
import { renderMarkdown } from './markdown'
import { clearOverlays, pageOverlay, toPageBoxes } from './overlay'
import type { NotesStore, StuckRecord } from './notes'

interface Deps {
  container: HTMLElement
  store: NotesStore
  open: (rec: StuckRecord) => void
}

/** Where a passage sits, as fractions of its page (survives zooming). */
interface Spot {
  page: number
  top: number
  bottom: number
  left: number
}

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

  private async remove(rec: StuckRecord): Promise<void> {
    if (!this.paperId) return
    await this.deps.store.remove(this.paperId, rec.id)
    this.records = this.records.filter((r) => r.id !== rec.id)
    this.spots.delete(rec.id)
    this.renderList()
    this.renderMarkers()
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
        li.querySelector<HTMLElement>('.si-quote')!.textContent = `“${rec.quote.length > 110 ? rec.quote.slice(0, 109) + '…' : rec.quote}”`
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
      if (this.spots.has(rec.id)) continue
      const pageEl = c.querySelector<HTMLElement>(`.page[data-page-number="${rec.page}"]`)
      if (!pageEl?.querySelector('.textLayer span')) continue
      const range = findInPage(pageEl, rec.quote)
      if (!range) continue
      const boxes = toPageBoxes(selectionBoxes(range, c), c).filter((b) => b.page === rec.page)
      if (boxes.length === 0) continue
      this.spots.set(rec.id, {
        page: rec.page,
        top: boxes[0].top,
        bottom: boxes[0].top + boxes[0].height,
        left: Math.min(...boxes.map((b) => b.left))
      })
    }

    clearOverlays(c, 'markers')
    for (const rec of this.records) {
      const s = this.spots.get(rec.id)
      const overlay = s && pageOverlay(c, s.page, 'markers')
      if (!s || !overlay) continue
      const m = document.createElement('button')
      m.className = `stuck-marker ${rec.status}`
      m.title = rec.status === 'understood' ? '이해한 곳 · 노트 보기' : '막혔던 곳 · 대화 다시 보기'
      // 18px left of the passage, vertically centred on its first line.
      m.style.left = `max(4px, calc(${s.left * 100}% - 18px))`
      m.style.top = `calc(${((s.top + s.bottom) / 2) * 100}% - 5px)`
      m.addEventListener('mousedown', (e) => e.stopPropagation()) // not a text selection
      m.addEventListener('click', () => this.deps.open(rec))
      overlay.appendChild(m)
    }
  }
}
