/**
 * Runs the app's figure detection (src/renderer/src/figures.ts) on a PDF from
 * the terminal and prints what it finds.
 *
 *   node --no-warnings scripts/figures-check.mts paper.pdf
 */
import { readFileSync } from 'node:fs'
import { createCanvas } from 'canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

// figures.ts renders pages into a canvas made by document.createElement.
;(globalThis as unknown as { document: unknown }).document = {
  createElement: () => createCanvas(1, 1)
}
const { extractFigures } = await import('../src/renderer/src/figures.ts')

const doc = await getDocument({ data: new Uint8Array(readFileSync(process.argv[2])), verbosity: 0 }).promise
const t = Date.now()
const figs = await extractFigures(doc as never, (label, page, why) => console.log(`  skip ${label} p.${page}: ${why}`))
for (const f of figs) {
  console.log(`${f.label.padEnd(10)} p.${String(f.page).padEnd(3)} x${f.x.toFixed(2)} y${f.y.toFixed(2)} w${f.width.toFixed(2)} h${f.height.toFixed(2)}  ${f.caption.slice(0, 60)}`)
}
console.log(`${figs.length} figures in ${doc.numPages} pages, ${Date.now() - t} ms`)

// --png <dir>: also save each figure region as an image, to check the crops.
const pngAt = process.argv.indexOf('--png')
if (pngAt > 0) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = process.argv[pngAt + 1]
  mkdirSync(dir, { recursive: true })
  for (const f of figs) {
    const page = await doc.getPage(f.page)
    const vp = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.round(f.width * vp.width), Math.round(f.height * vp.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx as never, viewport: vp, transform: [1, 0, 0, 1, -f.x * vp.width, -f.y * vp.height] }).promise
    writeFileSync(`${dir}/${f.label.replace(' ', '')}.png`, canvas.toBuffer('image/png'))
  }
  console.log(`crops saved to ${dir}`)
}
