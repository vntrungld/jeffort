// Watches whether changing effort between requests costs the prompt cache. On Opus 5.5,
// Sonnet 5.5 and Fable 5.1 with an API key or a Claude subscription it should not; on other
// models, providers or gateways each change re-reads the whole conversation. The guard turns
// that suspicion into evidence from the API's own usage numbers and pauses routing when the
// evidence shows up, instead of trusting a model-name allowlist alone.

export type StepRecord = {
  at: number; // ms since epoch, when the response finished
  model: string;
  effort: string | number | undefined;
  cacheRead: number;
  cacheWrite: number;
};

export type GuardVerdict =
  | { kind: "ok" }
  | { kind: "miss"; written: number } // an effort change coincided with a cache miss
  | { kind: "pause"; written: number; misses: number };

export const GUARD = {
  // How much of the previous request's cached prefix must go missing to count. Small drops
  // are noise; a real invalidation loses at least the conversation part of the prefix.
  minLost: 2048,
  // Past this, a miss is the cache TTL (5 minutes by default), not the effort change.
  maxGapMs: 4 * 60 * 1000,
  pauseAfterMisses: 2,
};

export class CacheGuard {
  private last: StepRecord | null = null;
  private misses = 0;

  constructor(private readonly limits = GUARD) {}

  // Feed every main-loop step, routed or not, in order.
  observe(step: StepRecord): GuardVerdict {
    const previous = this.last;
    this.last = step;
    if (!previous) return { kind: "ok" };
    const effortChanged = previous.effort !== step.effort;
    const sameModel = previous.model === step.model;
    const recent = step.at - previous.at <= this.limits.maxGapMs;
    // A miss is often partial: the system prompt and tools stay cached and only the messages
    // are re-written (seen on a gateway with Sonnet 5.5, for /effort and this mod alike), so
    // compare against everything the previous request left cached, not against zero.
    const previousPrefix = previous.cacheRead + previous.cacheWrite;
    const lost = previousPrefix - step.cacheRead;
    const missed = lost >= this.limits.minLost && step.cacheWrite >= this.limits.minLost / 2;
    if (!(effortChanged && sameModel && recent)) return { kind: "ok" };
    if (!missed) {
      // An effort change that kept the cache is evidence the setup keeps it: forget older misses.
      this.misses = 0;
      return { kind: "ok" };
    }
    this.misses++;
    if (this.misses >= this.limits.pauseAfterMisses) {
      return { kind: "pause", written: step.cacheWrite, misses: this.misses };
    }
    return { kind: "miss", written: step.cacheWrite };
  }

  reset(): void {
    this.last = null;
    this.misses = 0;
  }
}

// Models whose per-request effort change keeps the cache, per the Claude Code prompt-caching
// docs (2.1.260+): Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, with an API key or a Claude
// subscription. Provider-prefixed ids (Bedrock, Vertex) still match here; cacheUnsafeEnv below
// rules those setups out up front, and the guard above catches whatever it misses.
const CACHE_SAFE_MODEL = /claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1)\b/i;

export function isCacheSafeModel(model: string): boolean {
  return CACHE_SAFE_MODEL.test(model);
}

// Setups where the docs say an effort change loses the cache on every model: Amazon Bedrock
// (and its Mantle endpoint), Google Cloud's Agent Platform (Vertex), and
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS. Checking them up front saves the two paid misses the
// guard would need to find out. A Claude apps gateway is chosen by signing in, not by an env
// var: isGatewayLogin reads the setting that sends /login there. A custom ANTHROPIC_BASE_URL
// is left to the guard: whether it keeps the cache depends on the gateway.
export const CACHE_UNSAFE_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
] as const;

// `forceLoginMethod: "gateway"` restricts sign-in to a Claude apps gateway, where the docs say
// an effort change does not keep the cache.
export function isGatewayLogin(forceLoginMethod: unknown): boolean {
  return typeof forceLoginMethod === "string" && forceLoginMethod.trim().toLowerCase() === "gateway";
}

export function cacheUnsafeEnv(env: Partial<Record<string, string | undefined>>): string | null {
  for (const name of CACHE_UNSAFE_ENV) {
    const value = env[name]?.trim().toLowerCase();
    if (value && value !== "0" && value !== "false") return name;
  }
  return null;
}
