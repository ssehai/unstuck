/**
 * Renderer-side LLM client. In Electron it talks to the main process
 * (src/main/llm.ts). In a plain browser (Vite dev page) it uses a mock that
 * streams a canned answer, so the UI can be developed without a model.
 */

export interface ExplainRequest {
  system: string
  text: string
  /** base64 PNGs, in the order the prompt refers to them. */
  images?: string[]
  sessionId?: string
  /** Model override, e.g. 'haiku' for cheap summaries. */
  model?: string
  /** One-off request: don't keep a session for it. */
  ephemeral?: boolean
}

export interface ExplainResult {
  text: string
  sessionId: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly auth = false
  ) {
    super(message)
  }
}

type LlmEvent =
  | { id: string; kind: 'delta'; text: string }
  | { id: string; kind: 'done'; sessionId: string; text: string }
  | { id: string; kind: 'error'; message: string; auth?: boolean }

export interface LlmBridge {
  explain(req: ExplainRequest & { id: string }): Promise<boolean>
  cancel(id: string): Promise<boolean>
  onEvent(cb: (ev: LlmEvent) => void): () => void
}

export interface Streaming {
  result: Promise<ExplainResult>
  cancel(): void
}

/** Starts a request; `onDelta` receives the text as it streams in. */
export function explain(req: ExplainRequest, onDelta: (full: string) => void): Streaming {
  const bridge = window.unstuckApi?.llm ?? mockBridge
  const id = crypto.randomUUID()
  let full = ''
  let off = (): void => undefined
  let rejectFn: (e: Error) => void = () => undefined

  const result = new Promise<ExplainResult>((resolve, reject) => {
    rejectFn = reject
    off = bridge.onEvent((ev) => {
      if (ev.id !== id) return
      if (ev.kind === 'delta') {
        full += ev.text
        onDelta(full)
      } else if (ev.kind === 'done') {
        off()
        resolve({ text: full || ev.text, sessionId: ev.sessionId })
      } else {
        off()
        reject(new LlmError(ev.message, ev.auth))
      }
    })
    bridge.explain({ ...req, id }).catch((err) => {
      off()
      reject(err)
    })
  })

  return {
    result,
    cancel: () => {
      off()
      bridge.cancel(id)
      rejectFn(new LlmError('cancelled'))
    }
  }
}

// --- Mock for browser development ------------------------------------------------

const mockListeners = new Set<(ev: LlmEvent) => void>()
const mockTimers = new Map<string, number>()

const mockBridge: LlmBridge = {
  async explain(req) {
    // Quote the selection itself as evidence so citation checking works.
    const quote = /Selected passage[^\n]*\n"([^"]{1,140})/.exec(req.text)?.[1] ?? ''
    const page = /\(p\.(\d+)\)/.exec(req.text)?.[1] ?? '1'
    const followUp = /^Follow-up/.test(req.text)
    const note = /Write the note\.$/.test(req.text)
    const answer = note
      ? '### 가짜 노트: 행동 정규화\n**막혔던 점:** 왜 정책을 behavior policy에 가깝게 두는지\n**핵심:**\n- 데이터 밖 행동의 Q값은 부풀려지기 쉬워요\n- 그래서 $D(\\pi, \\pi_b)$ 벌점을 줘요\n**근거:** [p.4 ¶6]'
      : followUp
      ? `(개발용 가짜 응답) 이어서 물어본 내용: **${req.text.slice(0, 60)}**\n\n- 같은 세션에서 이어지는 답변이에요 [p.${/p\.(\d+)/.exec(req.text)?.[1] ?? '1'}].\n- 수식 예: $\\pi_\\theta(a|s)$`
      : [
      '## 쉬운 설명',
      '(개발용 가짜 응답이에요. Electron 앱에서는 Claude가 실제로 답해요.) 이 부분은 **가치 함수**를 학습할 때',
      '목표값 $y = r + \\gamma \\bar Q(s\', a\')$ 과 현재 예측 $Q_\\psi(s,a)$ 의 차이를 줄인다는 뜻이에요 [p.' + page + '].',
      '',
      '## 예시',
      '보상 $r=1$, $\\gamma=0.9$, 다음 상태의 목표 Q가 $10$이면 목표값은 $1 + 0.9 \\times 10 = 10$ 이에요.',
      '',
      '## 근거',
      `- [p.${page}] "${quote}"`,
      `- [p.${page}] "this sentence does not exist in the paper"`
    ].join('\n')
    let i = 0
    const timer = window.setInterval(() => {
      const chunk = answer.slice(i, i + 12)
      i += 12
      if (chunk) mockListeners.forEach((cb) => cb({ id: req.id, kind: 'delta', text: chunk }))
      if (i >= answer.length) {
        clearInterval(timer)
        mockListeners.forEach((cb) => cb({ id: req.id, kind: 'done', sessionId: 'mock', text: answer }))
      }
    }, 25)
    mockTimers.set(req.id, timer)
    return true
  },
  async cancel(id) {
    clearInterval(mockTimers.get(id))
    return true
  },
  onEvent(cb) {
    mockListeners.add(cb)
    return () => mockListeners.delete(cb)
  }
}
