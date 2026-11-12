// Watches whether changing effort between requests costs the prompt cache. On Fable 5.1 and
// later, Opus 5.5, Sonnet 5.5 and Haiku 5.5 with an API key or a Claude subscription it should not; on other
// models, providers or gateways each change re-reads the whole conversation. The guard turns
// that suspicion into evidence from the API's own usage numbers and pauses routing when the
// evidence shows up, instead of trusting a model-name allowlist alone.

export type StepRecord = {
  at: number; // ms since epoch, when the response finished
  model: string;
  effort: string | number | undefined;
  cacheRead: number;
  cacheWrite: number;
  // The person agreed to an effort change that costs the cache here: a miss is expected, so
  // it is recorded but not counted against routing.
  expectMiss?: boolean;
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
    if (!(effortChanged && sameModel && recent) || step.expectMiss) return { kind: "ok" };
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

  // The cached prefix the next request on `model` would read if nothing changed: what the
  // last request left cached, while it is recent and on the same model. 0 when cold.
  warmPrefix(at: number, model: string): number {
    const last = this.last;
    if (!last || last.model !== model || at - last.at > this.limits.maxGapMs) return 0;
    const prefix = last.cacheRead + last.cacheWrite;
    return prefix >= this.limits.minLost ? prefix : 0;
  }

  reset(): void {
    this.last = null;
    this.misses = 0;
  }
}

// The prefix the last subagent of each type left cached, so a model switch can say what it
// does not reuse. A subagent is a new conversation: its cache is only shared with earlier
// subagents of the same type (same system prompt and tools) on the same model.
export class SubagentPrefixes {
  private byType = new Map<string, { model: string; tokens: number; at: number }>();

  constructor(private readonly limits = GUARD) {}

  // Feed a subagent's first step.
  record(subagentType: string, model: string, tokens: number, at: number): void {
    this.byType.delete(subagentType);
    this.byType.set(subagentType, { model, tokens, at });
    while (this.byType.size > 50) this.byType.delete(this.byType.keys().next().value as string);
  }

  // What spawning `subagentType` on `target` (an alias or id) would not reuse, or null.
  lost(subagentType: string, target: string, at: number): { model: string; tokens: number } | null {
    const last = this.byType.get(subagentType);
    if (!last || at - last.at > this.limits.maxGapMs || last.tokens < this.limits.minLost) return null;
    if (sameModel(last.model, target)) return null;
    return { model: last.model, tokens: last.tokens };
  }

  reset(): void {
    this.byType.clear();
  }
}

// An alias (`opus`) matches the ids it stands for (`claude-opus-5-5`).
function sameModel(id: string, target: string): boolean {
  const a = id.trim().toLowerCase();
  const b = target.trim().toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

// Models whose per-request effort change keeps the cache, per the Claude Code prompt-caching
// docs: "Fable 5.1 and later, Opus 5.5, Sonnet 5.5, and Haiku 5.5". Provider-prefixed ids (Bedrock, Vertex) still match here; the guard above
// is what catches those, since the docs say the cache is not kept there.
const CACHE_SAFE_MODEL = /claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-[1-9])\b/i;

export function isCacheSafeModel(model: string): boolean {
  return CACHE_SAFE_MODEL.test(model);
}
