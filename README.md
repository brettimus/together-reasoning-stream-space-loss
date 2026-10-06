# Lost spaces in Together AI's streamed reasoning frames (Kimi K3, GLM 5.2)

Reproduction for a Together AI API defect: a space between two words goes missing at the
boundary between two consecutive `delta.reasoning_content` chunks in Together's own SSE
stream, which glues words together (`reportthe`, `themthe`). The space is already missing
on the wire, before any client code runs, and a streaming consumer cannot reliably fix
it.

- Endpoint: `POST https://api.together.xyz/v1/chat/completions` (streaming)
- Affected: `moonshotai/Kimi-K3`, `zai-org/GLM-5.2`
- Not affected: `Qwen/Qwen3.7-Plus`
- Defect report write-up: https://fancyplan.club/p/9hwq917

## Results

Re-run on **2026-10-06**: the bug still reproduces. The captures in `out/` for Kimi K3
and GLM 5.2 are from this run (20 streamed requests: the same two-request tool turn,
`sandbox_exec` / `echo kimi`, repeated 5 times per model). Detection is a
dictionary-based seam heuristic (below).

| Model | Requests | With lost space (2026-10-06) | Rate | Original report (2026-09-05/06) |
|---|---|---|---|---|
| `moonshotai/Kimi-K3` | 10 | 6 | 60% | 7/16 (44%) |
| `zai-org/GLM-5.2` | 10 | 7 (8 on manual check) | 70% (80%) | 4/10 (40%) |
| `Qwen/Qwen3.7-Plus` | 10 | 0 | 0% | 0/10 (0%) |

The Qwen row and the `out/qwen3.7-plus/` captures are from the earlier run
(2026-09-08). On 2026-10-06 every Qwen request returned HTTP 403
`third_party_data_sharing_blocked` ("This model requires third-party data sharing to be
enabled for your organization."), which is an account setting on our side, so the
control could not be re-run. Each entry in `out/results.json` has a `date` field
that says which run it came from.

An earlier re-run on 2026-09-08 gave Kimi K3 7/10 and GLM 5.2 4/10. Those captures
were replaced by the 2026-10-06 ones and are in the git history (commit `dd91432`).

Seams in the 2026-10-06 run. `...` marks where a long frame is shortened; the rest is
verbatim:

| Model | File | prev frame | next frame | Concatenated |
|---|---|---|---|---|
| Kimi K3 | `kimi-k3/run1-req2` | `", let me run it again with an explicit echo"` | `"of the exit code to be sure."` | `echoof` |
| Kimi K3 | `kimi-k3/run2-req1` | `"... Let me run the command"` | `"and capture the exit code."` | `commandand` |
| Kimi K3 | `kimi-k3/run2-req2` | `"... Let me try running it again"` | `"to verify the exit code more explicitly."` | `againto` |
| Kimi K3 | `kimi-k3/run3-req1` | `` " user wants me to run `echo kimi` and report" `` | `"the exit code."` | `reportthe` |
| Kimi K3 | `kimi-k3/run4-req1` | `` " user wants me to run `echo kimi` and report" `` | `"the exit code. Let me do that."` | `reportthe` |
| Kimi K3 | `kimi-k3/run5-req2` | `"... If echo succeeds exit code 0. But"` | `"to be safe, run again maybe."` | `Butto` |
| GLM 5.2 | `glm-5.2/run1-req1` | `` "echo kimi` and report" `` | `"the exit code."` | `reportthe` |
| GLM 5.2 | `glm-5.2/run1-req2` | `" always succeeds, the exit code"` | `"is 0."` | `codeis` |
| GLM 5.2 | `glm-5.2/run2-req1` | `` "` and then tell them" `` | `"the exit code."` | `themthe` |
| GLM 5.2 | `glm-5.2/run3-req1` | `` "` and then report" `` | `"the exit code."` | `reportthe` |
| GLM 5.2 | `glm-5.2/run3-req2` | `` "` returns exit" `` | `"code 0."` | `exitcode` |
| GLM 5.2 | `glm-5.2/run4-req1` | `" command and capture"` | `"the exit code."` | `capturethe` |
| GLM 5.2 | `glm-5.2/run4-req2` | `" clearly captures"` | `"the exit code."` | `capturesthe` (missed by detector) |
| GLM 5.2 | `glm-5.2/run5-req1` | `` "` and then tell them" `` | `"the exit code."` | `themthe` |

File paths are relative to `out/`; each has a `.sse.txt` (raw) and `.json` (parsed).

The loss varies between byte-identical prompts. It shows up in both requests of the tool
turn (the reasoning before the tool call and the reasoning after the tool result). It
lines up with chunk coalescing: in this run, the affected boundaries are mostly a
multi-word delta ending on a word, followed by a delta with no leading space
(`"the exit code."` is the most common next frame). Other deltas in the same stream do
have leading spaces (`" user wants..."`, `" shell command ..."`).

## Wire capture

Lines 2-4 of `out/kimi-k3/run3-req1.sse.txt`, verbatim:

```
data: {"id":"chatcmpl-01a11091082c76f0a147cc97","object":"chat.completion.chunk","created":1791279302,"model":"moonshotai/Kimi-K3","system_fingerprint":"default","choices":[{"index":0,"delta":{"reasoning_content":"The"},"logprobs":null,"finish_reason":null}]}
data: {"id":"chatcmpl-01a11091082c76f0a147cc97","object":"chat.completion.chunk","created":1791279302,"model":"moonshotai/Kimi-K3","system_fingerprint":"default","choices":[{"index":0,"delta":{"reasoning_content":" user wants me to run `echo kimi` and report"},"logprobs":null,"finish_reason":null}]}
data: {"id":"chatcmpl-01a11091082c76f0a147cc97","object":"chat.completion.chunk","created":1791279302,"model":"moonshotai/Kimi-K3","system_fingerprint":"default","choices":[{"index":0,"delta":{"reasoning_content":"the exit code."},"logprobs":null,"finish_reason":null}]}
```

Concatenating `delta.reasoning_content` exactly as sent yields
``The user wants me to run `echo kimi` and reportthe exit code.`` The second frame
carries its leading space (`" user"`); the third does not. No code runs between the
socket and this concatenation.

A GLM example of the same defect: `out/glm-5.2/run2-req1.sse.txt` lines 5-6,
`` "` and then tell them" `` + `"the exit code."` gives `themthe`.

## Why a client can't fix this

A streaming consumer cannot tell a dropped space from a normal split inside a word:
`"The"` + `"user"` and `"exi"` + `"t"` look the same on the wire. Adding a space at every
letter-to-letter boundary would break words that were split correctly; adding none
leaves the bug. Only the server knows which boundary had a space.

## Reproducing

You need [Bun](https://bun.sh), a Together API key, and a system dictionary
(`/usr/share/dict/words`, which macOS ships with):

```sh
echo 'TOGETHER_AI_API_KEY=<your key>' > .env.together
bun --env-file=.env.together repro.ts
```

`Qwen/Qwen3.7-Plus` returns HTTP 403 `third_party_data_sharing_blocked` unless
third-party data sharing is enabled for the Together organization. If you get that error, skip Qwen
so the committed Qwen captures are not replaced with 403 errors:

```sh
MODELS=kimi-k3,glm-5.2 bun --env-file=.env.together repro.ts
```

`out/results.json` keeps the entries for models that were skipped.

The script runs the 2-request tool turn 5 times per model (3 models), saves the raw
SSE lines and parsed frames under `out/<model>/`, runs the seam detector, and writes
`out/results.json`. Expect the loss in roughly 4–8 of 10 Kimi/GLM requests per run; it
does not reproduce on a fixed run.

### How the detector works

Check every adjacent pair of reasoning deltas. If the previous delta ends with a letter
and the next one starts with a letter, take the trailing run of letters on the left and
the leading run of letters on the right. Flag the boundary when both runs are dictionary
words (length >= 2) but their concatenation is not. In the 2026-10-06 captures it flags
13 seams (e.g. `report|the`, `them|the`, `exit|code`, `command|and`, `But|to`) with no
false positives, and it reports 0 for Qwen. It misses seams with inflected words that
are not in the dictionary: `captures|the` in `glm-5.2/run4-req2` is a real lost space,
but `/usr/share/dict/words` has no `captures`.

### Qwen (`Qwen/Qwen3.7-Plus`)

In all 10 captures (2026-09-08 run) Qwen sent zero `delta.reasoning_content` frames. Its
reasoning arrived in `delta.content`, after a bare `<think>` marker and newline as the
first content delta, and no closing tag appears in the stream. The marker looks like part of
the model's raw chat template showing up in the content channel. Qwen may never lose a
space because its reasoning does not use the `reasoning_content` channel that Kimi and
GLM use.

## Files

```
repro.ts                          capture + detection script (no dependencies)
out/results.json                  summary (rates, seams, joined text)
out/<model>/run<N>-req<M>.sse.txt raw SSE lines, verbatim
out/<model>/run<N>-req<M>.json    parsed frames, letter boundaries, flagged seams
```

No API keys or authorization headers appear anywhere in the captures.
