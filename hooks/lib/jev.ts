// TypeSafe System One wire format. Pure: no network here. The mod sends the request with
// $.http.fetch and the eval harness with fetch, so both share one request and one parser.
//
// Adapted from jjjjjjjjjjjjjjjjacob/jev-router (MIT), skills/jev/scripts/lib/jev.ts.

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-1.13.0"; // pinned: policy thresholds are tuned against this version
export const DEFAULT_TIMEOUT_MS = 2500;

export type NoulQuestion = {
  type: "noul";
  instructions: unknown;
  criteria?: { true?: unknown; false?: unknown };
};
export type ChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type ScoreQuestion = { type: "score"; instructions: unknown; criteria: unknown[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type JevAnswers = { model: string; answers: Record<string, Answer> };

export type JevRequest = {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
};

export function buildRequest(
  state: unknown,
  questions: Record<string, Question>,
  options: { apiKey: string; model?: string; baseUrl?: string },
): JevRequest {
  const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    url: `${base}/v1/systemone`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: options.model || DEFAULT_MODEL, state, questions }),
    },
  };
}

// Never throws: a response that is not ok, not JSON, or missing any asked question is null.
export function parseResponse(
  response: { ok: boolean; text: string },
  questions: Record<string, Question>,
  requestedModel: string = DEFAULT_MODEL,
): JevAnswers | null {
  if (!response.ok) return null;
  try {
    const body = JSON.parse(response.text) as { model?: unknown; answers?: Record<string, Answer> };
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") return null;
    for (const id of Object.keys(questions)) {
      if (!body.answers[id]) return null;
    }
    return { model: typeof body.model === "string" ? body.model : requestedModel, answers: body.answers };
  } catch {
    return null;
  }
}

// Only https to a real host, or http to loopback (a local proxy). Anything else would send
// the API key and the prompt somewhere unintended, so the mod refuses it and stays off.
export function isAllowedBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return url.hostname.length > 0;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return false;
  } catch {
    return false;
  }
}
