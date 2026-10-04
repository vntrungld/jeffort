// Ported from jjjjjjjjjjjjjjjjacob/jev-router (MIT), test/policy.test.ts, plus capLevel.
import { describe, expect, test } from "bun:test";
import { capLevel, decideEffort, decideSubagentModel, readEffortAnswers, type EffortAnswers } from "../hooks/lib/policy.ts";
import type { Signal } from "../hooks/lib/questions.ts";

function answers(score: number, signals: Partial<Record<Signal, number>> = {}, confidence = 0.8): EffortAnswers {
  return {
    score,
    confidence,
    signals: {
      continues_previous: 0,
      wants_quick_pass: 0,
      wants_autonomy: 0,
      hidden_edge_cases: 0,
      verification_central: 0,
      ...signals,
    },
  };
}

describe("decideEffort", () => {
  test.each([
    ["rename is low", answers(0.1), "low"],
    ["feature work is medium", answers(1.2), "medium"],
    ["brownfield bug is high", answers(2.1), "high"],
    ["sanitizer is xhigh", answers(2.8), "xhigh"],
    ["autonomous audit is max", answers(3.7), "max"],
  ] as const)("%s", (_name, input, expected) => {
    expect(decideEffort(input).level).toBe(expected);
  });

  test("continuation reuses the previous level", () => {
    const decision = decideEffort(answers(0.2, { continues_previous: 0.9 }), { previousLevel: "xhigh" });
    expect(decision.level).toBe("xhigh");
    expect(decision.rules).toEqual(["continue"]);
  });

  test("continuation without a previous level falls through to the score", () => {
    expect(decideEffort(answers(0.2, { continues_previous: 0.9 })).level).toBe("low");
  });

  test("verification signal floors at high", () => {
    const decision = decideEffort(answers(0.9, { verification_central: 0.85 }));
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("verification");
  });

  test("verification floor never lowers a higher score", () => {
    expect(decideEffort(answers(3.1, { hidden_edge_cases: 0.9 })).level).toBe("xhigh");
  });

  test("autonomy plus edge cases floors at xhigh, max when the score is high", () => {
    expect(decideEffort(answers(1.4, { wants_autonomy: 0.9, hidden_edge_cases: 0.7 })).level).toBe("xhigh");
    expect(decideEffort(answers(3.2, { wants_autonomy: 0.9, verification_central: 0.65 })).level).toBe("max");
  });

  test("autonomy alone does not raise effort", () => {
    expect(decideEffort(answers(1.1, { wants_autonomy: 0.95 })).level).toBe("medium");
  });

  test("a quick-pass request caps at medium even over the verification floor", () => {
    const decision = decideEffort(answers(2.6, { wants_quick_pass: 0.9, verification_central: 0.9 }));
    expect(decision.level).toBe("medium");
    expect(decision.rules.at(-1)).toBe("quick-pass-cap");
  });

  test("a confident Score is not overruled by the verification floor", () => {
    const decision = decideEffort(answers(1.0, { verification_central: 0.9 }, 0.95));
    expect(decision.level).toBe("medium");
    expect(decision.rules).toEqual([]);
  });

  test("low confidence with no rule abstains", () => {
    const decision = decideEffort(answers(1.6, {}, 0.2));
    expect(decision.level).toBeNull();
    expect(decision.rules).toEqual(["abstain"]);
  });

  test("low confidence still applies when a rule fired", () => {
    expect(decideEffort(answers(1.6, { verification_central: 0.9 }, 0.2)).level).toBe("high");
  });
});

describe("readEffortAnswers", () => {
  test("rejects a response missing a signal", () => {
    expect(
      readEffortAnswers({
        effort: { type: "score", score: 1, confidence: 0.9, probabilities: {}, legend: {} },
      }),
    ).toBeNull();
  });
});

describe("decideSubagentModel", () => {
  const models = { judgment: "fable", delegated: "opus" };
  const choice = (work: string, confidence: number) => ({
    type: "choice" as const,
    choice: work,
    probabilities: { judgment: work === "judgment" ? 0.8 : 0.2, delegated: work === "delegated" ? 0.8 : 0.2 },
    confidence,
  });

  test("routes a confident judgment task to the judgment model", () => {
    expect(decideSubagentModel(choice("judgment", 0.8), "opus", models)).toEqual({
      model: "fable",
      work: "judgment",
      reason: "judgment work",
    });
  });

  test("routes delegated work to the delegated model when the model was omitted", () => {
    expect(decideSubagentModel(choice("delegated", 0.7), undefined, models).model).toBe("opus");
  });

  test("leaves a matching model alone", () => {
    expect(decideSubagentModel(choice("delegated", 0.9), "OPUS", models).model).toBeNull();
  });

  test("low confidence leaves a requested model that is one of the tiers", () => {
    expect(decideSubagentModel(choice("judgment", 0.3), "opus", models).model).toBeNull();
  });

  test("always replaces a model outside the configured tiers", () => {
    expect(decideSubagentModel(choice("delegated", 0.1), "haiku", models)).toMatchObject({
      model: "opus",
      reason: "delegated work, replaces haiku",
    });
  });

  test("uses whatever models are configured", () => {
    const defaults = { judgment: "opus", delegated: "sonnet" };
    expect(decideSubagentModel(choice("delegated", 0.9), undefined, defaults).model).toBe("sonnet");
    expect(decideSubagentModel(choice("judgment", 0.9), "sonnet", defaults).model).toBe("opus");
  });

  test("ignores an unusable answer", () => {
    expect(decideSubagentModel(undefined, "opus", models).model).toBeNull();
    expect(decideSubagentModel(choice("sonnet", 0.9), "opus", models).model).toBeNull();
  });
});

describe("capLevel", () => {
  test("lowers a level above the ceiling and leaves the rest", () => {
    expect(capLevel("max", "xhigh")).toBe("xhigh");
    expect(capLevel("xhigh", "high")).toBe("high");
    expect(capLevel("medium", "xhigh")).toBe("medium");
  });
});
