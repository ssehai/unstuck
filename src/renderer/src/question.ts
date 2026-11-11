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
  /** PNG data URLs of the images sent with it, in the order the prompt names them. */
  imageUrls: string[]
  /** What a chatbot user would paste (evaluation baseline): which of the images go with it. */
  baseline: { text: string; imageUrls: string[] }
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
    // Every figure and equation among the places goes along, in place order.
    const imageUrls: string[] = []
    const imagesOf: number[] = []
    const pasted: string[] = []
    for (const [i, p] of sel.parts.entries()) {
      const url = await imageFor(p, reader, container)
      if (!url) continue
      imageUrls.push(url)
      imagesOf.push(i)
      if (p.figure) pasted.push(url) // a chatbot user would paste figure screenshots too
    }
    return { text: multiPrompt(parts, imagesOf), imageUrls, baseline: { text: baselineMultiPrompt(parts), imageUrls: pasted } }
  }
  const url = await imageFor(sel, reader, container)
  const imageUrls = url ? [url] : []
  if (sel.figure) {
    // For a figure, a chatbot user would paste a screenshot and the caption:
    // the baseline gets the same image, so only the paper context differs.
    return {
      text: figurePrompt(sel.figure.label, sel.figure.caption, sel.figure.page),
      imageUrls,
      baseline: { text: baselineFigurePrompt(sel.figure.caption), imageUrls }
    }
  }
  return {
    text: userPrompt(sel.text, sel.pageStart, home, homeIsInPaper),
    imageUrls,
    baseline: { text: baselineUserPrompt(sel.text), imageUrls: [] }
  }
}

/** The base64 payload of a PNG data URL, as the LLM request wants it. */
export const base64Of = (dataUrl: string): string => dataUrl.replace(/^data:image\/png;base64,/, '')
