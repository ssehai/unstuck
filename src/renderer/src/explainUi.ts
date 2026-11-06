/**
 * The "stuck" flow inside the side panel:
 *   selection → (equation capture) → prompt with the whole paper → streamed
 *   explanation → evidence quotes checked against the paper → click to jump
 *   → follow-up questions in the same conversation (M3).
 */
import { findCaptureRegion, looksMathy } from './capture'
import { explain, LlmError, type Streaming } from './llm'
import { jumpTo } from './locate'
import { renderMarkdown } from './markdown'
import { followUpPrompt, systemPrompt, userPrompt, type FollowUpKind } from './prompt'
import { checkQuote, formatPaper, normalizeForMatch, paperParagraphs, type Paragraph } from './paperText'
import type { Reader } from './reader'
import type { StuckSelection } from './selection'

export interface ExplainDeps {
  reader: Reader
  container: HTMLElement
  title: () => string
  relayout: () => void
}

/** One turn of the conversation about a passage (kept for "Got it" notes, M4). */
export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

const FOLLOW_UP_LABELS: Record<Exclude<FollowUpKind, 'question'>, string> = {
  confusions: '헷갈리기 쉬운 점',
  prerequisites: '선행 개념'
}

/** Runs the conversation for one selection inside `body`. Returns a cancel function. */
export function startExplain(sel: StuckSelection, body: HTMLElement, deps: ExplainDeps): () => void {
  let stream: Streaming | null = null
  let cancelled = false
  let busy = false
  let sessionId: string | undefined
  let system = ''
  let paras: Paragraph[] = []
  const turns: Turn[] = []

  body.innerHTML = '<div class="sp-capture-slot"></div><div class="sp-thread"></div>'
  const slot = body.querySelector<HTMLElement>('.sp-capture-slot')!
  const thread = body.querySelector<HTMLElement>('.sp-thread')!

  // Composer under the scrolling body: quick buttons + free-form question.
  const composer = document.createElement('form')
  composer.className = 'sp-composer'
  composer.innerHTML = `
    <div class="sp-quick">
      <button type="button" class="chip" data-kind="confusions">${FOLLOW_UP_LABELS.confusions}</button>
      <button type="button" class="chip" data-kind="prerequisites">${FOLLOW_UP_LABELS.prerequisites}</button>
    </div>
    <div class="sp-ask">
      <textarea rows="1" placeholder="이어서 질문하기…" title="Enter: 보내기 · Shift+Enter: 줄바꿈"></textarea>
      <button type="submit" class="btn primary sp-send" title="Send">↑</button>
    </div>`
  body.after(composer)
  const input = composer.querySelector('textarea')!
  const controls = (): HTMLButtonElement[] => Array.from(composer.querySelectorAll('button'))
  const setBusy = (b: boolean): void => {
    busy = b
    controls().forEach((x) => (x.disabled = b))
    input.disabled = b
  }
  setBusy(true)

  const scrollToEnd = (el: HTMLElement): void => {
    body.scrollTop = Math.max(0, el.offsetTop - body.offsetTop - 8)
  }

  /** Streams one assistant answer into a new block of the thread. */
  const run = async (text: string, image?: string): Promise<void> => {
    setBusy(true)
    const block = document.createElement('div')
    block.className = 'sp-answer'
    block.innerHTML = '<p class="sp-thinking"><span class="dot"></span>Thinking…</p>'
    thread.appendChild(block)
    if (turns.length > 0) scrollToEnd(block)

    let frame = 0
    stream = explain({ system, text, image, sessionId }, (full) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        block.innerHTML = renderMarkdown(full)
      })
    })
    try {
      const result = await stream.result
      cancelAnimationFrame(frame)
      sessionId = result.sessionId
      block.innerHTML = renderMarkdown(result.text)
      wireCitations(block, paras, deps)
      turns.push({ role: 'user', text }, { role: 'assistant', text: result.text })
    } catch (err) {
      cancelAnimationFrame(frame)
      if (cancelled) return
      const e = err as LlmError
      block.innerHTML = ''
      const p = document.createElement('p')
      p.className = 'sp-error'
      p.textContent = e.auth
        ? 'Claude CLI is not logged in. Open Terminal, run `claude`, and log in with /login. Then try again.'
        : `Something went wrong: ${e.message}`
      block.appendChild(p)
    } finally {
      if (!cancelled) setBusy(false)
      if (!cancelled && turns.length === 0) {
        // The first answer failed: nothing to follow up on.
        composer.hidden = true
      }
    }
  }

  const ask = (kind: FollowUpKind, question = ''): void => {
    if (busy || !sessionId) return
    const bubble = document.createElement('div')
    bubble.className = 'sp-question'
    bubble.textContent = kind === 'question' ? question : FOLLOW_UP_LABELS[kind]
    thread.appendChild(bubble)
    run(followUpPrompt(kind, question))
  }

  composer.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('button.chip')
    if (chip) ask(chip.dataset.kind as FollowUpKind)
  })
  composer.addEventListener('submit', (e) => {
    e.preventDefault()
    const q = input.value.trim()
    if (!q) return
    input.value = ''
    autosize()
    ask('question', q)
  })
  const autosize = (): void => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`
  }
  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation() // don't trigger app shortcuts while typing
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      composer.requestSubmit()
    }
  })

  ;(async () => {
    const doc = deps.reader.document
    if (!doc) return
    paras = await paperParagraphs(doc)
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
      }
    }

    system = systemPrompt(deps.title(), formatPaper(paras, sel.pageStart))
    await run(userPrompt(sel.text, sel.pageStart, paragraphOf(paras, sel)), image)
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
