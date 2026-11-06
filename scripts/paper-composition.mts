/**
 * How the paper text sent to the model is made up: body, references,
 * appendix, and short fragments (equation pieces, page numbers, headers).
 *
 *   node --no-warnings scripts/paper-composition.mts <paper.pdf>
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { formatPaper, paperParagraphs } from '../src/renderer/src/paperText.ts'

const pdf = process.argv[2]
if (!pdf) {
  console.error('usage: node --no-warnings scripts/paper-composition.mts <paper.pdf>')
  process.exit(1)
}
const doc = await getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise
const paras = await paperParagraphs(doc as never)
const total = paras.reduce((n, p) => n + `[p.${p.page} ¶${p.index}] `.length + p.text.length + 1, 0)
const sentNoApp = formatPaper(paras, { appendix: false }).length
const sentApp = formatPaper(paras, { appendix: true }).length

const refIdx = paras.findIndex((p) => /^(references|bibliography)\b/i.test(p.text.trim()))
const appIdx = paras.findIndex((p, i) => i > refIdx && refIdx >= 0 && /^(appendix|[A-H]\s+[A-Z][a-z])/.test(p.text.trim()))
const len = (ps: typeof paras): number => ps.reduce((s, p) => s + `[p.${p.page} ¶${p.index}] `.length + p.text.length + 1, 0)

const body = refIdx >= 0 ? paras.slice(0, refIdx) : paras
const refs = refIdx >= 0 ? paras.slice(refIdx, appIdx > 0 ? appIdx : undefined) : []
const appendix = appIdx > 0 ? paras.slice(appIdx) : []
const tiny = paras.filter((p) => p.text.length < 25)
const labels = paras.reduce((s, p) => s + `[p.${p.page} ¶${p.index}] `.length, 0)

const pct = (n: number): string => `${((n / total) * 100).toFixed(0)}%`
console.log(`pages: ${doc.numPages}, paragraphs: ${paras.length}, total: ${total} chars (≈${Math.round(total / 2.4)} tokens)`)
console.log(`body:        ${len(body)} chars  ${pct(len(body))}`)
console.log(`references:  ${len(refs)} chars  ${pct(len(refs))}${refIdx >= 0 ? `  (from p.${paras[refIdx].page})` : '  (not found)'}`)
console.log(`appendix:    ${len(appendix)} chars  ${pct(len(appendix))}${appIdx > 0 ? `  (from p.${paras[appIdx].page}: "${paras[appIdx].text.slice(0, 40)}")` : ''}`)
console.log(`labels [p.N ¶M]: ${labels} chars  ${pct(labels)}`)
console.log(`tiny paragraphs (<25 chars): ${tiny.length}, ${len(tiny)} chars  ${pct(len(tiny))}  e.g. ${tiny.slice(0, 8).map((p) => JSON.stringify(p.text)).join(' ')}`)
console.log(`sections (labelled): body ${paras.filter((p) => p.section === 'body').length}, references ${paras.filter((p) => p.section === 'references').length}, appendix ${paras.filter((p) => p.section === 'appendix').length} paragraphs`)
console.log(`sent now: ${sentNoApp} chars without appendix (${pct(sentNoApp)}), ${sentApp} with appendix (${pct(sentApp)})`)
