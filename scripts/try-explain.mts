/**
 * Runs the same explanation pipeline as the app, from the terminal.
 *
 *   node scripts/try-explain.mts <paper.pdf> <page> "<selected passage>"
 *
 * Useful for testing prompts, and for the evaluation in the report.
 * Requires Node 22.18+ (runs TypeScript directly) and a logged-in `claude` CLI.
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { checkQuote, formatPaper, normalizeForMatch, paperParagraphs } from '../src/renderer/src/paperText.ts'
import { systemPrompt, userPrompt } from '../src/renderer/src/prompt.ts'

const [pdfPath, pageArg, selected] = process.argv.slice(2)
if (!pdfPath || !pageArg || !selected) {
  console.error('usage: node scripts/try-explain.mts <paper.pdf> <page> "<selected passage>"')
  process.exit(1)
}
const page = Number(pageArg)
const model = process.env['UNSTUCK_MODEL'] || 'sonnet'

const doc = await getDocument({ data: new Uint8Array(readFileSync(pdfPath)), useSystemFonts: true }).promise
const paras = await paperParagraphs(doc as never)
const probe = normalizeForMatch(selected).slice(0, 60)
const home = paras.find((p) => normalizeForMatch(p.text).includes(probe)) ?? null
const system = systemPrompt(pdfPath.split('/').pop()!, formatPaper(paras, page))
const text = userPrompt(selected, page, home)
console.error(`paragraphs: ${paras.length}, prompt: ${system.length} chars, home: ${home ? `p.${home.page} ¶${home.index}` : 'not found'}\n`)

const started = Date.now()
let firstToken = 0
let full = ''
const child = spawn(
  'claude',
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt', system],
  { stdio: ['pipe', 'pipe', 'inherit'] }
)
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
      if (!firstToken) firstToken = Date.now()
      full += msg.event.delta.text
      process.stdout.write(msg.event.delta.text)
    } else if (msg.type === 'result' && msg.is_error) {
      console.error('\nERROR:', msg.result)
    }
  }
})
child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
await new Promise((r) => child.on('close', r))

console.log('\n\n--- evidence check ---')
for (const m of full.matchAll(/\[p\.\s?(\d+)(?:\s*¶\s?(\d+))?\]\s*["“](.+?)["”]/g)) {
  const c = checkQuote(paras, m[3], Number(m[1]))
  console.log(`${c.found ? 'OK ' : 'BAD'} [p.${m[1]}${m[2] ? ' ¶' + m[2] : ''}] ${m[3].slice(0, 70)}${c.found && c.page !== Number(m[1]) ? `  (found on p.${c.page})` : ''}`)
}
console.log(`time to first token: ${((firstToken - started) / 1000).toFixed(1)}s, total: ${((Date.now() - started) / 1000).toFixed(1)}s`)
