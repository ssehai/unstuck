# Evaluation protocol: blind A/B on MAPPO

**Question.** When I am stuck on a passage of a paper I actually need to read,
does Unstuck's answer help me understand it better than pasting the same
passage into a general chatbot?

**Paper.** Yu et al., *The Surprising Effectiveness of PPO in Cooperative
Multi-Agent Games* (MAPPO, arXiv:2103.01955), read for my deep RL course
project (squad decisions under partial observability, many agents, small
compute).

## Conditions

| | Unstuck (tool) | Baseline |
|---|---|---|
| Model | same (Sonnet via Claude CLI) | same |
| Sees | whole paper (body; appendix when relevant), paragraph labels, equation image | the selected passage only |
| Answer format | 쉬운 설명 / 예시 / 근거 | 쉬운 설명 / 예시 |

Both answers are generated at the same time and shown as **A / B in random
order**. Evidence sections and `p.N` citation chips are hidden until I have
rated, because they would reveal which answer is the tool.

## Procedure

1. Open the paper in Unstuck and turn on **View → Evaluation Mode** (⌘⇧E).
2. Read normally. **Only when I am genuinely stuck**, select the passage and
   press *질문하기*. (No cherry-picking passages the tool is likely to win.)
3. Read **both** answers fully, then rate:
   1. Which one made me understand more clearly? (A / B / similar)
   2. Why? (easy wording, example, structure, hit the real confusion, fits
      the paper's context, more accurate)
   3. Did either contain something wrong?
4. After the reveal, click the tool's evidence quotes and check: do they
   actually support the explanation? (yes / partly / no / none)
5. Repeat until at least **10 passages**, ideally spread across:
   - equations (e.g. the PPO / value-loss objectives) — at least 3
   - design choices the paper recommends (value normalisation, value-function
     input, training data usage, clipping, batch size, death masking) — at least 3
   - experimental claims and results — at least 2
   - implementation details that may sit in the appendix — at least 1

## What is recorded

Each rating is appended to
`~/Library/Application Support/unstuck/evaluation/results.jsonl`
(passage, page, both answers, latency, preference, reasons, errors, the
tool's citation check). Summarise with:

```bash
node --no-warnings scripts/eval-report.mts
```

## Threats to validity (for the report)

- **n = 1, self-rated**: I am both the reader and the judge.
- **Blinding is imperfect**: answer style may still give the tool away.
- **The baseline is strong**: the model knows PPO/MAPPO from pre-training,
  so it can explain well without the paper.
- **Not a pure context ablation**: the tool also gets the equation image.
- **Selection of passages** depends on where I happen to get stuck.
