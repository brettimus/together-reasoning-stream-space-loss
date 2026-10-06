import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.together.xyz/v1/chat/completions";
const KEY = process.env.TOGETHER_AI_API_KEY;
if (!KEY) throw new Error("TOGETHER_AI_API_KEY not set (pass --env-file=.env.together)");

const ALL_MODELS = [
  { id: "moonshotai/Kimi-K3", dir: "kimi-k3" },
  { id: "zai-org/GLM-5.2", dir: "glm-5.2" },
  { id: "Qwen/Qwen3.7-Plus", dir: "qwen3.7-plus" },
];
// Optional filter by dir name, e.g. MODELS=kimi-k3,glm-5.2 to skip Qwen.
const only = process.env.MODELS?.split(",").map(s => s.trim()).filter(Boolean);
const MODELS = only ? ALL_MODELS.filter(m => only.includes(m.dir)) : ALL_MODELS;
if (MODELS.length === 0) throw new Error(`MODELS=${process.env.MODELS} matches none of ${ALL_MODELS.map(m => m.dir).join(",")}`);
const RUNS = 5;
const OUT = join(import.meta.dir, "out");

const dict = new Set<string>();
if (existsSync("/usr/share/dict/words")) {
  for (const w of readFileSync("/usr/share/dict/words", "utf8").split("\n")) {
    dict.add(w.toLowerCase());
  }
} else {
  throw new Error("no /usr/share/dict/words");
}

type ToolCall = { id: string; name: string; arguments: string };
type ReqResult = {
  model: string;
  run: number;
  req: number;
  ok: boolean;
  error?: string;
  reasoningDeltas: string[];
  contentDeltas: string[];
  toolCalls: ToolCall[];
  finishReason: string | null;
  rawSse: string[];
  letterBoundaries: { i: number; left: string; right: string; leftRun: string; rightRun: string; concatIsWord: boolean }[];
  flaggedSeams: { i: number; left: string; right: string; leftRun: string; rightRun: string }[];
};

const SYS = "You are a careful assistant. Think briefly before acting.";
const USER = "Run the shell command `echo kimi` with the tool and then tell me the exit code.";
const TOOLS = [
  {
    type: "function",
    function: {
      name: "sandbox_exec",
      description: "Run a shell command in the sandbox.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

function baseBody(messages: unknown[]) {
  return {
    model: "",
    stream: true,
    stream_options: { include_usage: true },
    reasoning: { enabled: true },
    messages,
    tools: TOOLS,
  };
}

async function streamRequest(model: string, messages: unknown[]): Promise<ReqResult> {
  const res: ReqResult = {
    model, run: 0, req: 0, ok: false,
    reasoningDeltas: [], contentDeltas: [], toolCalls: [], finishReason: null,
    rawSse: [], letterBoundaries: [], flaggedSeams: [],
  };
  const body = baseBody(messages);
  body.model = model;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const partials = new Map<number, ToolCall>();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        res.rawSse.push(t);
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        const d = j.choices?.[0]?.delta ?? {};
        if (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) {
          res.reasoningDeltas.push(d.reasoning_content);
        }
        if (typeof d.content === "string" && d.content.length > 0) {
          res.contentDeltas.push(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = partials.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          partials.set(idx, cur);
        }
        if (j.choices?.[0]?.finish_reason) res.finishReason = j.choices[0].finish_reason;
      }
    }
    res.toolCalls = [...partials.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    res.ok = true;
  } catch (e: any) {
    res.error = String(e?.message ?? e);
  }

  for (let i = 0; i + 1 < res.reasoningDeltas.length; i++) {
    const left = res.reasoningDeltas[i];
    const right = res.reasoningDeltas[i + 1];
    if (!/[A-Za-z]$/.test(left) || !/^[A-Za-z]/.test(right)) continue;
    const leftRun = (left.match(/[A-Za-z]+$/) ?? [""])[0];
    const rightRun = (right.match(/^[A-Za-z]+/) ?? [""])[0];
    const l = leftRun.toLowerCase();
    const rr = rightRun.toLowerCase();
    const concatIsWord = dict.has(l + rr);
    res.letterBoundaries.push({ i, left, right, leftRun, rightRun, concatIsWord });
    if (l.length >= 2 && rr.length >= 2 && dict.has(l) && dict.has(rr) && !concatIsWord) {
      res.flaggedSeams.push({ i, left, right, leftRun, rightRun });
    }
  }
  return res;
}

async function toolTurn(model: string, run: number, dir: string): Promise<ReqResult[]> {
  const msgs1 = [
    { role: "system", content: SYS },
    { role: "user", content: USER },
  ];
  const r1 = await streamRequest(model, msgs1);
  r1.run = run; r1.req = 1;

  const outDir = join(OUT, dir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `run${run}-req1.sse.txt`), r1.rawSse.join("\n") + "\n");
  writeFileSync(join(outDir, `run${run}-req1.json`), JSON.stringify(r1, null, 2));
  // Drop req2 files from an earlier run so a failed req1 doesn't sit next to a stale req2.
  rmSync(join(outDir, `run${run}-req2.sse.txt`), { force: true });
  rmSync(join(outDir, `run${run}-req2.json`), { force: true });

  const results = [r1];
  if (!r1.ok || r1.toolCalls.length === 0) return results;

  const tc = r1.toolCalls[0];
  const msgs2 = [
    ...msgs1,
    {
      role: "assistant",
      reasoning_content: r1.reasoningDeltas.join(""),
      content: r1.contentDeltas.join("") || null,
      tool_calls: [{ type: "function", id: tc.id || `call_0`, function: { name: tc.name, arguments: tc.arguments } }],
    },
    { role: "tool", tool_call_id: tc.id || `call_0`, content: "kimi" },
  ];
  const r2 = await streamRequest(model, msgs2);
  r2.run = run; r2.req = 2;
  writeFileSync(join(outDir, `run${run}-req2.sse.txt`), r2.rawSse.join("\n") + "\n");
  writeFileSync(join(outDir, `run${run}-req2.json`), JSON.stringify(r2, null, 2));
  results.push(r2);
  return results;
}

function summarize(model: string, all: ReqResult[]) {
  const ok = all.filter(r => r.ok);
  const lost = ok.filter(r => r.flaggedSeams.length > 0);
  const meanDeltas = ok.length ? ok.reduce((s, r) => s + r.reasoningDeltas.length, 0) / ok.length : 0;
  return {
    model,
    date: new Date().toISOString().slice(0, 10),
    requests: all.length,
    okRequests: ok.length,
    errors: all.filter(r => !r.ok).map(r => `run${r.run} req${r.req}: ${r.error}`),
    withLostSpace: lost.length,
    rate: ok.length ? +(lost.length / ok.length * 100).toFixed(0) + "%" : "n/a",
    meanReasoningDeltas: +meanDeltas.toFixed(1),
    seams: lost.map(r => ({
      run: r.run, req: r.req,
      joined: r.reasoningDeltas.join(""),
      frames: r.flaggedSeams.map(s => ({ prev: s.left, next: s.right })),
    })),
    qwenThinkMarker: model.startsWith("Qwen")
      ? ok.filter(r => r.contentDeltas.join("").startsWith("<think")).length
      : undefined,
  };
}

const t0 = Date.now();
const summaries = await Promise.all(MODELS.map(async m => {
  const acc: ReqResult[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const rs = await toolTurn(m.id, run, m.dir);
    for (const r of rs) {
      const mark = !r.ok ? `ERROR ${r.error}`
        : r.flaggedSeams.length ? `LOST-SPACE ${r.flaggedSeams.map(s => JSON.stringify(s.left) + "+" + JSON.stringify(s.right)).join(", ")}`
        : "clean";
      console.log(`[${m.id}] run${run} req${r.req} reasoningDeltas=${r.reasoningDeltas.length} -> ${mark}`);
    }
    acc.push(...rs);
  }
  return summarize(m.id, acc);
}));

// Keep summaries for models that were not run this time (see MODELS above).
const resultsPath = join(OUT, "results.json");
const previous: { model: string }[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : [];
const merged = ALL_MODELS
  .map(m => summaries.find(s => s.model === m.id) ?? previous.find(p => p.model === m.id))
  .filter(Boolean);
writeFileSync(resultsPath, JSON.stringify(merged, null, 2));
console.log("\n==== SUMMARY ====");
console.log(JSON.stringify(summaries, null, 2));
console.log(`elapsed ${(Date.now() - t0) / 1000}s`);
