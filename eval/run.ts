// Calibration harness, adapted from jjjjjjjjjjjjjjjjacob/jev-router (MIT), eval/run.ts.
// Live mode calls Jev once per fixture with the same request the mod sends (redaction on
// unless --no-redact) and saves the raw answers; --replay re-runs only the policy on them.
//
//   TYPESAFE_API_KEY=... bun eval/run.ts               live, redacted like the mod
//   TYPESAFE_API_KEY=... bun eval/run.ts --no-redact   live, raw prompts (upstream's setup)
//   bun eval/run.ts --replay                           policy only, on the last live run
//
// Add your own prompts to eval/fixtures.local.jsonl (gitignored): Vietnamese prompts and
// ones from your real sessions are what tell you whether the thresholds fit your work.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRequest, parseResponse, type Answer, type Question } from "../hooks/lib/jev.ts";
import { decideEffort, decideSubagentModel, LEVELS, readEffortAnswers, type Level } from "../hooks/lib/policy.ts";
import { effortQuestions, subagentQuestions, type EffortState } from "../hooks/lib/questions.ts";
import { redact, shapePrompt, truncate } from "../hooks/lib/redact.ts";

type Fixture =
  | { kind: "effort"; source: string; prompt: string; previous?: string; previousLevel?: Level; expected: Level; accept: Level[] }
  | { kind: "subagent"; source: string; prompt: string; description?: string; expected: string };

type Saved = { answers: Record<string, Answer> | null; latencyMs: number | null };

const DIR = import.meta.dir;
const replay = process.argv.includes("--replay");
const useRedaction = !process.argv.includes("--no-redact");
const RESULTS = join(DIR, "results", useRedaction ? "latest.json" : "latest-raw.json");
const CONCURRENCY = 6;
const TARGETS = { acceptable: 0.9, withinOne: 0.95, exact: 0.6, p95Ms: 800, subagent: 0.8 };

const fixtures: Fixture[] = ["fixtures.jsonl", "fixtures.local.jsonl"]
  .map((name) => join(DIR, name))
  .filter(existsSync)
  .flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Fixture),
  );

const saved: Saved[] = replay ? loadSaved() : await runLive();
report();

function loadSaved(): Saved[] {
  const results = JSON.parse(readFileSync(RESULTS, "utf8")) as { prompt: string; saved: Saved }[];
  const byPrompt = new Map(results.map((r) => [r.prompt, r.saved]));
  return fixtures.map((f) => byPrompt.get(f.prompt) ?? { answers: null, latencyMs: null });
}

async function ask(apiKey: string, state: unknown, questions: Record<string, Question>): Promise<Saved> {
  const request = buildRequest(state, questions, {
    apiKey,
    model: process.env.JEV_MODEL,
    baseUrl: process.env.TYPESAFE_BASE_URL,
  });
  const started = performance.now();
  try {
    const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(10_000) });
    const parsed = parseResponse({ ok: response.ok, text: await response.text() }, questions);
    return { answers: parsed?.answers ?? null, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { answers: null, latencyMs: null };
  }
}

async function runLive(): Promise<Saved[]> {
  const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("Set TYPESAFE_API_KEY to run the live eval, or use --replay.");
  const out: Saved[] = new Array(fixtures.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < fixtures.length) {
        const i = next++;
        const fixture = fixtures[i]!;
        if (fixture.kind === "effort") {
          const shaped = shapePrompt(fixture.prompt, { redact: useRedaction });
          const state: EffortState = { current_request: shaped.skip ? fixture.prompt : shaped.text };
          if (fixture.previous) state.previous_request = fixture.previous;
          out[i] = await ask(apiKey, state, effortQuestions());
        } else {
          const task = useRedaction ? redact(fixture.prompt).text : fixture.prompt;
          const state: Record<string, string> = { subagent_task: truncate(task) };
          if (fixture.description) state.description = fixture.description;
          out[i] = await ask(apiKey, state, subagentQuestions());
        }
      }
    }),
  );
  mkdirSync(join(DIR, "results"), { recursive: true });
  writeFileSync(RESULTS, JSON.stringify(fixtures.map((f, i) => ({ prompt: f.prompt, saved: out[i] })), null, 2));
  return out;
}

function report(): void {
  const matrix = new Map<string, number>();
  const misses: string[] = [];
  let effortTotal = 0;
  let exact = 0;
  let acceptable = 0;
  let withinOne = 0;
  let abstained = 0;
  let failed = 0;
  let subagentTotal = 0;
  let subagentCorrect = 0;
  const latencies: number[] = [];

  fixtures.forEach((fixture, i) => {
    const result = saved[i]!;
    if (result.latencyMs !== null) latencies.push(result.latencyMs);
    if (!result.answers) {
      failed++;
      misses.push(`  [no answer] ${fixture.prompt.slice(0, 90)}`);
      return;
    }
    if (fixture.kind === "subagent") {
      subagentTotal++;
      const answer = result.answers.work;
      const picked = answer?.type === "choice" ? answer.choice : "?";
      if (picked === fixture.expected) subagentCorrect++;
      else {
        const routed = decideSubagentModel(answer, undefined, { judgment: "judgment", delegated: "delegated" }).model;
        misses.push(`  [subagent] want ${fixture.expected}, got ${routed ?? `(${picked}, low conf)`} · ${fixture.prompt.slice(0, 80)}`);
      }
      return;
    }
    effortTotal++;
    const answers = readEffortAnswers(result.answers);
    if (!answers) {
      failed++;
      return;
    }
    const got = decideEffort(answers, { previousLevel: fixture.previousLevel ?? null }).level;
    matrix.set(`${fixture.expected}>${got ?? "none"}`, (matrix.get(`${fixture.expected}>${got ?? "none"}`) ?? 0) + 1);
    if (got === null) abstained++;
    if (got === fixture.expected) exact++;
    if (got !== null && fixture.accept.includes(got)) acceptable++;
    if (got !== null && Math.abs(LEVELS.indexOf(got) - LEVELS.indexOf(fixture.expected)) <= 1) withinOne++;
    if (got === null || !fixture.accept.includes(got)) {
      misses.push(
        `  [${fixture.source}] want ${fixture.expected} (ok: ${fixture.accept.join("/")}), got ${got ?? "none"} · score ${answers.score.toFixed(2)} conf ${answers.confidence.toFixed(2)}\n      ${fixture.prompt.slice(0, 110)}`,
      );
    }
  });

  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
  const cols = [...LEVELS, "none"];
  console.log(`\nEffort: ${effortTotal} prompts · redaction ${useRedaction ? "on" : "off"}${replay ? " (replay)" : ""}`);
  console.log(`  expected \\ got  ${cols.map((c) => c.padStart(6)).join("")}`);
  for (const row of LEVELS) {
    console.log(`  ${row.padEnd(15)}${cols.map((c) => String(matrix.get(`${row}>${c}`) ?? "·").padStart(6)).join("")}`);
  }
  for (const [name, n, target] of [
    ["acceptable", acceptable, TARGETS.acceptable],
    ["within one level", withinOne, TARGETS.withinOne],
    ["exact", exact, TARGETS.exact],
  ] as const) {
    console.log(`  ${name.padEnd(17)} ${pct(n, effortTotal).padStart(4)}  target ${pct(target * 100, 100)} ${n / effortTotal >= target ? "✓" : "✗"}`);
  }
  console.log(`  abstained ${abstained} · failed ${failed}`);
  console.log(`\nSubagent work type: ${pct(subagentCorrect, subagentTotal)} of ${subagentTotal}  target ${pct(TARGETS.subagent * 100, 100)}`);
  if (!replay && latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    console.log(`Latency p50 ${at(0.5)}ms · p95 ${at(0.95)}ms  target p95 < ${TARGETS.p95Ms}ms`);
  }
  if (misses.length) console.log(`\nMisses:\n${misses.join("\n")}`);
}
