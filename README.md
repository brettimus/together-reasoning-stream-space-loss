# Lost spaces in Together AI's streamed reasoning frames (Kimi K3, GLM 5.2)

Reproduction for a Together AI API defect: a word-separating space disappears at the
boundary between two consecutive `delta.reasoning_content` chunks in Together's own SSE
stream, producing glued words such as `Theuser` and `tellthem`. The space is already
missing on the wire — no client-side trim or transform is involved, and a streaming
consumer cannot safely repair it.

- **Endpoint:** `POST https://api.together.xyz/v1/chat/completions` (streaming)
- **Affected:** `moonshotai/Kimi-K3`, `zai-org/GLM-5.2`
- **Not affected:** `Qwen/Qwen3.7-Plus` (see the Qwen note below)
- **Defect report write-up:** https://fancyplan.club/p/9hwq917

## Results

30 streamed requests: the same two-request tool turn (`sandbox_exec` / `echo kimi`)
repeated 5 times per model. Detection is a dictionary-based seam heuristic (below).

| Model | Requests | With lost space | Rate | Original report (2026-09-05/06) |
|---|---|---|---|---|
| `moonshotai/Kimi-K3` | 10 | 7 | 70% | 7/16 (44%) |
| `zai-org/GLM-5.2` | 10 | 4 | 40% | 4/10 (40%) |
| `Qwen/Qwen3.7-Plus` | 10 | 0 | 0% | 0/10 (0%) |

Seams observed in this run, verbatim frame pairs:

| Model | prev frame | next frame | Concatenated |
|---|---|---|---|
| Kimi K3 | `"The"` | `"user wants me to run ..."` | `Theuser` |
| Kimi K3 | `"... exit code, but"` | `"since the command succeeded ..."` | `butsince` |
| Kimi K3 | `"... shell tool and"` | `"append \`; echo ..."` | `andappend` |
| Kimi K3 | `"... so exit code is 0. I can"` | `"verify quickly ..."` | `canverify` |
| GLM 5.2 | `"\` and then tell"` | `"them the exit code."` | `tellthem` |
| GLM 5.2 | `"... command and check"` | `"the exit code."` | `checkthe` |
| GLM 5.2 | `"... and then tell them"` | `"the exit code."` | `themthe` |

The loss is nondeterministic across byte-identical prompts and appears in both requests
of the tool turn (the pre-tool reasoning and the post-tool-result reasoning). It
correlates with chunk coalescing: affected boundaries are typically where a small delta
is followed by a large one, and sibling deltas in the same stream do carry leading
spaces (`" user wants..."`, `" shell command ..."`).

## Wire-level proof

`out/kimi-k3/run1-req1.sse.txt` — two consecutive SSE data lines, copied verbatim:

```
data: {"choices":[{"index":0,"delta":{"reasoning_content":"The"},...}]}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"user wants me to run `echo kimi` with the sandbox_exec tool and report the exit code."},...}]}
```

Concatenating `delta.reasoning_content` exactly as sent yields
`Theuser wants me to run...`. Nothing runs between the socket and this concatenation.

## Why a consumer cannot repair this

A streaming consumer cannot distinguish a dropped space from a legitimate intra-word
token split: `"The"` + `"user"` and `"exi"` + `"t"` are the same event on the wire.
Inserting a space on every letter-to-letter boundary would corrupt correctly split
words; inserting none preserves the defect. Only the producer knows which boundary
carried a space.

## Reproducing

Requires [Bun](https://bun.sh), a Together API key, and a system dictionary
(`/usr/share/dict/words`, present by default on macOS):

```sh
echo 'TOGETHER_AI_API_KEY=<your key>' > .env.together
bun --env-file=.env.together repro.ts
```

The script runs the 2-request tool turn 5 times per model (3 models), captures the raw
SSE lines and parsed frames under `out/<model>/`, applies the seam detector, and writes
`out/results.json`. Expect the loss in roughly 3–7 of 10 Kimi/GLM requests per run; it
does not reproduce on a fixed run.

### Detection heuristic

Scan every adjacent pair of reasoning deltas. Where the previous delta ends with a
letter and the next begins with a letter, take the trailing alphabetic run on the left
and the leading alphabetic run on the right; flag the boundary when both runs are
dictionary words (length >= 2) but their concatenation is not. This finds
`The|user`, `exit|code`, `tell|them`, `and|append`, `can|verify`, `check|the`,
`but|since`, `them|the` without false positives in these captures, and reports 0 for
Qwen.

### Qwen note (`Qwen/Qwen3.7-Plus`)

In all 10 captures Qwen sent **zero** `delta.reasoning_content` frames: all reasoning
arrived inside `delta.content`, after a bare `<think>` marker and newline as the first
content delta, with no matching closing tag anywhere in the stream. That marker appears
to be leakage of the model's raw chat template into the content channel, and may also
explain why Qwen never loses a space — its reasoning travels a different path than the
`reasoning_content` channel used by Kimi and GLM.

## Repo layout

```
repro.ts                          capture + detection script (no dependencies)
out/results.json                  summary (rates, seams, joined text)
out/<model>/run<N>-req<M>.sse.txt raw SSE lines, verbatim
out/<model>/run<N>-req<M>.json    parsed frames, letter boundaries, flagged seams
```

No API keys or authorization headers appear anywhere in the captures.
