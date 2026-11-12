import { describe, expect, test } from "bun:test";
import { CacheGuard, formatTokens, isCacheSafeModel, SubagentPrefixes } from "../hooks/lib/cache-guard.ts";
import { buildRequest, isAllowedBaseUrl, parseResponse } from "../hooks/lib/jev.ts";
import { effortQuestions } from "../hooks/lib/questions.ts";

describe("jev request and response", () => {
  const questions = effortQuestions();

  test("builds a POST to /v1/systemone with the pinned model", () => {
    const request = buildRequest({ current_request: "x" }, questions, { apiKey: "k", baseUrl: "https://api.typesafe.ai/" });
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(request.init.body).model).toBe("jev-1.13.0");
  });

  test("a response missing any question is null", () => {
    const text = JSON.stringify({ answers: { effort: { type: "score", score: 1 } } });
    expect(parseResponse({ ok: true, text }, questions)).toBeNull();
  });

  test("errors and garbage are null", () => {
    expect(parseResponse({ ok: false, text: "{}" }, questions)).toBeNull();
    expect(parseResponse({ ok: true, text: "<html>" }, questions)).toBeNull();
    expect(parseResponse({ ok: true, text: "null" }, questions)).toBeNull();
  });

  test.each([
    ["https://api.typesafe.ai", true],
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
    ["http://api.typesafe.ai", false],
    ["https://user:pw@api.typesafe.ai", false],
    ["ftp://api.typesafe.ai", false],
    ["not a url", false],
  ] as const)("base URL %s allowed: %p", (url, allowed) => {
    expect(isAllowedBaseUrl(url)).toBe(allowed);
  });
});

describe("cache guard", () => {
  const step = (at: number, effort: string, read: number, write: number, model = "claude-opus-5") => ({
    at,
    model,
    effort,
    cacheRead: read,
    cacheWrite: write,
  });

  test("a cold step right after an effort change is a miss, the second pauses", () => {
    const guard = new CacheGuard();
    expect(guard.observe(step(0, "medium", 50_000, 100)).kind).toBe("ok");
    expect(guard.observe(step(1000, "high", 0, 60_000))).toEqual({ kind: "miss", written: 60_000 });
    expect(guard.observe(step(2000, "medium", 0, 60_000))).toEqual({ kind: "pause", written: 60_000, misses: 2 });
  });

  test("a partial miss counts: system prompt kept, messages re-written", () => {
    // The numbers from an end-to-end run on Sonnet 5.5 behind a gateway.
    const guard = new CacheGuard();
    guard.observe(step(0, "high", 17_661, 0));
    expect(guard.observe(step(1000, "low", 13_231, 4_531))).toEqual({ kind: "miss", written: 4_531 });
    expect(guard.observe(step(2000, "high", 13_231, 4_579)).kind).toBe("pause");
  });

  test("a clean effort change forgets an earlier miss", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 50_000, 100));
    expect(guard.observe(step(1000, "high", 0, 50_100)).kind).toBe("miss");
    expect(guard.observe(step(2000, "medium", 50_100, 200)).kind).toBe("ok");
    expect(guard.observe(step(3000, "high", 0, 50_300)).kind).toBe("miss");
  });

  test("a growing cache is fine", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 17_657, 103));
    expect(guard.observe(step(1000, "high", 17_760, 120)).kind).toBe("ok");
  });

  test("no effort change, no blame", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "high", 50_000, 100));
    expect(guard.observe(step(1000, "high", 0, 60_000)).kind).toBe("ok");
  });

  test("a gap past the cache TTL is not blamed on effort", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 50_000, 100));
    expect(guard.observe(step(6 * 60_000, "high", 0, 60_000)).kind).toBe("ok");
  });

  test("a model switch is not blamed on effort", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 50_000, 100, "claude-opus-5-5"));
    expect(guard.observe(step(1000, "high", 0, 60_000, "claude-sonnet-5-5")).kind).toBe("ok");
  });

  test("a small prefix is not judged", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 500, 100));
    expect(guard.observe(step(1000, "high", 0, 2000)).kind).toBe("ok");
  });

  test("an expected miss is not counted", () => {
    const guard = new CacheGuard();
    guard.observe(step(0, "medium", 50_000, 100));
    expect(guard.observe({ ...step(1000, "high", 0, 60_000), expectMiss: true }).kind).toBe("ok");
    expect(guard.observe(step(2000, "medium", 0, 60_000)).kind).toBe("miss");
  });

  test("the warm prefix is what the last request left cached, while warm and on that model", () => {
    const guard = new CacheGuard();
    expect(guard.warmPrefix(0, "claude-opus-5")).toBe(0);
    guard.observe(step(0, "medium", 50_000, 1_200));
    expect(guard.warmPrefix(1000, "claude-opus-5")).toBe(51_200);
    expect(guard.warmPrefix(1000, "claude-opus-4-8")).toBe(0);
    expect(guard.warmPrefix(6 * 60_000, "claude-opus-5")).toBe(0);
    guard.reset();
    expect(guard.warmPrefix(1000, "claude-opus-5")).toBe(0);
  });
});

describe("subagent prefixes", () => {
  test("a switch away from the last same-type subagent's model reports its prefix", () => {
    const prefixes = new SubagentPrefixes();
    prefixes.record("general-purpose", "claude-sonnet-5-5", 14_000, 0);
    expect(prefixes.lost("general-purpose", "opus", 1000)).toEqual({ model: "claude-sonnet-5-5", tokens: 14_000 });
    expect(prefixes.lost("general-purpose", "sonnet", 1000)).toBeNull();
    expect(prefixes.lost("general-purpose", "claude-sonnet-5-5", 1000)).toBeNull();
    expect(prefixes.lost("code-reviewer", "opus", 1000)).toBeNull();
    expect(prefixes.lost("general-purpose", "opus", 6 * 60_000)).toBeNull();
  });
});

test.each([
  [800, "800"],
  [4_531, "4.5k"],
  [51_200, "51k"],
  [1_250_000, "1.3M"],
] as const)("formatTokens(%p) = %p", (tokens, text) => {
  expect(formatTokens(tokens)).toBe(text);
});

test.each([
  ["claude-opus-5-5", true],
  ["claude-opus-5-5[1m]", true],
  ["claude-sonnet-5-5-20261001", true],
  ["claude-fable-5-1", true],
  ["claude-fable-5-2", true],
  ["claude-haiku-5-5", true],
  ["claude-opus-5", false],
  ["claude-fable-5", false],
  ["claude-sonnet-5", false],
  ["claude-opus-4-8", false],
] as const)("cache-safe model %s: %p", (model, safe) => {
  expect(isCacheSafeModel(model)).toBe(safe);
});
