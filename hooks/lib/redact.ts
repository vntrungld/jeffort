// What a prompt looks like before it leaves the machine for TypeSafe. Jev only has to judge
// how hard the task is, so it never needs the code, the secrets or where things live:
//
//   pasted blocks         -> [pasted text: N chars]          (upstream behavior)
//   fenced code blocks    -> [code block: N lines]
//   long inline code      -> [code]
//   PEM keys, API tokens, JWTs, key=value secrets, long hex/base64 -> <secret>
//   URLs and DSNs         -> <url>
//   e-mail addresses      -> <email>
//   IPv4 addresses        -> <ip>
//   absolute/home paths   -> <path>
//
// then long prompts keep only their head and tail. Short identifiers in backticks (`getUser`)
// and relative paths without a leading slash stay: they carry the task's meaning.
//
// shapePrompt/truncate adapted from jjjjjjjjjjjjjjjjacob/jev-router (MIT), lib/prompt.ts.

const PASTED_BLOCK = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

export const HEAD_CHARS = 3000;
export const TAIL_CHARS = 1000;

export type ShapedPrompt =
  | { skip: false; text: string; redactions: number }
  | { skip: true; reason: "empty" | "slash-command" };

export function shapePrompt(raw: string | undefined | null, options: { redact?: boolean } = {}): ShapedPrompt {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { skip: true, reason: "empty" };
  // Slash commands and skills carry their own effort; /jev itself is a command.
  if (trimmed.startsWith("/")) return { skip: true, reason: "slash-command" };

  let redactions = 0;
  let text = trimmed.replace(PASTED_BLOCK, (_match, _id, body: string) => {
    redactions++;
    return `[pasted text: ${body.length} chars]`;
  });
  if (options.redact !== false) {
    const redacted = redact(text);
    text = redacted.text;
    redactions += redacted.count;
  }
  text = text.trim();
  if (!text) return { skip: true, reason: "empty" };
  return { skip: false, text: truncate(text), redactions };
}

type Rule = { pattern: RegExp; replace: (match: string, ...groups: string[]) => string };

// Order matters: whole blocks first, then secrets (which can sit inside URLs or paths), then
// the location-like things.
const RULES: Rule[] = [
  {
    pattern: /(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)/g,
    replace: (match) => `[code block: ${Math.max(1, match.split("\n").length - 2)} lines]`,
  },
  { pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, replace: () => "<secret>" },
  { pattern: /`[^`\n]{40,}`/g, replace: () => "[code]" },
  {
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replace: (_match, key: string, sep: string) => `${key}${sep}<secret>`,
  },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: () => "<secret>" },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: () => "<secret>" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => "<secret>" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => "<secret>" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: () => "<secret>" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replace: () => "<secret>" },
  {
    pattern: /\b(?:https?|wss?|ftp|ssh|git|postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|amqps?|s3):\/\/[^\s<>"'`)\]]+/gi,
    replace: () => "<url>",
  },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: () => "<email>" },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, replace: () => "<ip>" },
  { pattern: /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, replace: () => "<path>" },
  { pattern: /(?<![\w<>/.~@-])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, replace: () => "<path>" },
  { pattern: /(?<![\w<>/.~-])~\/[\w.@+-]+/g, replace: () => "<path>" },
  { pattern: /\b[a-f0-9]{32,}\b/gi, replace: () => "<secret>" },
  {
    // Long base64-ish runs with both letters and digits: tokens, keys, signatures.
    pattern: /(?<![\w+-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}(?![\w+-])/g,
    replace: () => "<secret>",
  },
];

export function redact(input: string): { text: string; count: number } {
  let count = 0;
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      count++;
      return rule.replace(match, ...(groups.filter((g) => typeof g === "string") as string[]));
    });
  }
  return { text, count };
}

export function truncate(text: string, head = HEAD_CHARS, tail = TAIL_CHARS): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${omitted} chars omitted ...]\n${text.slice(-tail)}`;
}

// A one-line preview for logs that stay on this machine.
export function preview(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

// The key a prompt is matched on between prompt.submit and turn.start.
export function promptKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
