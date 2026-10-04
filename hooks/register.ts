// jev-effort: a mod that asks TypeSafe's Jev how much effort each prompt needs and sends
// that turn's model requests at that effort. Forked from jjjjjjjjjjjjjjjjacob/jev-router
// (MIT): the questions, policy and eval are theirs; how the level is applied is not.
//
// Upstream had no way to set effort from a hook, so it told Claude to load a jev-<level>
// skill and gated tool calls until it did; a turn that answered without tools skipped it.
// A mod can rewrite `effort` on every `turn.step`, so here:
//
//   prompt.submit  marks prompts the person typed (not notifications, peers or plugins)
//   turn.start     asks Jev once per marked prompt, before the turn's first request
//   turn.step      sends each main-loop request of that turn at the routed level
//   turn.complete  forgets the turn; the next prompt starts at the session level again
//   agent.spawn    picks a subagent's model from the kind of work it is given
//
// Everything fails open: no key, a timeout, an error or an unsure answer leaves the turn at
// the session's own effort. Subagents keep their own effort; only their model is routed.

import type { EngineInterface, Register } from "claude-code";
import { CacheGuard, isCacheSafeModel } from "./lib/cache-guard.ts";
import { buildRequest, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, isAllowedBaseUrl, parseResponse, type JevAnswers, type Question } from "./lib/jev.ts";
import { capLevel, decideEffort, decideSubagentModel, isLevel, readEffortAnswers, SKIPPED_SUBAGENT_TYPES, type Level } from "./lib/policy.ts";
import { effortQuestions, subagentQuestions, type EffortState, type SubagentState } from "./lib/questions.ts";
import { preview, promptKey, redact, shapePrompt, truncate } from "./lib/redact.ts";

const PREVIOUS_REQUEST_CHARS = 1500;
const MAX_MARKED_PROMPTS = 20;
const RECENT_DECISIONS = 8;
const STORED_DECISIONS = 200;
const ROUTED_ORIGINS = new Set(["composer", "bridge", "sdk"]);

type Decision = {
  at: number;
  kind: "effort" | "subagent";
  preview: string;
  level?: Level | null;
  sessionLevel?: string | null;
  applied?: boolean;
  model?: string | null;
  reasons: string[];
  confidence?: number;
  latencyMs?: number;
  redactions?: number;
};

type Route = { level: Level; decision: Decision; logged: boolean };

type Config = {
  apiKey: string | undefined;
  enabledByDefault: boolean;
  maxEffort: Level;
  routeSubagents: boolean;
  judgmentModel: string;
  delegatedModel: string;
  redact: boolean;
  cacheSafeOnly: boolean;
  cacheGuard: boolean;
  timeoutMs: number;
  showDecisions: boolean;
  baseUrl: string;
  jevModel: string;
};

// Session state lives in the module: a reload of the plugin starts it over, which only
// happens on /reload-plugins for an installed plugin. `register` fills it in.
let config: Config;
const session = {
  enabled: false,
  pausedReason: null as string | null,
  lastLevel: null as Level | null,
  lastRequest: undefined as string | undefined,
  marked: new Map<string, number>(),
  routed: new Map<string, Route>(),
  recent: [] as Decision[],
  guard: new CacheGuard(),
};

export const register: Register = (on, options) => {
  config = {
    apiKey: text(options.typesafe_api_key),
    enabledByDefault: options.enabled_by_default === true,
    maxEffort: (isLevel(options.max_effort) ? options.max_effort : "xhigh") as Level,
    routeSubagents: options.route_subagents !== false,
    judgmentModel: text(options.judgment_model) ?? "opus",
    delegatedModel: text(options.delegated_model) ?? "sonnet",
    redact: options.redact !== false,
    cacheSafeOnly: options.cache_safe_only !== false,
    cacheGuard: options.cache_guard !== false,
    timeoutMs: typeof options.timeout_ms === "number" ? options.timeout_ms : DEFAULT_TIMEOUT_MS,
    showDecisions: options.show_decisions !== false,
    baseUrl: text(options.base_url) ?? DEFAULT_BASE_URL,
    jevModel: text(options.jev_model) ?? DEFAULT_MODEL,
  };
  session.enabled = config.enabledByDefault;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description: "Jev effort routing for this session: on, off, or status",
      argumentHint: "[on|off|status]",
    });
    showStatus($);
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e) => {
    const arg = (e.args.trim().split(/\s+/)[0] || "on").toLowerCase();
    if (arg === "on") {
      setEnabled($, true);
      if (!(await apiKey($))) {
        return { text: "Jev routing is ON, but no TypeSafe key was found, so prompts pass through unrouted. Set it in /plugin configure, or export TYPESAFE_API_KEY." };
      }
      if (!isAllowedBaseUrl(config.baseUrl)) {
        return { text: `Jev routing is ON, but base_url ${config.baseUrl} is not https (or http to localhost), so nothing is sent.` };
      }
      const subagents = config.routeSubagents ? ` Subagents: ${config.judgmentModel} for judgment, ${config.delegatedModel} for delegated work.` : "";
      return { text: `Jev routing is ON for this session (up to ${config.maxEffort}).${subagents} /jev off to stop.` };
    }
    if (arg === "off") {
      setEnabled($, false);
      session.pausedReason = null;
      return { text: "Jev routing is OFF. Turns run at the session's effort." };
    }
    if (arg === "status") return { text: await statusText($) };
    return { text: `Unknown /jev argument "${arg}". Use /jev on, /jev off or /jev status.` };
  });

  // Only prompts the person sent start a routed turn. One typed while a turn runs is folded
  // into that turn (e.turnId set) and is left alone, as are notifications and peers.
  on("prompt.submit", async ($, e, next) => {
    if (session.enabled && !e.turnId && ROUTED_ORIGINS.has(e.origin.kind)) {
      const key = promptKey(e.text);
      if (key) {
        session.marked.set(key, (session.marked.get(key) ?? 0) + 1);
        while (session.marked.size > MAX_MARKED_PROMPTS) session.marked.delete(session.marked.keys().next().value as string);
      }
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    const markedKey = promptKey(e.text);
    const count = session.marked.get(markedKey);
    if (!session.enabled || !count) return next(e);
    if (count > 1) session.marked.set(markedKey, count - 1);
    else session.marked.delete(markedKey);

    const shaped = shapePrompt(e.text, { redact: config.redact });
    if (shaped.skip) return next(e);
    const key = await apiKey($);
    if (!key) return next(e);

    const state: EffortState = { current_request: shaped.text };
    if (session.lastRequest) state.previous_request = session.lastRequest;
    const result = await askJev($, key, state, effortQuestions());
    const answers = result && readEffortAnswers(result.answers);
    if (!result || !answers) return next(e);

    const decided = decideEffort(answers, { previousLevel: session.lastLevel });
    const level = decided.level ? capLevel(decided.level, config.maxEffort) : null;
    const reasons = level && decided.level !== level ? [...decided.reasons, `capped at ${level}`] : decided.reasons;
    session.lastLevel = level ?? session.lastLevel;
    session.lastRequest = shaped.text.slice(0, PREVIOUS_REQUEST_CHARS);

    const decision: Decision = {
      at: await $.clock.now(),
      kind: "effort",
      preview: preview(shaped.text),
      level,
      reasons,
      confidence: round(answers.confidence),
      latencyMs: result.latencyMs,
      redactions: shaped.redactions,
    };
    await remember($, decision);
    if (level) session.routed.set(e.turnId, { level, decision, logged: false });
    showStatus($);
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    // Subagent loops keep their own effort: their steps carry agentId and their own turnId.
    if (e.agentId) return yield* next(e);

    const route = session.enabled ? session.routed.get(e.turnId) : undefined;
    const current = e.effort;
    const routable =
      route !== undefined &&
      typeof current === "string" &&
      isLevel(current) &&
      (!config.cacheSafeOnly || isCacheSafeModel(e.model));
    const sent = routable && current !== route.level ? { ...e, effort: route.level } : e;

    if (route && !route.logged) {
      route.logged = true;
      route.decision.applied = sent !== e;
      route.decision.sessionLevel = typeof current === "string" ? current : null;
      if (sent !== e && config.showDecisions) {
        $.ui.log(`jev → ${route.level} · ${route.decision.reasons.join(", ")} (conf ${route.decision.confidence?.toFixed(2)})`);
      }
    }

    const result = yield* next(sent);

    if (session.enabled && config.cacheGuard && result.usage) {
      const verdict = session.guard.observe({
        at: await $.clock.now(),
        model: e.model,
        effort: sent.effort,
        cacheRead: result.usage.cache_read_input_tokens,
        cacheWrite: result.usage.cache_creation_input_tokens,
      });
      if (verdict.kind === "miss") {
        $.ui.log(`jev: the prompt cache missed right after an effort change on ${e.model} (${verdict.written} tokens re-written). Routing pauses if it happens again.`);
      } else if (verdict.kind === "pause") {
        setEnabled($, false);
        session.pausedReason = `cache missed ${verdict.misses}× after effort changes on ${e.model}`;
        $.ui.log(`jev: paused for this session. Effort changes keep re-reading the prompt cache on ${e.model}. /jev on to resume.`);
      }
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) session.routed.delete(e.turnId);
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    if (!session.enabled || !config.routeSubagents || e.fork || SKIPPED_SUBAGENT_TYPES.has(e.subagentType)) return next(e);
    const task = e.prompt.trim();
    if (!task) return next(e);
    const key = await apiKey($);
    if (!key) return next(e);

    const description = config.redact ? redact(e.description).text : e.description;
    const body = config.redact ? redact(task).text : task;
    const state: SubagentState = { subagent_task: truncate(body) };
    if (description) state.description = description;

    const result = await askJev($, key, state, subagentQuestions());
    if (!result) return next(e);
    const answer = result.answers.work;
    const decision = decideSubagentModel(answer, e.model, {
      judgment: config.judgmentModel,
      delegated: config.delegatedModel,
    });
    await remember($, {
      at: await $.clock.now(),
      kind: "subagent",
      preview: preview(description || body),
      model: decision.model,
      reasons: [decision.reason],
      confidence: answer?.type === "choice" ? round(answer.confidence) : undefined,
      latencyMs: result.latencyMs,
    });
    if (!decision.model) return next(e);
    if (config.showDecisions) $.ui.log(`jev → subagent on ${decision.model} (${decision.reason})`);
    return next({ ...e, model: decision.model });
  });
};

// --- helpers: top-level functions, the only places a hook may hand `$` to ---------------

async function apiKey($: EngineInterface): Promise<string | null> {
  if (config.apiKey) return config.apiKey;
  return text(await $.env.get("TYPESAFE_API_KEY")) ?? text(await $.env.get("JEV_API_KEY")) ?? null;
}

// One request, a hard timeout, never throws: every failure is null.
async function askJev(
  $: EngineInterface,
  key: string,
  state: unknown,
  questions: Record<string, Question>,
): Promise<(JevAnswers & { latencyMs: number }) | null> {
  if (!isAllowedBaseUrl(config.baseUrl)) return null;
  const request = buildRequest(state, questions, { apiKey: key, model: config.jevModel, baseUrl: config.baseUrl });
  const timer = new AbortController();
  try {
    const started = await $.clock.now();
    const call = $.http.fetch(request.url, request.init).then(
      (response) => parseResponse(response, questions, config.jevModel),
      () => null,
    );
    const timeout = $.clock.sleep(config.timeoutMs, { signal: timer.signal }).then(
      () => null,
      () => null,
    );
    const answers = await Promise.race([call, timeout]);
    if (!answers) return null;
    return { ...answers, latencyMs: Math.round((await $.clock.now()) - started) };
  } catch {
    return null;
  } finally {
    timer.abort();
  }
}

async function remember($: EngineInterface, decision: Decision): Promise<void> {
  session.recent.push(decision);
  if (session.recent.length > RECENT_DECISIONS) session.recent.shift();
  try {
    const stored = await $.store.get("decisions");
    const list = Array.isArray(stored) ? stored : [];
    list.push(decision);
    await $.store.set("decisions", list.slice(-STORED_DECISIONS));
  } catch {
    // the log is for tuning only
  }
}

function showStatus($: EngineInterface): void {
  $.ui.status(session.enabled ? (session.lastLevel ? `jev · ${session.lastLevel}` : "jev") : undefined);
}

function setEnabled($: EngineInterface, value: boolean): void {
  session.enabled = value;
  if (value) {
    session.pausedReason = null;
    session.guard.reset();
  } else {
    session.routed.clear();
    session.marked.clear();
  }
  showStatus($);
}

async function statusText($: EngineInterface): Promise<string> {
  const key = (await apiKey($)) ? "key set" : "no key";
  const state = session.enabled ? "ON" : session.pausedReason ? `PAUSED (${session.pausedReason})` : "OFF";
  const head = `Jev routing is ${state} · ${key} · up to ${config.maxEffort} · redaction ${config.redact ? "on" : "off"} · cache-safe models only: ${config.cacheSafeOnly ? "yes" : "no"}`;
  if (session.recent.length === 0) return `${head}\nNo decisions yet.`;
  const lines = session.recent.map((d) => {
    if (d.kind === "subagent") return `- subagent → ${d.model ?? "unchanged"} (${d.reasons.join(", ")}) · "${d.preview}"`;
    const level = d.level ?? "unchanged";
    const applied = d.applied === undefined ? "" : d.applied ? ` (session ${d.sessionLevel ?? "?"})` : " (not applied)";
    const conf = d.confidence === undefined ? "" : ` · conf ${d.confidence.toFixed(2)}`;
    return `- ${level}${applied} · ${d.reasons.join(", ")}${conf} · ${d.latencyMs ?? "?"} ms · "${d.preview}"`;
  });
  return `${head}\nLast ${session.recent.length}:\n${lines.join("\n")}`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
