/**
 * Evaluation mode (M5): blind A/B comparison of the tool against a baseline
 * that only sees the selected passage (like pasting it into a chatbot).
 *
 * Both answers come from the same model at the same time. They are shown as
 * A and B in random order, with evidence sections and citation chips hidden
 * (they would give the tool away). After the rating the identities are
 * revealed and the tool's citations are checked. Results are appended to
 * results.jsonl (or localStorage in a browser).
 */
import { findCaptureRegion, looksMathy } from './capture'
import { explain, LlmError, type Streaming } from './llm'
import { jumpTo } from './locate'
import { renderMarkdown } from './markdown'
import { baselineSystemPrompt, baselineUserPrompt, systemPrompt, userPrompt } from './prompt'
import { paragraphAt } from './explainUi'
import { checkQuote, formatPaper, isSent, needsAppendix, paperParagraphs, type Paragraph } from './paperText'
import type { Reader } from './reader'
import type { StuckSelection } from './selection'

type Arm = 'tool' | 'baseline'

export interface EvalRecord {
  id: string
  at: string
  paper: string
  page: number
  passage: string
  hasMath: boolean
  imageSent: boolean
  /** Which arm was shown as A (the other was B). */
  shownAsA: Arm
  answers: Record<Arm, string>
  latencyMs: Record<Arm, number>
  preferred: Arm | 'tie'
  reasons: string[]
  comment: string
  errors: Record<Arm, boolean>
  /** The tool's evidence quotes found verbatim in the paper (automatic). */
  citations: { total: number; verified: number }
  /** Do the tool's citations actually support its claims? (manual) */
  citationSupport: 'yes' | 'partly' | 'no' | 'none'
}

export interface EvalStore {
  append(rec: EvalRecord): Promise<boolean>
  list(): Promise<EvalRecord[]>
  reveal?(): Promise<boolean>
}

export function getEvalStore(): EvalStore {
  return (window.unstuckApi?.evaluation as EvalStore | undefined) ?? localEvalStore
}

const LS_KEY = 'unstuck.evaluation'
const localEvalStore: EvalStore = {
  async append(rec) {
    try {
      const list = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')
      list.push(rec)
      localStorage.setItem(LS_KEY, JSON.stringify(list))
      return true
    } catch {
      return false
    }
  },
  async list() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')
    } catch {
      return []
    }
  }
}

const REASONS = ['쉬운 표현', '예시가 좋음', '구조가 깔끔함', '핵심을 짚음', '논문 맥락에 맞음', '더 정확함']

export interface EvalDeps {
  reader: Reader
  container: HTMLElement
  title: () => string
  store: EvalStore
}

/** Hides what would reveal the tool: the evidence section and [p.N ¶M] chips. */
function blind(md: string): string {
  return md
    .replace(/\n#{1,6}\s*근거[\s\S]*$/, '')
    .replace(/\s*\[p\.\s?\d+(?:\s*¶\s?\d+)?\](?:\s*[,–-]\s*\[p\.\s?\d+(?:\s*¶\s?\d+)?\])*/g, '')
}

export function startEvaluation(sel: StuckSelection, body: HTMLElement, deps: EvalDeps): () => void {
  let cancelled = false
  const streams: Streaming[] = []
  const shownAsA: Arm = Math.random() < 0.5 ? 'tool' : 'baseline'
  const order: Arm[] = shownAsA === 'tool' ? ['tool', 'baseline'] : ['baseline', 'tool']
  const label = (arm: Arm): 'A' | 'B' => (order[0] === arm ? 'A' : 'B')
  const answers: Record<Arm, string> = { tool: '', baseline: '' }
  const latency: Record<Arm, number> = { tool: 0, baseline: 0 }
  const done: Record<Arm, boolean> = { tool: false, baseline: false }
  let paras: Paragraph[] = []
  let imageSent = false

  body.innerHTML = `
    <div class="ev-banner">평가 모드 · 블라인드 비교 <span class="muted">어느 쪽이 Unstuck인지 숨겨져 있어요</span></div>
    <div class="ev-tabs">
      <button class="ev-tab active" data-slot="0">A <span class="ev-tab-state">…</span></button>
      <button class="ev-tab" data-slot="1">B <span class="ev-tab-state">…</span></button>
    </div>
    <div class="ev-panes">
      <div class="ev-pane sp-answer" data-slot="0"><p class="sp-thinking"><span class="dot"></span>답변 A 생성 중…</p></div>
      <div class="ev-pane sp-answer" data-slot="1" hidden><p class="sp-thinking"><span class="dot"></span>답변 B 생성 중…</p></div>
    </div>
    <form class="ev-form" hidden></form>
    <div class="ev-summary"></div>`
  const tabs = Array.from(body.querySelectorAll<HTMLButtonElement>('.ev-tab'))
  const panes = Array.from(body.querySelectorAll<HTMLElement>('.ev-pane'))
  const form = body.querySelector<HTMLFormElement>('.ev-form')!
  const show = (slot: number): void => {
    tabs.forEach((t, i) => t.classList.toggle('active', i === slot))
    panes.forEach((p, i) => (p.hidden = i !== slot))
  }
  tabs.forEach((t, i) => t.addEventListener('click', () => show(i)))
  renderSummary(body.querySelector('.ev-summary')!, deps.store)

  const slotOf = (arm: Arm): number => order.indexOf(arm)

  const run = (arm: Arm, req: { system: string; text: string; image?: string }): void => {
    const pane = panes[slotOf(arm)]
    const state = tabs[slotOf(arm)].querySelector('.ev-tab-state')!
    const t0 = performance.now()
    let frame = 0
    const s = explain(req, (full) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => (pane.innerHTML = renderMarkdown(blind(full))))
    })
    streams.push(s)
    s.result
      .then((r) => {
        cancelAnimationFrame(frame)
        answers[arm] = r.text
        latency[arm] = Math.round(performance.now() - t0)
        pane.innerHTML = renderMarkdown(blind(r.text))
        state.textContent = '✓'
      })
      .catch((e: LlmError) => {
        if (cancelled) return
        pane.innerHTML = `<p class="sp-error"></p>`
        pane.querySelector('p')!.textContent = `Something went wrong: ${e.message}`
        state.textContent = '!'
      })
      .finally(() => {
        done[arm] = true
        if (done.tool && done.baseline && answers.tool && answers.baseline && !cancelled) showForm()
      })
  }

  ;(async () => {
    const doc = deps.reader.document
    if (!doc) return
    paras = await paperParagraphs(doc)
    if (cancelled) return
    let image: string | undefined
    if (looksMathy(sel.text)) {
      const region = findCaptureRegion(sel.range, deps.container)
      const img = region ? await deps.reader.renderRegion(region.page, region) : null
      if (img) {
        image = img.dataUrl.replace(/^data:image\/png;base64,/, '')
        imageSent = true
      }
    }
    if (cancelled) return
    const home = paragraphAt(paras, sel.pageStart, sel.text)
    const appendix = needsAppendix(paras, sel.pageStart, sel.text, home?.text ?? '')
    run('tool', {
      system: systemPrompt(deps.title(), formatPaper(paras, { appendix })),
      text: userPrompt(sel.text, sel.pageStart, home, !!home && isSent(home, { appendix })),
      image
    })
    run('baseline', { system: baselineSystemPrompt(), text: baselineUserPrompt(sel.text) })
  })()

  // --- Step 1: blind rating -------------------------------------------------------
  function showForm(): void {
    form.hidden = false
    form.innerHTML = `
      <div class="ev-q">1. 어느 답을 읽고 더 명확하게 이해했나요?</div>
      <div class="ev-choices" data-name="preferred">
        <button type="button" data-v="A">A</button><button type="button" data-v="B">B</button><button type="button" data-v="tie">비슷함</button>
      </div>
      <div class="ev-q">2. 왜요? <span class="muted">(여러 개 선택)</span></div>
      <div class="ev-choices multi" data-name="reasons">${REASONS.map((r) => `<button type="button" data-v="${r}">${r}</button>`).join('')}</div>
      <div class="ev-q">3. 틀린 내용이 있었나요?</div>
      <div class="ev-choices multi" data-name="errors">
        <button type="button" data-v="A">A에 있음</button><button type="button" data-v="B">B에 있음</button>
      </div>
      <textarea class="ev-comment" rows="2" placeholder="메모 (선택): 무엇이 좋았고, 무엇이 틀렸나요?"></textarea>
      <button type="submit" class="btn primary ev-submit" disabled>공개하기</button>`
    const pick: Record<string, Set<string>> = { preferred: new Set(), reasons: new Set(), errors: new Set() }
    form.querySelectorAll<HTMLElement>('.ev-choices').forEach((group) => {
      const name = group.dataset.name!
      const multi = group.classList.contains('multi')
      group.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button')
        if (!b) return
        const v = b.dataset.v!
        if (multi) pick[name].has(v) ? pick[name].delete(v) : pick[name].add(v)
        else pick[name] = new Set([v])
        group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', pick[name].has(x.dataset.v!)))
        form.querySelector<HTMLButtonElement>('.ev-submit')!.disabled = pick.preferred.size === 0
      })
    })
    form.querySelector('textarea')!.addEventListener('keydown', (e) => e.stopPropagation())
    form.addEventListener(
      'submit',
      (e) => {
        e.preventDefault()
        const p = [...pick.preferred][0]
        const armOf = (l: string): Arm => (l === 'A' ? order[0] : order[1])
        reveal({
          preferred: p === 'tie' ? 'tie' : armOf(p),
          reasons: [...pick.reasons],
          errors: { tool: pick.errors.has(label('tool')), baseline: pick.errors.has(label('baseline')) },
          comment: form.querySelector('textarea')!.value.trim()
        })
      },
      { once: true }
    )
    body.scrollTop = form.offsetTop - 20
  }

  // --- Step 2: reveal + citation check, then save ------------------------------------
  function reveal(r: Pick<EvalRecord, 'preferred' | 'reasons' | 'errors' | 'comment'>): void {
    // Show full answers (with evidence) and who was who.
    for (const arm of ['tool', 'baseline'] as Arm[]) {
      const i = slotOf(arm)
      tabs[i].innerHTML = `${label(arm)} · ${arm === 'tool' ? 'Unstuck' : '기준선 (구절만)'}`
      panes[i].innerHTML = renderMarkdown(answers[arm])
    }
    let total = 0
    let verified = 0
    for (const li of panes[slotOf('tool')].querySelectorAll<HTMLElement>('li.evidence')) {
      total++
      const ok = checkQuote(paras, li.dataset.quote ?? '', Number(li.dataset.page)).found
      if (ok) verified++
      const st = li.querySelector<HTMLElement>('.ev-status')!
      st.textContent = ok ? '✓' : '!'
      st.className = `ev-status ${ok ? 'ok' : 'bad'}`
    }
    // Evidence and citation chips can now be clicked to check them in the paper.
    panes[slotOf('tool')].addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const el = t.closest<HTMLElement>('li.evidence') ?? t.closest<HTMLElement>('.cite')
      if (el) jumpTo(deps.reader, deps.container, Number(el.dataset.page), el.dataset.quote)
    })
    show(slotOf('tool'))
    form.innerHTML = `
      <div class="ev-reveal">A = <b>${order[0] === 'tool' ? 'Unstuck' : '기준선'}</b>, B = <b>${order[1] === 'tool' ? 'Unstuck' : '기준선'}</b> · 원문에서 확인된 인용 ${verified}/${total}</div>
      <div class="ev-q">4. Unstuck의 근거가 실제로 설명을 뒷받침하나요? <span class="muted">(근거를 눌러 원문 확인)</span></div>
      <div class="ev-choices" data-name="support">
        <button type="button" data-v="yes">예</button><button type="button" data-v="partly">부분적으로</button><button type="button" data-v="no">아니오</button><button type="button" data-v="none">근거 없음</button>
      </div>`
    form.querySelector('.ev-choices')!.addEventListener(
      'click',
      async (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button')
        if (!b) return
        b.classList.add('on')
        const rec: EvalRecord = {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          paper: deps.title(),
          page: sel.pageStart,
          passage: sel.text,
          hasMath: looksMathy(sel.text),
          imageSent,
          shownAsA,
          answers,
          latencyMs: latency,
          ...r,
          citations: { total, verified },
          citationSupport: b.dataset.v as EvalRecord['citationSupport']
        }
        const ok = await deps.store.append(rec)
        form.innerHTML = `<div class="ev-saved">${ok ? '✓ 평가를 저장했어요. 다른 구절을 선택해서 계속 평가하세요.' : '저장하지 못했어요.'}</div>`
        renderSummary(body.querySelector('.ev-summary')!, deps.store)
      },
      { once: true }
    )
  }

  return () => {
    cancelled = true
    streams.forEach((s) => s.cancel())
  }
}

/** Running totals across all saved evaluations. */
async function renderSummary(el: HTMLElement, store: EvalStore): Promise<void> {
  const all = await store.list().catch(() => [] as EvalRecord[])
  if (all.length === 0) {
    el.innerHTML = ''
    return
  }
  const n = all.length
  const tool = all.filter((r) => r.preferred === 'tool').length
  const base = all.filter((r) => r.preferred === 'baseline').length
  const tie = n - tool - base
  const cTotal = all.reduce((s, r) => s + r.citations.total, 0)
  const cOk = all.reduce((s, r) => s + r.citations.verified, 0)
  const errT = all.filter((r) => r.errors.tool).length
  const errB = all.filter((r) => r.errors.baseline).length
  const support = all.filter((r) => r.citationSupport === 'yes').length
  el.innerHTML = `
    <div class="ev-stats">
      <div class="ev-stats-title">누적 결과 · ${n}건</div>
      <div>선호: Unstuck <b>${tool}</b> · 기준선 <b>${base}</b> · 비슷함 <b>${tie}</b></div>
      <div>인용 원문 확인: <b>${cOk}/${cTotal}</b>${cTotal ? ` (${Math.round((cOk / cTotal) * 100)}%)` : ''} · 근거가 뒷받침: <b>${support}/${n}</b></div>
      <div>틀린 내용: Unstuck <b>${errT}</b> · 기준선 <b>${errB}</b></div>
      ${store.reveal ? '<button type="button" class="chip ev-open">결과 파일 열기</button>' : ''}
    </div>`
  el.querySelector('.ev-open')?.addEventListener('click', () => store.reveal?.())
}
