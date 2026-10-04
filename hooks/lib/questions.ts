// Copied unchanged from jjjjjjjjjjjjjjjjacob/jev-router (MIT), skills/jev/scripts/lib/questions.ts.
// Jev reads these literally: any rewording needs a live `bun run eval` before it ships.

// The judgments Jev makes. Wording is literal on purpose: Jev answers the question as
// written, so each Noul names its exact condition and each Score level is a concrete situation.

import type { ChoiceQuestion, NoulQuestion, Question, ScoreQuestion } from "./jev.ts";

export const EFFORT_LEVEL_CRITERIA = [
  "Quick and in the loop: a short question or explanation, a brainstorm, a rough sketch, or a small mechanical edit such as a rename, formatting, a config value, a commit message, or a git command.",
  "Regular work with a clear goal that the user will review: implement a feature or change, build a component, write tests, write or revise documents, copy, or plans, or do a focused analysis.",
  "Work where verification decides success: debug or fix a problem in existing code or systems, review code, tune performance, do an in-depth investigation, or handle edge cases that must be reproduced and tested.",
  "Edge-case-dense work where a first attempt usually fails: security-sensitive code such as sanitizers or auth, parsers, concurrency, storage engines, or numerical and scientific analysis.",
  "Fully autonomous, mission-critical work: build and verify a whole app end to end, audit critical software for vulnerabilities, or solve a very hard problem with no user in the loop.",
];

export const SIGNALS = [
  "continues_previous",
  "wants_quick_pass",
  "wants_autonomy",
  "hidden_edge_cases",
  "verification_central",
] as const;
export type Signal = (typeof SIGNALS)[number];

const SIGNAL_QUESTIONS: Record<Signal, NoulQuestion> = {
  continues_previous: {
    type: "noul",
    instructions:
      "Is `current_request` only an approval or continuation of earlier work, such as 'yes', 'go ahead', 'continue', or 'do it', without describing a new task?",
    criteria: {
      true: "Approves or continues earlier work without describing a new task",
      false: "Describes a task or question of its own",
    },
  },
  wants_quick_pass: {
    type: "noul",
    instructions:
      "Does `current_request` ask for a quick, rough, or first-draft result, or ask Claude to be fast or brief?",
  },
  wants_autonomy: {
    type: "noul",
    instructions:
      "Does `current_request` ask Claude to keep working to completion without checking in with the user, for example overnight, end to end, or until everything passes?",
  },
  hidden_edge_cases: {
    type: "noul",
    instructions:
      "Does the task in `current_request` have many hidden edge cases, where more testing would change whether the result is correct?",
  },
  verification_central: {
    type: "noul",
    instructions:
      "Is checking correctness, by reproducing a bug, running or writing tests, or reviewing code or results, a central part of what `current_request` asks for?",
  },
};

export function effortQuestions(): Record<string, Question> {
  const effort: ScoreQuestion = {
    type: "score",
    instructions:
      "How much independent verification and edge-case testing does the work that `current_request` asks for need?",
    criteria: EFFORT_LEVEL_CRITERIA,
  };
  return { effort, ...SIGNAL_QUESTIONS };
}

export type EffortState = { current_request: string; previous_request?: string };

// Subagent routing asks what kind of work the task is; code maps each kind to the model
// configured for it (judgmentModel / delegatedModel in config.ts).
export const SUBAGENT_WORK_CRITERIA = {
  delegated:
    "Well-scoped delegated work whose result the parent agent will review: implementing a specified change, research, searching or reading code, running commands, or mechanical edits.",
  judgment:
    "Judgment the parent agent will rely on without redoing: reviewing code or plans, adversarial verification, design or architecture decisions, root-cause debugging, user-facing copy or UI, or redoing work that failed review.",
} as const;
export type SubagentWork = keyof typeof SUBAGENT_WORK_CRITERIA;

export function subagentQuestions(): Record<string, Question> {
  const work: ChoiceQuestion = {
    type: "choice",
    instructions: "Which kind of work does the task in `subagent_task` ask the subagent to do?",
    criteria: SUBAGENT_WORK_CRITERIA,
  };
  return { work };
}

export type SubagentState = { subagent_task: string; description?: string };
