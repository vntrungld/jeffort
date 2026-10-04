// Adapted from jjjjjjjjjjjjjjjjacob/jev-router (MIT), skills/jev/scripts/lib/policy.ts.
// Unchanged except for levelIndex/capLevel at the end.

// Turns Jev's raw judgments into a routing decision. Pure: no I/O, so thresholds can be
// table-tested and re-tuned against eval/fixtures.jsonl without calling the API.

import type { Answer, ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./jev.ts";
import { SIGNALS, SUBAGENT_WORK_CRITERIA, type Signal, type SubagentWork } from "./questions.ts";

export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export const THRESHOLDS = {
  continuesPrevious: 0.6,
  quickPassCap: 0.7,
  verificationFloor: 0.7,
  floorMaxConfidence: 0.85,
  autonomy: 0.7,
  autonomyCompanion: 0.6,
  maxScoreForMax: 3,
  minScoreConfidence: 0.35,
  subagentConfidence: 0.6,
};

export type EffortAnswers = {
  score: number;
  confidence: number;
  signals: Record<Signal, number>;
};

export type EffortDecision = {
  level: Level | null; // null: leave the session's effort alone this turn
  reasons: string[];
  rules: string[];
};

const LEVEL_REASON: Record<Level, string> = {
  low: "quick, in the loop",
  medium: "regular feature work",
  high: "verification decides success",
  xhigh: "edge-case-dense",
  max: "autonomous, mission-critical",
};

export function readEffortAnswers(answers: Record<string, Answer>): EffortAnswers | null {
  const effort = answers.effort as ScoreAnswer | undefined;
  if (effort?.type !== "score" || typeof effort.score !== "number") return null;
  const signals = {} as Record<Signal, number>;
  for (const signal of SIGNALS) {
    const answer = answers[signal] as NoulAnswer | undefined;
    if (answer?.type !== "noul" || typeof answer.noul !== "number") return null;
    signals[signal] = answer.noul;
  }
  return { score: effort.score, confidence: effort.confidence ?? 0, signals };
}

export function decideEffort(
  answers: EffortAnswers,
  context: { previousLevel?: Level | null } = {},
  t = THRESHOLDS,
): EffortDecision {
  const { score, confidence, signals } = answers;

  if (signals.continues_previous > t.continuesPrevious && context.previousLevel) {
    return {
      level: context.previousLevel,
      reasons: ["continues previous request"],
      rules: ["continue"],
    };
  }

  let index = clampIndex(Math.round(score));
  const rules: string[] = [];
  const reasons: string[] = [];

  // Signals only overrule the Score when the Score itself is unsure: on the eval set a
  // confident Score was right wherever the floor would have raised it.
  const verification = signals.verification_central > t.verificationFloor;
  const edgeCases = signals.hidden_edge_cases > t.verificationFloor;
  if ((verification || edgeCases) && confidence < t.floorMaxConfidence) {
    if (index < 2) index = 2;
    rules.push("verification-floor");
    if (verification) reasons.push("verification");
    if (edgeCases) reasons.push("edge cases");
  }

  const autonomyCompanion =
    signals.hidden_edge_cases > t.autonomyCompanion || signals.verification_central > t.autonomyCompanion;
  if (signals.wants_autonomy > t.autonomy && autonomyCompanion) {
    const floor = score >= t.maxScoreForMax ? 4 : 3;
    if (index < floor) index = floor;
    rules.push("autonomy-floor");
    reasons.push("autonomous");
  }

  // Applied last: an explicit ask for a quick pass beats inferred difficulty.
  if (signals.wants_quick_pass > t.quickPassCap && index > 1) {
    index = 1;
    rules.push("quick-pass-cap");
    reasons.push("quick pass requested");
  }

  if (rules.length === 0 && confidence < t.minScoreConfidence) {
    return { level: null, reasons: ["low confidence"], rules: ["abstain"] };
  }

  const level = LEVELS[index]!;
  if (reasons.length === 0) reasons.push(LEVEL_REASON[level]);
  return { level, reasons, rules };
}

function clampIndex(index: number): number {
  return Math.min(LEVELS.length - 1, Math.max(0, index));
}

// --- subagents -------------------------------------------------------------------------

// Lookup agents keep their own defaults; fork ignores `model` entirely.
export const SKIPPED_SUBAGENT_TYPES = new Set(["fork", "Explore", "claude-code-guide", "statusline-setup"]);

export type SubagentModels = { judgment: string; delegated: string };
export type SubagentDecision = { model: string | null; work: SubagentWork | null; reason: string };

export function decideSubagentModel(
  answer: Answer | undefined,
  requestedModel: string | undefined,
  models: SubagentModels,
  t = THRESHOLDS,
): SubagentDecision {
  const choice = answer as ChoiceAnswer | undefined;
  if (choice?.type !== "choice" || !(choice.choice in SUBAGENT_WORK_CRITERIA)) {
    return { model: null, work: null, reason: "no usable answer" };
  }
  const work = choice.choice as SubagentWork;
  const target = models[work];
  const requested = normalize(requestedModel);
  const reason = work === "judgment" ? "judgment work" : "delegated work";
  if (requested === normalize(target)) return { model: null, work, reason: "already on routed model" };
  // The router owns the two configured tiers: a model outside them is always replaced
  // (so a pair that leaves out haiku means haiku never runs); otherwise only a confident
  // answer overrides what Claude asked for.
  const tiers = [normalize(models.judgment), normalize(models.delegated)];
  if (requested && !tiers.includes(requested)) return { model: target, work, reason: `${reason}, replaces ${requested}` };
  if (choice.confidence < t.subagentConfidence) return { model: null, work, reason: "low confidence" };
  return { model: target, work, reason };
}

function normalize(model: string | undefined): string | undefined {
  return model?.trim().toLowerCase() || undefined;
}

// --- added in this fork ------------------------------------------------------------------

export function levelIndex(level: Level): number {
  return LEVELS.indexOf(level);
}

// Never route above `max`: max effort is costly and prone to overthinking, so the mod's
// default ceiling is xhigh and max is opt-in.
export function capLevel(level: Level, max: Level): Level {
  return levelIndex(level) > levelIndex(max) ? max : level;
}
