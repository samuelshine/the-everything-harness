# Compaction eval

Checks ADR-0020: can a model finish a task that outgrows its context window, and keep facts from before each compaction?

```bash
bun evals/compaction/run.ts --model ollama:gemma4:e4b --runs 5 [--arms compact,off,wide] [--out name]
```

**Task.** Read `config.py` (a secret), then six ~6 kB modules one at a time, each ending in a `TAG` line, then write `answer.txt` with the secret and the six tags in order. The secret and tags are drawn fresh for each run. With a 12k window the early files must be compacted away before the end, so a pass needs the secret and early tags to survive in the summary.

**Arms.**

| Arm | Window | Auto-compact |
|---|---|---|
| `compact` | 12,288 | on (default) |
| `off` | 12,288 | off |
| `wide` | 65,536 | on, never needed: the control for the task itself |

## Results, 2026-11-11 (gemma4:e4b, MacBook, 24 GiB)

`results/compaction-2026-11-11.json`, 5 runs per arm.

| Arm | Passed | Secret right | Tags right (of 6) | Compactions per run | Seconds per run |
|---|---|---|---|---|---|
| compact | 5/5 | 5/5 | 6.0 | 2.2 | 107 |
| off | 0/5 | 0/5 | 0.0 | 0 | 51 |
| wide | 5/5 | 5/5 | 6.0 | 0 | 58 |

- With compaction, the 12k window does as well as the 64k one: every fact from before two or three compactions survived.
- Without it, no run wrote a correct `answer.txt`: runs stopped at the window (one reply cut off at `max_tokens`, one refused as too long) or ended without the answer.
- Compaction costs time: about 1.8× the wide run, for the summary calls and the re-reads.

**Limits.** One model, one task, 5 runs per arm. The facts here are short strings the deterministic part of the summary does not carry, so they rely on the model's summary; tasks whose state is code edits, and weaker models, may do worse.
