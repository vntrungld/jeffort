// Runs under `claude plugin test .`: the engine's own $, with these hooks standing in for
// everything beneath the mod (the network, the model, the clock, the store).

import type { On, TurnStepResult } from "claude-code";
import { describe, expect, mock, test, type Engine } from "claude-code/testing";

const KEY = { typesafe_api_key: "ts-test-key" };
const ON = { ...KEY, enabled_by_default: true };
const OPUS_55 = "claude-opus-5-5";

type Fetched = { url: string; body: { model: string; state: Record<string, string>; questions: Record<string, unknown> } };
type JevReply = { score?: number; confidence?: number; signals?: Record<string, number>; work?: string; workConfidence?: number };

function effortAnswers(reply: JevReply) {
  const signal = (name: string) => ({ type: "noul", noul: reply.signals?.[name] ?? 0 });
  return {
    effort: { type: "score", score: reply.score ?? 1, confidence: reply.confidence ?? 0.8, probabilities: {}, legend: {} },
    continues_previous: signal("continues_previous"),
    wants_quick_pass: signal("wants_quick_pass"),
    wants_autonomy: signal("wants_autonomy"),
    hidden_edge_cases: signal("hidden_edge_cases"),
    verification_central: signal("verification_central"),
  };
}

// Everything beneath the mod. `replies` answers Jev requests in order; `null` never answers.
function world(on: On, replies: (JevReply | null)[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.store(on);
  mock.env(on, {});
  const fetched: Fetched[] = [];
  const steps: { agentId?: string; effort?: unknown; model: string }[] = [];
  const logs: string[] = [];
  const statuses: (string | undefined)[] = [];
  let usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 100 };

  on("http.fetch", async (_$, e) => {
    fetched.push({ url: e.url, body: JSON.parse(e.init?.body ?? "{}") });
    const reply = replies.shift();
    if (reply === null) return new Promise<never>(() => {});
    const body = JSON.parse(e.init?.body ?? "{}");
    const answers =
      "work" in body.questions
        ? { work: { type: "choice", choice: reply?.work ?? "delegated", confidence: reply?.workConfidence ?? 0.8, probabilities: {} } }
        : effortAnswers(reply ?? {});
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: "jev-1.13.0", answers }) } };
  });
  // Calls on $ answer with { value }.
  on("ui.log", async (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on("ui.status", async (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("command.register", async (_$, e) => ({ value: { command: e.name } }));
  on("prompt.submit", async (_$, e) => ({ text: e.text }));
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async (_$, e) => ({ text: e.answer }));
  on("agent.spawn", async (_$, e) => ({ model: e.model ?? e.parentModel, agentId: "agent-1" }));
  on("turn.step", async function* (_$, e): AsyncGenerator<never, TurnStepResult> {
    steps.push({ agentId: e.agentId, effort: e.effort, model: e.model });
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: { ...usage, model: e.model },
    };
  });

  return {
    clock,
    fetched,
    steps,
    logs,
    statuses,
    setUsage(next: typeof usage) {
      usage = next;
    },
  };
}

async function drain<C, R>(stream: AsyncGenerator<C, R> & { result: Promise<R> }): Promise<R> {
  for await (const _chunk of stream) {
    // read to the end
  }
  return stream.result;
}

// One prompt typed at the terminal, through to its turn's steps.
async function prompt(
  $: Engine,
  text: string,
  options: { turnId: string; steps?: number; model?: string; effort?: string; origin?: "composer" | "task-notification" },
) {
  await $.prompt.submit({ text, wait: false, origin: { kind: options.origin ?? "composer" } } as never);
  await $.turn.start({ text, turnId: options.turnId });
  for (let index = 0; index < (options.steps ?? 1); index++) {
    await drain(
      $.turn.step({
        turnId: options.turnId,
        index,
        model: options.model ?? OPUS_55,
        effort: (options.effort ?? "medium") as "medium",
        messageCount: 3,
      }),
    );
  }
  await $.turn.complete({ turnId: options.turnId, answer: "", durationMs: 10, isAborted: false, reason: "answer" });
}

describe("effort routing", () => {
  test("is off until turned on, and sends nothing", { options: KEY }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await prompt($, "fix the flaky crash in compaction", { turnId: "t1" });
    expect(w.fetched.length).toBe(0);
    expect(w.steps[0]?.effort).toBe("medium");
  });

  test("routes every main-loop step of the turn, then the next turn starts at the session level", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1, confidence: 0.8 }, { score: 1.1, confidence: 0.8 }]);
    await prompt($, "fix the flaky crash in the compaction path, reproduce it first", { turnId: "t1", steps: 3 });
    expect(w.steps.map((s) => s.effort)).toEqual(["high", "high", "high"]);
    expect(w.logs.filter((l) => l.startsWith("jev → high")).length).toBe(1);

    await prompt($, "add a CSV export button to the reports page", { turnId: "t2" });
    expect(w.steps[3]?.effort).toBe("medium");
    expect(w.fetched.length).toBe(2);
    expect(w.fetched[1]?.body.state.previous_request).toContain("compaction path");
  });

  test("a bare go-ahead keeps the previous level", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.8 }, { score: 0.1, signals: { continues_previous: 0.95 } }]);
    await prompt($, "write an HTML sanitizer that strips every way to smuggle JavaScript", { turnId: "t1" });
    await prompt($, "ok làm đi", { turnId: "t2" });
    expect(w.steps.map((s) => s.effort)).toEqual(["xhigh", "xhigh"]);
  });

  test("never routes above max_effort", { options: { ...ON, max_effort: "high" } }, async ($, on) => {
    const w = world(on, [{ score: 3.8, signals: { wants_autonomy: 0.9, hidden_edge_cases: 0.9 } }]);
    await prompt($, "audit the auth service for vulnerabilities overnight, end to end", { turnId: "t1" });
    expect(w.steps[0]?.effort).toBe("high");
  });

  test("leaves subagent steps alone", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await $.prompt.submit({ text: "debug the failing payout job", wait: false, origin: { kind: "composer" } } as never);
    await $.turn.start({ text: "debug the failing payout job", turnId: "t1" });
    // Same turnId on purpose: agentId alone must keep a subagent step out of routing.
    await drain($.turn.step({ turnId: "t1", index: 0, model: OPUS_55, effort: "medium", messageCount: 1, agentId: "agent-1" }));
    await drain($.turn.step({ turnId: "t1", index: 0, model: OPUS_55, effort: "medium", messageCount: 3 }));
    expect(w.steps.map((s) => s.effort)).toEqual(["medium", "high"]);
  });

  test("does not route notifications or other non-typed turns", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await prompt($, "Background command finished with exit code 1", { turnId: "t1", origin: "task-notification" });
    expect(w.fetched.length).toBe(0);
    expect(w.steps[0]?.effort).toBe("medium");
  });

  test("leaves models where an effort change costs the cache", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await prompt($, "fix the race in the session store", { turnId: "t1", model: "claude-opus-5" });
    expect(w.steps[0]?.effort).toBe("medium");
  });

  test("a slow Jev leaves the turn at the session level", { options: ON }, async ($, on) => {
    const w = world(on, [null]);
    await $.prompt.submit({ text: "refactor the billing module", wait: false, origin: { kind: "composer" } } as never);
    const started = $.turn.start({ text: "refactor the billing module", turnId: "t1" });
    await w.clock.settle();
    await w.clock.advance(2500);
    await started;
    await drain($.turn.step({ turnId: "t1", index: 0, model: OPUS_55, effort: "medium", messageCount: 3 }));
    expect(w.fetched.length).toBe(1);
    expect(w.steps[0]?.effort).toBe("medium");
  });

  test("refuses a base_url that is not https", { options: { ...ON, base_url: "http://example.com" } }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await prompt($, "fix the flaky crash", { turnId: "t1" });
    expect(w.fetched.length).toBe(0);
  });
});

describe("what leaves the machine", () => {
  test("code, secrets, URLs, e-mails, IPs and absolute paths are replaced", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    const text = [
      "Lỗi ở /home/duc/ownego/teeinblue/app/Services/Billing.php khi gọi https://posthog.teeinblue.com/api",
      "token=abc123secret, liên hệ duc@ownego.com, DB ở 10.0.0.12:5432",
      "```php",
      "$stripe->charges->create(['amount' => 100]);",
      "```",
      "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    ].join("\n");
    await prompt($, text, { turnId: "t1" });
    const sent = w.fetched[0]?.body.state.current_request ?? "";
    for (const leaked of ["/home/duc", "posthog.teeinblue.com", "abc123secret", "duc@ownego.com", "10.0.0.12", "$stripe", "sk-ant"]) {
      expect(sent.includes(leaked)).toBe(false);
    }
    expect(sent).toContain("[code block: 1 lines]");
    expect(sent).toContain("Lỗi ở <path>");
    expect(w.fetched[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  test("slash commands are never sent", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    await prompt($, "/review the auth changes", { turnId: "t1" });
    expect(w.fetched.length).toBe(0);
  });
});

describe("cache guard", () => {
  test("warns on the first miss after an effort change and pauses on the second", { options: ON }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }, { score: 0.1 }]);
    const cold = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 };
    const warm = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 100 };

    // A warm step at the session level, then a routed one that misses.
    w.setUsage(warm);
    await drain($.turn.step({ turnId: "t0", index: 0, model: OPUS_55, effort: "medium", messageCount: 3 }));
    w.setUsage(cold);
    await prompt($, "fix the flaky crash", { turnId: "t1" });
    expect(w.logs.some((l) => l.includes("prompt cache missed right after an effort change"))).toBe(true);

    // The next turn routes back down to low: another change, another miss.
    w.setUsage(cold);
    await prompt($, "rename getUser to fetchUser", { turnId: "t2" });
    expect(w.logs.some((l) => l.startsWith("jev: paused"))).toBe(true);

    // Paused: the next prompt is not sent to Jev.
    const before = w.fetched.length;
    await prompt($, "and fix the retry logic", { turnId: "t3" });
    expect(w.fetched.length).toBe(before);
    expect(w.statuses.at(-1)).toBeUndefined();
  });
});

describe("subagent model routing", () => {
  const spawn = (overrides: Record<string, unknown> = {}) => ({
    tool_use_id: "tu-1",
    prompt: "Review the diff in /home/duc/ownego/koin/src for auth bugs",
    description: "Review auth diff",
    subagentType: "general-purpose",
    provider: { plugin: "engine", tier: "core" },
    parentModel: OPUS_55,
    background: false,
    fork: false,
    ...overrides,
  });

  test("judgment work goes to the judgment model", { options: ON }, async ($, on) => {
    const w = world(on, [{ work: "judgment", workConfidence: 0.8 }]);
    const result = await $.agent.spawn(spawn({ model: "sonnet" }) as never);
    expect(result.model).toBe("opus");
    expect(w.fetched[0]?.body.state.subagent_task).not.toContain("/home/duc");
    expect(w.logs.some((l) => l.startsWith("jev → subagent on opus"))).toBe(true);
  });

  test("delegated work goes to the delegated model", { options: ON }, async ($, on) => {
    world(on, [{ work: "delegated", workConfidence: 0.9 }]);
    const result = await $.agent.spawn(spawn({ prompt: "Find every caller of getUser" }) as never);
    expect(result.model).toBe("sonnet");
  });

  test("lookup agents and forks are left alone", { options: ON }, async ($, on) => {
    const w = world(on, [{ work: "judgment" }]);
    await $.agent.spawn(spawn({ subagentType: "Explore" }) as never);
    await $.agent.spawn(spawn({ fork: true }) as never);
    expect(w.fetched.length).toBe(0);
  });

  test("can be turned off", { options: { ...ON, route_subagents: false } }, async ($, on) => {
    const w = world(on, [{ work: "judgment" }]);
    await $.agent.spawn(spawn() as never);
    expect(w.fetched.length).toBe(0);
  });
});

describe("/jev", () => {
  const run = (args: string) => ({
    command: "jev",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });

  test("on, status and off", { options: KEY }, async ($, on) => {
    const w = world(on, [{ score: 2.1 }]);
    expect((await $.command.run(run("on") as never)).text).toContain("ON");
    await prompt($, "fix the flaky crash", { turnId: "t1" });
    const status = (await $.command.run(run("status") as never)).text ?? "";
    expect(status).toContain("key set");
    expect(status).toContain("high (session medium)");
    expect((await $.command.run(run("off") as never)).text).toContain("OFF");
    await prompt($, "fix another crash", { turnId: "t2" });
    expect(w.fetched.length).toBe(1);
  });

  test("on without a key says so", async ($, on) => {
    const w = world(on, []);
    expect((await $.command.run(run("on") as never)).text).toContain("no TypeSafe key");
    await prompt($, "fix the flaky crash", { turnId: "t1" });
    expect(w.fetched.length).toBe(0);
  });
});
