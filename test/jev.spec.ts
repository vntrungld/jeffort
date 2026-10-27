import { describe, expect, test } from "bun:test";
import { CacheGuard, cacheUnsafeEnv, isCacheSafeModel, isGatewayLogin } from "../hooks/lib/cache-guard.ts";
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
});

test.each([
  ["claude-opus-5-5", true],
  ["claude-opus-5-5[1m]", true],
  ["claude-sonnet-5-5-20261001", true],
  ["claude-fable-5-1", true],
  ["claude-haiku-5-5", true],
  ["claude-haiku-4-5", false],
  ["claude-opus-5", false],
  ["claude-fable-5", false],
  ["claude-sonnet-5", false],
  ["claude-opus-4-8", false],
] as const)("cache-safe model %s: %p", (model, safe) => {
  expect(isCacheSafeModel(model)).toBe(safe);
});

describe("cacheUnsafeEnv", () => {
  test("names the first provider setting that loses the cache on an effort change", () => {
    expect(cacheUnsafeEnv({})).toBeNull();
    expect(cacheUnsafeEnv({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("CLAUDE_CODE_USE_BEDROCK");
    expect(cacheUnsafeEnv({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe("CLAUDE_CODE_USE_VERTEX");
    expect(cacheUnsafeEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" })).toBe("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
  });

  test("0, false and empty count as unset", () => {
    expect(cacheUnsafeEnv({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false", CLAUDE_CODE_USE_MANTLE: " " })).toBeNull();
  });

  test("reads no made-up gateway variable: the apps gateway is chosen by signing in", () => {
    expect(cacheUnsafeEnv({ CLAUDE_CODE_USE_GATEWAY: "1" })).toBeNull();
  });
});

describe("isGatewayLogin", () => {
  test("forceLoginMethod gateway means a Claude apps gateway session", () => {
    expect(isGatewayLogin("gateway")).toBe(true);
    expect(isGatewayLogin(" Gateway ")).toBe(true);
    expect(isGatewayLogin("claudeai")).toBe(false);
    expect(isGatewayLogin("console")).toBe(false);
    expect(isGatewayLogin(undefined)).toBe(false);
  });
});
