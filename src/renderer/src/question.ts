/**
 * Turns a selection into the first question: the prompt text and, when it
 * helps, an image (a clicked figure, or the block around an equation, whose
 * extracted text is garbled). Shared by the normal flow and evaluation mode.
 */
import { findCaptureRegion, looksMathy } from './capture'
import type { Paragraph } from './paperText'
import { baselineFigurePrompt, baselineMultiPrompt, baselineUserPrompt, figurePrompt, multiPrompt, userPrompt } from './prompt'
import type { Reader } from './reader'
import type { StuckSelection } from './selection'

export interface Question {
  /** Prompt for Unstuck. */
  text: string
  /** PNG data URL of the image sent with it, if any. */
  imageUrl?: string
  /** What a chatbot user would paste (evaluation baseline). */
  baseline: { text: string; withImage: boolean }
}

/** The image for one selection: the figure itself, or the block around an equation. */
async function imageFor(sel: StuckSelection, reader: Reader, container: HTMLElement): Promise<string | null> {
  if (sel.figure) return (await reader.renderRegion(sel.figure.page, sel.figure, 2.5))?.dataUrl ?? null
  if (sel.range && looksMathy(sel.text)) {
    const region = findCaptureRegion(sel.range, container)
    return region ? ((await reader.renderRegion(region.page, region))?.dataUrl ?? null) : null
  }
  return null
}

export async function buildQuestion(
  sel: StuckSelection,
  reader: Reader,
  container: HTMLElement,
  home: Paragraph | null,
  homeIsInPaper: boolean
): Promise<Question> {
  if (sel.parts && sel.parts.length > 1) {
    const parts = sel.parts.map((p) => ({ text: p.text, page: p.pageStart, figure: p.figure?.label }))
    // One image per request: the first figure, else the first equation.
    const order = [...sel.parts.keys()].sort((a, b) => Number(!sel.parts![a].figure) - Number(!sel.parts![b].figure))
    for (const i of order) {
      const imageUrl = await imageFor(sel.parts[i], reader, container)
      if (imageUrl) {
        return { text: multiPrompt(parts, i), imageUrl, baseline: { text: baselineMultiPrompt(parts), withImage: !!sel.parts[i].figure } }
      }
    }
    return { text: multiPrompt(parts), baseline: { text: baselineMultiPrompt(parts), withImage: false } }
  }
  const imageUrl = (await imageFor(sel, reader, container)) ?? undefined
  if (sel.figure) {
    // For a figure, a chatbot user would paste a screenshot and the caption:
    // the baseline gets the same image, so only the paper context differs.
    return {
      text: figurePrompt(sel.figure.label, sel.figure.caption, sel.figure.page),
      imageUrl,
      baseline: { text: baselineFigurePrompt(sel.figure.caption), withImage: true }
    }
  }
  return {
    text: userPrompt(sel.text, sel.pageStart, home, homeIsInPaper),
    imageUrl,
    baseline: { text: baselineUserPrompt(sel.text), withImage: false }
  }
}

/** The base64 payload of a PNG data URL, as the LLM request wants it. */
export const base64Of = (dataUrl?: string): string | undefined => dataUrl?.replace(/^data:image\/png;base64,/, '')
