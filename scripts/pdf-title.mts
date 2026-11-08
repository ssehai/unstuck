/**
 * Prints the first lines of PDFs (to identify papers).
 *   node --no-warnings scripts/pdf-title.mts <a.pdf> [b.pdf ...]
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

for (const f of process.argv.slice(2)) {
  try {
    const doc = await getDocument({ data: new Uint8Array(readFileSync(f)), verbosity: 0 }).promise
    const page = await doc.getPage(1)
    const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ')
    console.log(`${f}\n  pages=${doc.numPages}  ${text.slice(0, 220)}\n`)
  } catch (e) {
    console.log(`${f}\n  (could not read: ${(e as Error).message})\n`)
  }
}
