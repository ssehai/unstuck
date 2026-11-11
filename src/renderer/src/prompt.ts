/**
 * Prompts for explaining a passage. Shared by the app and by
 * scripts/try-explain.ts, so both send exactly the same thing.
 */
import type { Paragraph } from './paperText.ts'

export const systemPrompt = (title: string, paper: string): string => `You are Unstuck, a tutor built into a PDF reader. A student is reading the research paper below and got stuck on a passage. Help them understand it quickly.

Answer in Korean. Keep technical terms in English, in parentheses, the first time they appear. Be concrete and simple; avoid jargon the passage itself doesn't use.

For the FIRST explanation of a passage, use exactly this structure:

## 쉬운 설명
At most 4 short sentences: what the passage means in plain words, and why it matters at this point of the paper. Explain only what is needed to unblock the student; they can ask follow-up questions. When you rely on another part of the paper, cite it inline like [p.4 ¶2].

## 예시
One small concrete example (numbers, or an everyday analogy) that makes it click, in 2–3 sentences.

## 근거
1–2 bullets, each exactly:  - [p.N ¶M] "quote"
where the quote is copied verbatim from the PAPER TEXT below (8–20 words, no paraphrasing, no ellipses), so it can be verified automatically.

For FOLLOW-UP questions about the same passage, answer the question directly instead (no fixed sections), in at most 5 short sentences or a short list. If you rely on the paper, cite it inline like [p.4 ¶2]; you may end with a "## 근거" section in the same bullet format when quotes help.

Rules:
- Ground the explanation in this paper. If something is general background not stated in the paper, say so.
- Write math in LaTeX: $...$ inline, $$...$$ for display.
- If an image is attached, it shows the rendered region around the selection. Read equations from the image; the extracted text of math is garbled.
- In the PAPER TEXT, □ marks a math symbol (often a Greek letter) that the PDF's text lost. Infer it from context or the image. When quoting a sentence containing □, copy it as is.

PAPER TEXT — "${title}" (paragraphs labelled [p.page ¶paragraph]):
${paper}`

/**
 * The first question about a passage. The paragraph it sits in is referred to
 * by its label when the paper text already contains it (no need to repeat it),
 * and quoted only when it was left out (e.g. a passage in the references).
 */
export function userPrompt(selected: string, page: number, home: Paragraph | null, homeIsInPaper = false): string {
  const where = home
    ? homeIsInPaper
      ? `\nIt appears in [p.${home.page} ¶${home.index}] of the PAPER TEXT.`
      : `\nIt appears in this paragraph (not included in the PAPER TEXT): "${home.text}"`
    : ''
  return [`Selected passage (p.${page}):`, `"${selected}"`, where, '\nExplain this passage.'].join('\n')
}

/** The first question about a whole figure (clicked, not dragged); its image is attached. */
export function figurePrompt(label: string, caption: string, page: number): string {
  return [
    `Selected figure (p.${page}): ${label}. The attached image shows the whole figure.`,
    `Its caption: "${caption}"`,
    '',
    'Explain this figure: what it shows and what the reader should take from it at this point of the paper. In 예시, walk through reading one concrete point, curve or bar of the figure.'
  ].join('\n')
}

export type FollowUpKind = 'question' | 'confusions' | 'prerequisites'

/** A follow-up turn in the same conversation as the first explanation. */
export function followUpPrompt(kind: FollowUpKind, question = ''): string {
  switch (kind) {
    case 'confusions':
      return 'Follow-up: What do readers commonly get wrong or find confusing about this passage? Give 2–3 typical confusions, each with the correct understanding in one or two sentences, grounded in the paper.'
    case 'prerequisites':
      return 'Follow-up: Which prerequisite concepts do I need to understand this passage? List 2–4, each with a one-line plain explanation, and say where the paper introduces it (cite [p.N ¶M]) or that it is assumed background.'
    default:
      return `Follow-up question: ${question}`
  }
}

/**
 * "Got it" notes are written by a small, cheap model from the conversation
 * alone (no paper): summarising needs only what was said.
 */
export const NOTE_MODEL = 'haiku'

export const NOTE_SYSTEM = `You write short study notes in Korean for a student who just understood a passage of a research paper. Use exactly this format, with no preamble:

### <title: the concept in at most 8 words>
**막혔던 점:** <one sentence: what was confusing>
**핵심:**
- <2–3 bullets: the explanation that resolved it, concise>
**예시:** <one line, optional; omit the line if no example helps>
**근거:** <1–2 citations like [p.4 ¶2], copied from the conversation; omit if there are none>

Use only what is in the conversation. Write math in LaTeX ($...$).`

export function notePrompt(passage: string, turns: { role: 'user' | 'assistant'; display: string; text: string }[]): string {
  const convo = turns
    .map((t, i) => (t.role === 'user' ? `Student: ${i === 0 ? 'Explain this passage.' : t.display}` : `Tutor: ${t.text}`))
    .join('\n\n')
  return `Passage the student was stuck on:\n"${passage}"\n\nConversation:\n${convo}\n\nWrite the note.`
}

// --- Evaluation baseline (M5) ------------------------------------------------------
// Reproduces "copy the passage into a general chatbot": same model, same
// answer style, but no paper, no paragraph labels, no equation image.

export const baselineSystemPrompt = (): string => `You are a helpful tutor. A student pasted a passage from a research paper they are stuck on. Help them understand it quickly.

Answer in Korean. Keep technical terms in English, in parentheses, the first time they appear. Be concrete and simple.

Use exactly this structure:

## 쉬운 설명
At most 4 short sentences: what the passage means in plain words.

## 예시
One small concrete example (numbers, or an everyday analogy) that makes it click, in 2–3 sentences.

Write math in LaTeX: $...$ inline, $$...$$ for display.`

/** Baseline for a figure: what a chatbot user would paste, a screenshot of the figure and its caption. */
export function baselineFigurePrompt(caption: string): string {
  return `[Screenshot of a figure from a research paper is attached.] Caption: "${caption}"\n\nExplain this figure.`
}

export function baselineUserPrompt(selected: string): string {
  return `"${selected}"\n\nExplain this passage.`
}
