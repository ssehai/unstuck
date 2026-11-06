/**
 * The "stuck" flow inside the popup:
 *   selection → (equation capture) → prompt with the whole paper → streamed
 *   explanation → evidence quotes checked against the paper → click to jump.
 */
import { findCaptureRegion, looksMathy } from './capture'
import { explain, LlmError, type Streaming } from './llm'
import { jumpTo } from './locate'
import { renderMarkdown } from './markdown'
import { systemPrompt, userPrompt } from './prompt'
import { checkQuote, formatPaper, normalizeForMatch, paperParagraphs, type Paragraph } from './paperText'
import type { Reader } from './reader'
import type { StuckSelection } from './selection'


export interface ExplainDeps {
  reader: Reader
  container: HTMLElement
  title: () => string
  relayout: () => void
}

/** Runs one explanation into `body`. Returns a cancel function. */
export function startExplain(sel: StuckSelection, body: HTMLElement, deps: ExplainDeps): () => void {
  let stream: Streaming | null = null
  let cancelled = false

  body.innerHTML = '<div class="sp-capture-slot"></div><div class="sp-answer"><p class="sp-thinking"><span class="dot"></span>Reading the paper…</p></div>'
  const slot = body.querySelector<HTMLElement>('.sp-capture-slot')!
  const answer = body.querySelector<HTMLElement>('.sp-answer')!

  ;(async () => {
    const doc = deps.reader.document
    if (!doc) return
    const paras = await paperParagraphs(doc)
    if (cancelled) return

    // Equation image, when the selection contains math.
    let image: string | undefined
    if (looksMathy(sel.text)) {
      const region = findCaptureRegion(sel.range, deps.container)
      const img = region ? await deps.reader.renderRegion(region.page, region) : null
      if (cancelled) return
      if (img) {
        image = img.dataUrl.replace(/^data:image\/png;base64,/, '')
        slot.innerHTML = `<figure class="sp-capture"><img alt="Captured equation" src="${img.dataUrl}"><figcaption>Sent with your question</figcaption></figure>`
        slot.querySelector('img')!.onload = () => deps.relayout()
      }
    }

    const home = paragraphOf(paras, sel)
    const text = userPrompt(sel.text, sel.pageStart, home)

    let frame = 0
    stream = explain({ system: systemPrompt(deps.title(), formatPaper(paras, sel.pageStart)), text, image }, (full) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        answer.innerHTML = renderMarkdown(full)
        deps.relayout()
      })
    })

    try {
      const result = await stream.result
      cancelAnimationFrame(frame)
      answer.innerHTML = renderMarkdown(result.text)
      wireCitations(answer, paras, deps)
      deps.relayout()
    } catch (err) {
      if (cancelled) return
      const e = err as LlmError
      answer.innerHTML = ''
      const p = document.createElement('p')
      p.className = 'sp-error'
      p.textContent = e.auth
        ? 'Claude CLI is not logged in. Open Terminal, run `claude`, and log in with /login. Then select the passage again.'
        : `Something went wrong: ${e.message}`
      answer.appendChild(p)
      deps.relayout()
    }
  })()

  return () => {
    cancelled = true
    stream?.cancel()
  }
}

/** The paragraph that contains the selection (for extra context in the prompt). */
function paragraphOf(paras: Paragraph[], sel: StuckSelection): Paragraph | null {
  const probe = normalizeForMatch(sel.text).slice(0, 60)
  if (probe.length < 6) return null
  return (
    paras.find((p) => p.page === sel.pageStart && normalizeForMatch(p.text).includes(probe)) ??
    paras.find((p) => normalizeForMatch(p.text).includes(probe)) ??
    null
  )
}

/** Checks each evidence quote against the paper and makes citations clickable. */
function wireCitations(root: HTMLElement, paras: Paragraph[], deps: ExplainDeps): void {
  for (const li of root.querySelectorAll<HTMLElement>('li.evidence')) {
    const quote = li.dataset.quote ?? ''
    const cited = Number(li.dataset.page)
    const check = checkQuote(paras, quote, cited)
    const status = li.querySelector<HTMLElement>('.ev-status')!
    if (check.found) {
      status.textContent = '✓'
      status.className = 'ev-status ok'
      status.title = check.page === cited ? 'Quote found in the paper' : `Quote found on p.${check.page} (cited p.${cited})`
      li.dataset.page = String(check.page)
    } else {
      status.textContent = '!'
      status.className = 'ev-status bad'
      status.title = 'This quote was not found in the paper. Treat it with caution.'
    }
  }
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const ev = target.closest<HTMLElement>('li.evidence')
    const chip = target.closest<HTMLElement>('.cite')
    if (!ev && !chip) return
    const el = ev ?? chip!
    const page = Number(el.dataset.page)
    let quote = ev?.dataset.quote
    if (!quote && el.dataset.para) {
      // A bare [p.N ¶M] chip: jump to the start of that paragraph.
      const p = paras.find((x) => x.page === page && x.index === Number(el.dataset.para))
      quote = p?.text.slice(0, 80)
    }
    jumpTo(deps.reader, deps.container, page, quote)
  })
}
