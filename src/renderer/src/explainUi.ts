/**
 * The "stuck" conversation inside the side panel:
 *   selection → (equation capture) → prompt with the whole paper → streamed
 *   explanation → evidence quotes checked against the paper → click to jump
 *   → follow-up questions in the same conversation (M3)
 *   → saved as a stuck point; "Got it" condenses it into a note (M4).
 * A saved stuck point can be reopened later and continued.
 */
import { findCaptureRegion, looksMathy } from './capture'
import { explain, LlmError, type Streaming } from './llm'
import { jumpTo } from './locate'
import { renderMarkdown } from './markdown'
import type { NotesStore, StoredTurn, StuckRecord } from './notes'
import { followUpPrompt, NOTE_MODEL, NOTE_SYSTEM, notePrompt, systemPrompt, userPrompt, type FollowUpKind } from './prompt'
import { checkQuote, formatPaper, isSent, needsAppendix, normalizeForMatch, paperParagraphs, type Paragraph } from './paperText'
import type { Reader } from './reader'
import type { StuckSelection } from './selection'

export interface ExplainDeps {
  reader: Reader
  container: HTMLElement
  title: () => string
  paperId: () => string | null
  store: NotesStore
  /** Called whenever a stuck point is created or changes. */
  onRecord: (rec: StuckRecord) => void
}

const FOLLOW_UP_LABELS: Record<Exclude<FollowUpKind, 'question'>, string> = {
  confusions: '헷갈리기 쉬운 점',
  prerequisites: '선행 개념'
}

export type ConversationSource = { sel: StuckSelection } | { record: StuckRecord }

/** Runs (or resumes) the conversation for one passage inside `body`. Returns a cancel function. */
export function startConversation(src: ConversationSource, body: HTMLElement, deps: ExplainDeps): () => void {
  let stream: Streaming | null = null
  let cancelled = false
  let busy = false
  let system = ''
  let paras: Paragraph[] = []
  let record: StuckRecord | null = 'record' in src ? src.record : null
  const page = 'record' in src ? src.record.page : src.sel.pageStart

  body.innerHTML = '<div class="sp-capture-slot"></div><div class="sp-thread"></div><div class="sp-note-slot"></div>'
  const slot = body.querySelector<HTMLElement>('.sp-capture-slot')!
  const thread = body.querySelector<HTMLElement>('.sp-thread')!
  const noteSlot = body.querySelector<HTMLElement>('.sp-note-slot')!

  // Composer under the scrolling body: quick buttons, "Got it", free question.
  const composer = document.createElement('form')
  composer.className = 'sp-composer'
  composer.innerHTML = `
    <div class="sp-quick">
      <button type="button" class="chip" data-kind="confusions">${FOLLOW_UP_LABELS.confusions}</button>
      <button type="button" class="chip" data-kind="prerequisites">${FOLLOW_UP_LABELS.prerequisites}</button>
      <span class="spacer"></span>
      <button type="button" class="chip got-it" title="이해했어요: 대화를 짧은 노트로 정리해 저장해요">이해했음 ✓</button>
    </div>
    <div class="sp-ask">
      <textarea rows="1" placeholder="이어서 질문하기…" title="Enter: 보내기 · Shift+Enter: 줄바꿈"></textarea>
      <button type="submit" class="btn primary sp-send" title="Send">↑</button>
    </div>`
  body.after(composer)
  const input = composer.querySelector('textarea')!
  const gotItBtn = composer.querySelector<HTMLButtonElement>('.got-it')!
  /** Shows whether this passage is marked as understood. */
  const syncGotIt = (): void => {
    const done = record?.status === 'understood'
    gotItBtn.classList.toggle('done', done)
    gotItBtn.textContent = done ? '이해함 ✓' : '이해했음 ✓'
    gotItBtn.title = done
      ? '이미 노트로 정리했어요. 이어서 질문하면 다시 "진행 중"이 돼요.'
      : '이해했어요: 대화를 짧은 노트로 정리해 저장해요'
  }
  const setBusy = (b: boolean): void => {
    busy = b
    composer.querySelectorAll('button').forEach((x) => (x.disabled = b))
    input.disabled = b
  }
  setBusy(true)

  const scrollTo = (el: HTMLElement): void => {
    body.scrollTop = Math.max(0, el.offsetTop - body.offsetTop - 8)
  }
  const errorText = (e: LlmError): string =>
    e.auth
      ? 'Claude CLI is not logged in. Open Terminal, run `claude`, and log in with /login. Then try again.'
      : `Something went wrong: ${e.message}`

  const save = async (): Promise<void> => {
    if (!record) return
    record.updatedAt = Date.now()
    await deps.store.put(record.paperId, record).catch(() => false)
    deps.onRecord(record)
  }

  const addQuestion = (label: string): void => {
    const bubble = document.createElement('div')
    bubble.className = 'sp-question'
    bubble.textContent = label
    thread.appendChild(bubble)
  }

  const addAnswer = (markdown: string): HTMLElement => {
    const block = document.createElement('div')
    block.className = 'sp-answer'
    block.innerHTML = renderMarkdown(markdown)
    wireCitations(block, paras, deps)
    thread.appendChild(block)
    return block
  }

  const showNote = (markdown: string, stale = false): void => {
    noteSlot.innerHTML = `<div class="sp-note${stale ? ' stale' : ''}"><div class="sp-note-head">${
      stale ? '이전 노트 · 다시 질문해서 "진행 중"으로 바뀌었어요' : '✓ 이해한 내용 노트'
    }</div><div class="sp-note-body"></div></div>`
    const nb = noteSlot.querySelector<HTMLElement>('.sp-note-body')!
    nb.innerHTML = renderMarkdown(markdown)
    wireCitations(nb, paras, deps)
  }

  /** Streams one model reply into `block`. Resolves to the text, or null on failure. */
  const stream1 = async (block: HTMLElement, text: string, image?: string): Promise<string | null> => {
    let frame = 0
    stream = explain({ system, text, image, sessionId: record?.sessionId }, (full) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => (block.innerHTML = renderMarkdown(full)))
    })
    try {
      const result = await stream.result
      cancelAnimationFrame(frame)
      if (record) record.sessionId = result.sessionId
      else pendingSession = result.sessionId
      block.innerHTML = renderMarkdown(result.text)
      wireCitations(block, paras, deps)
      return result.text
    } catch (err) {
      cancelAnimationFrame(frame)
      if (!cancelled) {
        block.innerHTML = ''
        const p = document.createElement('p')
        p.className = 'sp-error'
        p.textContent = errorText(err as LlmError)
        block.appendChild(p)
      }
      return null
    }
  }
  let pendingSession: string | undefined

  const thinking = (label: string): HTMLElement => {
    const block = document.createElement('div')
    block.className = 'sp-answer'
    block.innerHTML = `<p class="sp-thinking"><span class="dot"></span>${label}</p>`
    return block
  }

  /** A follow-up turn: question bubble + streamed answer, then saved. */
  const ask = async (kind: FollowUpKind, question = ''): Promise<void> => {
    if (busy || !record?.sessionId) return
    setBusy(true)
    const label = kind === 'question' ? question : FOLLOW_UP_LABELS[kind]
    const text = followUpPrompt(kind, question)
    if (record.status === 'understood') {
      // A new question means it isn't settled after all.
      record.status = 'open'
      syncGotIt()
      if (record.note) showNote(record.note, true)
      await save()
    }
    addQuestion(label)
    const block = thinking('Thinking…')
    thread.appendChild(block)
    scrollTo(block)
    const reply = await stream1(block, text)
    if (reply !== null && record) {
      record.turns.push({ role: 'user', display: label, text }, { role: 'assistant', display: reply, text: reply })
      await save()
    }
    if (!cancelled) setBusy(false)
  }

  /** "Got it": condense the conversation into a short note. */
  const gotIt = async (): Promise<void> => {
    if (busy || !record?.sessionId) return
    if (record.status === 'understood') {
      scrollTo(noteSlot)
      return
    }
    setBusy(true)
    noteSlot.innerHTML = ''
    const block = thinking('노트로 정리하는 중…')
    noteSlot.appendChild(block)
    scrollTo(block)
    // A cheap model, from the conversation alone: no paper, no session.
    let note: string | null = null
    let frame = 0
    stream = explain(
      { system: NOTE_SYSTEM, text: notePrompt(record.quote, record.turns), model: NOTE_MODEL, ephemeral: true },
      (full) => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => (block.innerHTML = renderMarkdown(full)))
      }
    )
    try {
      note = (await stream.result).text
    } catch (err) {
      if (!cancelled) {
        block.innerHTML = ''
        const p = document.createElement('p')
        p.className = 'sp-error'
        p.textContent = errorText(err as LlmError)
        block.appendChild(p)
      }
    }
    cancelAnimationFrame(frame)
    if (note !== null && record) {
      record.note = note
      record.status = 'understood'
      syncGotIt()
      await save()
      showNote(note)
      scrollTo(noteSlot)
    }
    if (!cancelled) setBusy(false)
  }

  composer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.chip')
    if (!btn) return
    if (btn.classList.contains('got-it')) gotIt()
    else ask(btn.dataset.kind as FollowUpKind)
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

  const showImage = (dataUrl: string): void => {
    slot.innerHTML = `<figure class="sp-capture"><img alt="Captured equation" src="${dataUrl}"><figcaption>Sent with your question</figcaption></figure>`
  }

  ;(async () => {
    const doc = deps.reader.document
    if (!doc) return
    paras = await paperParagraphs(doc)
    if (cancelled) return
    // What to send: the paper without references, and the appendix only if
    // this passage needs it. Deterministic per passage, so a reopened stuck
    // point resumes with exactly the same prompt (and cache).
    const quote = 'record' in src ? src.record.quote : src.sel.text
    const home = paragraphAt(paras, page, quote)
    const appendix = needsAppendix(paras, page, quote, home?.text ?? '')
    system = systemPrompt(deps.title(), formatPaper(paras, { appendix }))

    // Reopening a saved stuck point: replay it, then allow continuing.
    if (record) {
      if (record.image) showImage(record.image)
      record.turns.forEach((t, i) => {
        if (t.role === 'user' && i > 0) addQuestion(t.display)
        if (t.role === 'assistant') addAnswer(t.text)
      })
      if (record.note) showNote(record.note, record.status !== 'understood')
      syncGotIt()
      composer.hidden = !record.sessionId
      setBusy(false)
      return
    }

    // A new selection.
    const sel = (src as { sel: StuckSelection }).sel
    let image: string | undefined
    let imageUrl: string | undefined
    if (looksMathy(sel.text)) {
      const region = findCaptureRegion(sel.range, deps.container)
      const img = region ? await deps.reader.renderRegion(region.page, region) : null
      if (cancelled) return
      if (img) {
        imageUrl = img.dataUrl
        image = img.dataUrl.replace(/^data:image\/png;base64,/, '')
        showImage(img.dataUrl)
      }
    }

    const text = userPrompt(sel.text, sel.pageStart, home, !!home && isSent(home, { appendix }))
    const block = thinking('Reading the paper…')
    thread.appendChild(block)
    const reply = await stream1(block, text, image)
    if (cancelled) return
    const paperId = deps.paperId()
    if (reply === null || !paperId) {
      composer.hidden = true // nothing to follow up on
      return
    }
    // The first answer worked: this passage becomes a stuck point.
    const turns: StoredTurn[] = [
      { role: 'user', display: sel.text, text },
      { role: 'assistant', display: reply, text: reply }
    ]
    record = {
      id: crypto.randomUUID(),
      paperId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      page: sel.pageStart,
      pageEnd: sel.pageEnd,
      quote: sel.text,
      image: imageUrl,
      sessionId: pendingSession,
      turns,
      status: 'open'
    }
    await save()
    setBusy(false)
  })()

  return () => {
    cancelled = true
    stream?.cancel()
  }
}

/** The paragraph that contains a passage (for extra context in the prompt). */
export function paragraphAt(paras: Paragraph[], page: number, text: string): Paragraph | null {
  const probe = normalizeForMatch(text).slice(0, 60)
  if (probe.length < 6) return null
  return (
    paras.find((p) => p.page === page && normalizeForMatch(p.text).includes(probe)) ??
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
  if (root.dataset.wired) return
  root.dataset.wired = '1'
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
