# Unstuck

**A PDF reader that explains the exact passage you are stuck on, using the whole paper as context.**

When reading a research paper, select the sentence, term, or equation that stops you and press
**질문하기 (Ask)**. Claude has read the entire paper, so the side panel shows:

- **쉬운 설명 (plain explanation)**: what the passage means and why it matters at this point of the paper
- **예시 (example)**: one small concrete example
- **근거 (evidence)**: 1–2 sentences quoted verbatim from the paper. Each quote is **checked
  automatically** against the PDF text (✓ found / ! not found). Clicking it jumps to that sentence and
  highlights it.

You can keep asking follow-up questions in the same thread. When it clicks, press **이해했음 ✓ (Got it)**:
the conversation is condensed into a short note and saved as a **stuck point** on that passage.
Stuck points appear as dots in the page and as a list in the panel, so you can come back to them later.

Built for CSE554 Advanced Data Mining (UNIST, Fall 2026), Assignment #2: *"AI for My Research: Build Something
You Would Actually Use."* Answers are in Korean, with technical terms kept in English.

---

## Why not just paste the passage into a chatbot?

| General chatbot | Unstuck |
|---|---|
| Sees only what you paste | Sees the **whole paper** (body, plus the appendix when the passage needs it) |
| You must say which page or section you mean | **The selection is the question**; page and paragraph are known |
| Answers float free of the source | Evidence is **quoted from the paper and verified** against the extracted text |
| Separate window | Answers appear in a **side panel next to the PDF** |
| Forgets what confused you | Keeps **stuck points and notes per paper** |

In a blind A/B test on 33 passages where I was stuck while reading MAPPO (same model, passage only vs.
Unstuck), Unstuck's answer was preferred **20 times**, the baseline's **3 times**, and they were similar
**10 times**. All **62/62** evidence quotes were found in the paper. The largest gains were on
paper-specific acronyms (e.g. "AS and FP", "GRF's"), which the passage-only baseline guessed wrongly.
Details are in the technical report.

---

## Features

**Reading**
- Library of opened papers (stored locally, no re-uploading), recent papers, drag-and-drop to open
- Word-snapped selection that follows the printed glyphs, including equations with sub/superscripts
- Trackpad pinch zoom, ⌘+ / ⌘− / ⌘0 (fit width)
- Find in the paper (⌘F) and in the side panel (⌘⇧F)

**Explaining (LLM)**
- Explanation / example / evidence for the selected passage, streamed as it is generated
- For equations, an image of the rendered region is sent too, since extracted math text is often garbled
- Follow-ups in the same conversation, plus one-click **헷갈리기 쉬운 점** (common confusions) and
  **선행 개념** (prerequisites)
- Evidence quotes verified against the PDF text; click to jump to and flash the source sentence
- Inline `[p.N ¶M]` citations are clickable too
- Math rendered with KaTeX

**Remembering**
- **Got it ✓** turns the thread into a short note (written by a smaller model, Haiku, from the conversation only)
- Stuck points saved per paper: dots in the page margin (right-click to delete), a list in the panel
- Reopening a stuck point restores the highlight, the conversation, and the note

**Evaluation mode** (⌘⇧E, auxiliary)
- Blind A/B: for each passage, the same model answers twice, once **with the paper** (Unstuck) and once
  **with the passage only** (baseline, which reproduces pasting it into a chatbot), in random order
- You rate which one helped, why, and whether either was wrong; then the sides and evidence are revealed
- Results are appended to `results.jsonl`; `scripts/eval-report.mts` summarises them

---

## Requirements

- **macOS** (developed and tested on macOS; Electron should also run on Windows and Linux, but this is untested)
- **Node.js 22.18+** (the helper scripts run TypeScript directly; the app itself needs Node 18+)
- One LLM backend:
  - **Claude Code CLI**, logged in (default). Install it from <https://docs.claude.com/en/docs/claude-code>,
    run `claude` once, and log in with `/login`. Unstuck calls it with `claude -p` and uses your Claude subscription.
  - **or** an **Anthropic API key** (see [Configuration](#configuration)).

## Installation

```bash
git clone https://github.com/<your-id>/unstuck.git
cd unstuck
npm install
```

## Running

```bash
npm run dev
```

This opens the app window. To build once and run the build instead:

```bash
npm run build && npm start
```

## Usage

1. **Open a paper**: click *Open PDF* (⌘O) or drag a PDF onto the window. It is copied into the local
   library, so next time pick it from *Library* (⌘L).
2. **Select** the passage you are stuck on (drag, or double-click a word). A **? 질문하기** button appears;
   click it or press **Enter**.
3. Read the answer in the side panel. Click an **evidence quote** or a `p.N` chip to jump to the source sentence.
4. Ask a **follow-up** in the box at the bottom, or use **헷갈리기 쉬운 점** / **선행 개념**.
5. When you understand it, press **이해했음 ✓**. A note is written and the passage gets a dot.
6. Later, click a dot (or an item in the panel's stuck-point list) to reopen it. Right-click a dot to delete it.

### Example

Try it with the paper used in the report: Yu et al., *The Surprising Effectiveness of PPO in Cooperative
Multi-Agent Games* (MAPPO), [arXiv:2103.01955](https://arxiv.org/abs/2103.01955). Download the PDF from arXiv
(papers are not included in this repository), open it, and select, for example:

- **"AS and FP"** on p.4: a passage-only chatbot guesses *False Positive / Attack Success*; Unstuck explains
  *Agent-Specific Global State* and *Feature-Pruned AS* and quotes their definition on p.8.
- **The PPO clipped objective** in Appendix A: the equation image is sent along with the text.

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open PDF / Library | ⌘O / ⌘L |
| Ask about the selection | Enter |
| Clear selection, close bars | Esc |
| Show / hide side panel | ⌘← / ⌘→ (or ⌘\\) |
| Zoom in / out / fit width | ⌘= / ⌘− / ⌘0, or pinch |
| Find in paper / in panel | ⌘F / ⌘⇧F, then ⌘G / ⌘⇧G |
| Panel text larger / smaller | ⌘⇧= / ⌘⇧− |
| Evaluation mode | ⌘⇧E |
| Preferences | ⌘, |

## Configuration

Environment variables, set before `npm run dev`:

| Variable | Default | Meaning |
|---|---|---|
| `UNSTUCK_BACKEND` | `cli` | `api` to call the Anthropic Messages API instead of the Claude CLI |
| `ANTHROPIC_API_KEY` | – | Required when `UNSTUCK_BACKEND=api` |
| `UNSTUCK_MODEL` | `sonnet` | Model for explanations (CLI alias or full model id) |
| `UNSTUCK_CLAUDE_BIN` | auto | Path to the `claude` binary if it is not found automatically |

```bash
UNSTUCK_BACKEND=api ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

Never commit your API key. It is read only from the environment.

## Where data is stored

Everything stays on your machine, under `~/Library/Application Support/unstuck/`:

| Path | Contents |
|---|---|
| `library/` | Copies of opened PDFs and `index.json` |
| `library/notes/<paper>.json` | Stuck points, conversations, and notes |
| `evaluation/results.jsonl` | Evaluation-mode ratings |
| `claude-sessions/` | Working directory for the Claude CLI (conversation sessions for follow-ups) |

The paper's text and your selection are sent to Claude (Anthropic) to generate answers.

## Helper scripts

```bash
# Explain a passage from the terminal with exactly the app's prompt
npm run try -- paper.pdf 4 "AS and FP"

# Summarise evaluation-mode results (and re-check evidence against the PDF)
node --no-warnings scripts/eval-report.mts --paper paper.pdf --csv results.csv

# Token usage of the app's call pattern (explain, follow-up, note, second passage)
node --no-warnings scripts/measure-usage.mts paper.pdf 4 "AS and FP" "GRF's"
```

The evaluation procedure is described in [docs/evaluation-protocol.md](docs/evaluation-protocol.md).

## How it works

```
 PDF ──pdf.js──► paragraphs labelled [p.N ¶M]
                 sections: body / appendix / references
                        │
 selection ─────────────┤  (+ image of the region, for math)
                        ▼
              system prompt: whole paper (body; appendix if needed; no references)
              user prompt:   passage + where it sits
                        │
                        ▼
              Claude (CLI `claude -p --resume`, or Messages API), streamed
                        │
                        ▼
              쉬운 설명 / 예시 / 근거 ──► quote checker (non-LLM): ✓ / !
                        │
          follow-ups (same session) ──► Got it ──► note (Haiku) ──► stuck point
```

| Path | Role |
|---|---|
| `src/main/llm.ts` | Swappable backend: Claude CLI (default) or Anthropic API, streamed to the renderer |
| `src/main/library.ts`, `notes.ts`, `evaluation.ts` | Local storage over IPC |
| `src/renderer/src/reader.ts` | pdf.js viewer, zoom, find |
| `src/renderer/src/lineModel.ts`, `textGeometry.ts`, `dragSelect.ts` | Glyph-aligned word selection |
| `src/renderer/src/paperText.ts` | Paragraph extraction, section labels, paper context, quote checking |
| `src/renderer/src/prompt.ts` | All prompts (tool, follow-ups, notes, baseline) |
| `src/renderer/src/explainUi.ts` | Conversation panel, citations, Got it |
| `src/renderer/src/stuckPoints.ts` | Stuck-point dots and list |
| `src/renderer/src/evaluation.ts` | Blind A/B evaluation mode |

The CLI is run with no tools, no user settings, and no MCP servers (`--tools '' --setting-sources ''
--strict-mcp-config`), so the model only reads the paper and answers. The paper is placed in the system
prompt so that follow-ups reuse the prompt cache.

## Limitations

- The model can still be wrong. Verification checks that quoted evidence exists in the paper, not that
  the explanation or the analogy built on it is correct.
- Text extraction depends on the PDF: some math symbols are lost (shown as □ to the model), and scanned
  PDFs without a text layer do not work.
- Very long papers are truncated to about 120k characters of context.
- Each answer takes a few seconds (median ~6 s) and uses your Claude subscription or API credit.
- Not yet packaged as a standalone `.app`; run it from source.

## Acknowledgements

- [Electron](https://www.electronjs.org/), [electron-vite](https://electron-vite.org/),
  [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla), [KaTeX](https://katex.org/)
- LLM: [Claude](https://www.anthropic.com/claude) (Anthropic) via the Claude Code CLI or the Messages API
- Developed with the help of Claude Code as a coding assistant
