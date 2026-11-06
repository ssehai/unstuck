/**
 * Measures token usage of the app's call pattern on one paper:
 *   1) explain A   2) follow-up on A (same session)   3) "Got it" note   4) explain B (new session)
 *
 *   node --no-warnings scripts/measure-usage.mts <paper.pdf> <page> "<passage A>" "<passage B>"
 *
 * Prints input / cache-write / cache-read / output tokens for each call.
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { formatPaper, isSent, needsAppendix, normalizeForMatch, paperParagraphs } from '../src/renderer/src/paperText.ts'
import { followUpPrompt, NOTE_MODEL, NOTE_SYSTEM, notePrompt, systemPrompt, userPrompt } from '../src/renderer/src/prompt.ts'

const [pdf, pageArg, a, b] = process.argv.slice(2)
if (!pdf || !pageArg || !a || !b) {
  console.error('usage: node --no-warnings scripts/measure-usage.mts <paper.pdf> <page> "<passage A>" "<passage B>"')
  process.exit(1)
}
const page = Number(pageArg)
const model = process.env['UNSTUCK_MODEL'] || 'sonnet'
let lastReply = ''
const doc = await getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise
const paras = await paperParagraphs(doc as never)
const homeOf = (t: string) => paras.find((p) => normalizeForMatch(p.text).includes(normalizeForMatch(t).slice(0, 60))) ?? null
const system = systemPrompt(pdf.split('/').pop()!, formatPaper(paras, { appendix: needsAppendix(paras, page, a) }))
console.log(`system prompt: ${system.length} chars, model: ${model}\n`)

function call(label: string, text: string, sid?: string, opts: { system?: string; model?: string; ephemeral?: boolean } = {}): Promise<string> {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', opts.model ?? model,
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--system-prompt', opts.system ?? system]
  if (sid) args.push('--resume', sid)
  if (opts.ephemeral) args.push('--no-session-persistence')

  const c = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  c.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
  c.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  return new Promise((resolve) =>
    c.on('close', () => {
      const res = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.type === 'result')
      const u = res.usage
      console.log(
        `${label.padEnd(20)} input=${u.input_tokens}  cache_write=${u.cache_creation_input_tokens}  cache_read=${u.cache_read_input_tokens}  output=${u.output_tokens}  ` +
          `(API-equivalent $${(res.total_cost_usd ?? 0).toFixed(4)}, ${(res.duration_ms / 1000).toFixed(1)}s)`
      )
      // Per-model breakdown (the CLI may make extra calls of its own).
      for (const [m, mu] of Object.entries<any>(res.modelUsage ?? {})) {
        console.log(`    ${m}: in=${mu.inputTokens} cw=${mu.cacheCreationInputTokens} cr=${mu.cacheReadInputTokens} out=${mu.outputTokens} $${mu.costUSD?.toFixed(4)}`)
      }
      lastReply = res.result
      resolve(res.session_id)
    })
  )
}

const hA = homeOf(a)
const hB = homeOf(b)
const s1 = await call('1) explain A', userPrompt(a, page, hA, !!hA && isSent(hA, { appendix: false })))
const r1 = lastReply
await call('2) follow-up on A', followUpPrompt('prerequisites'), s1)
const r2 = lastReply
const turns = [
  { role: 'user' as const, display: a, text: '' },
  { role: 'assistant' as const, display: r1, text: r1 },
  { role: 'user' as const, display: '선행 개념', text: '' },
  { role: 'assistant' as const, display: r2, text: r2 }
]
await call(`3) note (${NOTE_MODEL})`, notePrompt(a, turns), undefined, { system: NOTE_SYSTEM, model: NOTE_MODEL, ephemeral: true })
await call('4) explain B (new)', userPrompt(b, page, hB, !!hB && isSent(hB, { appendix: false })))
