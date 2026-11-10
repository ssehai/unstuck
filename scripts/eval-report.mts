/**
 * Summarises the blind A/B evaluation (evaluation mode) for the report.
 *
 *   node --no-warnings scripts/eval-report.mts [results.jsonl] [--csv out.csv] [--paper paper.pdf]
 *
 * --paper re-checks the tool's evidence quotes against that PDF with the
 * current checker (for records about a paper with the same file name).
 *
 * Default input: ~/Library/Application Support/unstuck/evaluation/results.jsonl
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { checkQuote, paperParagraphs } from '../src/renderer/src/paperText.ts'

type Arm = 'tool' | 'baseline'
interface Rec {
  at: string
  paper: string
  page: number
  passage: string
  hasMath: boolean
  imageSent: boolean
  shownAsA: Arm
  answers: Record<Arm, string>
  latencyMs: Record<Arm, number>
  preferred: Arm | 'tie'
  reasons: string[]
  comment: string
  errors: Record<Arm, boolean>
  citations: { total: number; verified: number }
  citationSupport: 'yes' | 'partly' | 'no' | 'none'
}

const args = process.argv.slice(2)
const csvAt = args.indexOf('--csv')
const csvOut = csvAt >= 0 ? args[csvAt + 1] : null
const paperAt = args.indexOf('--paper')
const paperPdf = paperAt >= 0 ? args[paperAt + 1] : null
const input = args.find((a, i) => !a.startsWith('--') && i !== csvAt + 1 && i !== paperAt + 1) ??
  join(homedir(), 'Library/Application Support/unstuck/evaluation/results.jsonl')

if (!existsSync(input)) {
  console.error(`No results yet: ${input}`)
  process.exit(1)
}
const recs: Rec[] = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const n = recs.length

// Optionally re-check the tool's evidence quotes with the current checker.
let rechecked = 0
if (paperPdf) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(paperPdf)), verbosity: 0 }).promise
  const paras = await paperParagraphs(doc as never)
  for (const r of recs.filter((r) => r.paper === basename(paperPdf))) {
    const quotes = [...r.answers.tool.matchAll(/^\s*[-*]\s*\[p\.\s?(\d+)(?:\s*¶\s?\d+)?\]\s*["“](.+?)["”]?\s*$/gm)]
    const verified = quotes.filter((m) => checkQuote(paras, m[2], Number(m[1])).found).length
    if (verified !== r.citations.verified || quotes.length !== r.citations.total) rechecked++
    r.citations = { total: quotes.length, verified }
  }
}
const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '–')
const count = (f: (r: Rec) => boolean, rs = recs): number => rs.filter(f).length
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0
}
/** Two-sided exact sign test p-value (ties excluded). */
function signTest(wins: number, losses: number): number {
  const m = wins + losses
  if (m === 0) return 1
  const k = Math.min(wins, losses)
  let p = 0
  let c = 1 // C(m, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) c = (c * (m - i + 1)) / i
    p += c / 2 ** m
  }
  return Math.min(1, 2 * p)
}

const fmtP = (p: number): string => (p >= 0.001 ? p.toFixed(3) : p.toExponential(1))

function prefTable(title: string, rs: Rec[]): string {
  const t = count((r) => r.preferred === 'tool', rs)
  const b = count((r) => r.preferred === 'baseline', rs)
  const s = rs.length - t - b
  return `| ${title} | ${rs.length} | ${t} (${pct(t, rs.length)}) | ${b} (${pct(b, rs.length)}) | ${s} (${pct(s, rs.length)}) |`
}

const tool = count((r) => r.preferred === 'tool')
const base = count((r) => r.preferred === 'baseline')
const cTotal = recs.reduce((s, r) => s + r.citations.total, 0)
const cOk = recs.reduce((s, r) => s + r.citations.verified, 0)
const reasons = new Map<string, number>()
for (const r of recs.filter((r) => r.preferred === 'tool')) for (const x of r.reasons) reasons.set(x, (reasons.get(x) ?? 0) + 1)
const reasonsB = new Map<string, number>()
for (const r of recs.filter((r) => r.preferred === 'baseline')) for (const x of r.reasons) reasonsB.set(x, (reasonsB.get(x) ?? 0) + 1)
const fmtReasons = (m: Map<string, number>): string =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ') || '–'

console.log(`# Blind A/B evaluation — ${n} passages
Source: ${input}
Papers: ${[...new Set(recs.map((r) => r.paper))].join(', ')}${paperPdf ? `\nEvidence re-checked against ${basename(paperPdf)} (${rechecked} record(s) changed)` : ''}

## Which answer made the passage clearer?
| Subset | n | Unstuck | Baseline | Similar |
|---|---|---|---|---|
${prefTable('All', recs)}
${prefTable('With math', recs.filter((r) => r.hasMath))}
${prefTable('Text only', recs.filter((r) => !r.hasMath))}

Exact sign test (ties excluded): Unstuck ${tool} vs baseline ${base}, two-sided p = ${fmtP(signTest(tool, base))}
(n is small and self-rated; treat as descriptive.)

## Why
- When Unstuck was preferred: ${fmtReasons(reasons)}
- When the baseline was preferred: ${fmtReasons(reasonsB)}

## Errors spotted
- Unstuck: ${count((r) => r.errors.tool)} / ${n}
- Baseline: ${count((r) => r.errors.baseline)} / ${n}

## Unstuck's evidence
- Quotes found verbatim in the paper (automatic): ${cOk} / ${cTotal} (${pct(cOk, cTotal)})
- Evidence actually supports the explanation (manual): yes ${count((r) => r.citationSupport === 'yes')}, partly ${count((r) => r.citationSupport === 'partly')}, no ${count((r) => r.citationSupport === 'no')}, none ${count((r) => r.citationSupport === 'none')}

## Latency (median)
- Unstuck: ${(median(recs.map((r) => r.latencyMs.tool)) / 1000).toFixed(1)} s
- Baseline: ${(median(recs.map((r) => r.latencyMs.baseline)) / 1000).toFixed(1)} s

## Comments
${recs.filter((r) => r.comment).map((r) => `- p.${r.page} (${r.preferred}): ${r.comment}`).join('\n') || '–'}
`)

if (csvOut) {
  const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = ['at', 'paper', 'page', 'passage', 'hasMath', 'imageSent', 'shownAsA', 'preferred', 'reasons', 'errorTool', 'errorBaseline',
    'citationsVerified', 'citationsTotal', 'citationSupport', 'latencyToolMs', 'latencyBaselineMs', 'comment']
  const rows = recs.map((r) => [r.at, r.paper, r.page, r.passage, r.hasMath, r.imageSent, r.shownAsA, r.preferred, r.reasons.join('; '),
    r.errors.tool, r.errors.baseline, r.citations.verified, r.citations.total, r.citationSupport, r.latencyMs.tool, r.latencyMs.baseline, r.comment].map(esc).join(','))
  writeFileSync(csvOut, [head.join(','), ...rows].join('\n') + '\n')
  console.log(`CSV written to ${csvOut}`)
}
