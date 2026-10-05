# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`jeffort` is a Claude Code **mod** (plugin with function hooks), not a standalone app. It asks TypeSafe's Jev (`api.typesafe.ai/v1/systemone`) how much effort each typed prompt needs and rewrites `effort` on every main-loop request of that turn. It never changes the main loop's model. Off by default; toggled per session with `/jev on|off|status`.

It is a fork of `jjjjjjjjjjjjjjjjacob/jev-router` (MIT, commit `50d7e40`). README, code and comments are in English.

## Commands

```bash
bun install
bun test ./test                      # unit tests for hooks/lib (Bun)
bun test test/policy.spec.ts         # single unit test file
bun test ./test -t "decideEffort"    # filter by test name
claude plugin test .                 # engine tests: hooks/register.test.ts on Claude Code's real engine
claude plugin validate .
tsc -p tsconfig.bun.json && tsc -p . # tsc -p . needs .claude-plugin/types (generated, gitignored) — load once with `claude --plugin-dir .` first
TYPESAFE_API_KEY=… bun eval/run.ts   # live calibration eval; --no-redact (raw prompts), --replay (policy only on last run)
```

Run locally: `claude --plugin-dir .`.

## Architecture

Two separate TypeScript worlds with separate tsconfigs:

- **`hooks/register.ts`** — the mod entry (listed in `hooks/hooks.json`). Runs inside Claude Code's engine, imports types from `"claude-code"`, uses only the engine's `$` interface (`$.http.fetch`, `$.clock`, `$.store`, `$.env`, `$.ui`, `$.command`) — no Bun/Node APIs. Type-checked by `tsconfig.json`; tested by `hooks/register.test.ts` via `claude-code/testing`, where `world()` mocks everything beneath the mod (http, clock, store, env, `turn.step` responses).
- **`hooks/lib/*`** — pure libraries, no engine dependency. Type-checked by `tsconfig.bun.json` together with `test/` and `eval/`, and unit-tested with `bun:test`.

Hook flow in `register.ts` (session state is module-level; resets on plugin reload):

1. `prompt.submit` marks prompts the person typed (origin `composer`/`bridge`/`sdk`, no `turnId`) by `promptKey`. Notifications, peers, prompts folded into a running turn are not marked.
2. `turn.start` asks Jev once for a marked prompt (`shapePrompt` → `effortQuestions` → `readEffortAnswers` → `decideEffort` → `capLevel` to `max_effort`), stores the route by `turnId`.
3. `turn.step` rewrites `effort` on each main-loop request of that turn (skips steps with `agentId` — subagents keep their own effort; skips non-cache-safe models when `cache_safe_only`). Also feeds every step's usage to `CacheGuard`, which warns on the first effort-change cache miss and disables routing on the second.
4. `turn.complete` drops the route; the next turn starts at the session level.
5. `agent.spawn` routes a subagent's **model** (not effort) to `judgment_model` or `delegated_model` via `subagentQuestions` / `decideSubagentModel`; skips forks and `SKIPPED_SUBAGENT_TYPES`.

Library roles: `jev.ts` (request build/parse, base-URL allowlist: https or http-to-localhost only), `policy.ts` (thresholds → level, subagent model choice), `questions.ts` (the Jev questions), `redact.ts` (pasted/code blocks, secrets, URLs, emails, IPs, absolute paths → markers; 3000 head + 1000 tail truncation), `cache-guard.ts`.

## Invariants

- **Fail open everywhere**: no key, bad base URL, timeout, error, or low-confidence answer → leave the turn at the session's effort. `askJev` never throws.
- **`hooks/lib/questions.ts` is kept verbatim from upstream** — Jev interprets the wording literally. Changing it (or `policy.ts` thresholds, or the pinned `jev-1.13.0` model) requires rerunning the live eval.
- In `register.ts`, `$` may only be passed to top-level helper functions (see the helpers section comment).
- Plugin options are declared in `.claude-plugin/plugin.json` `userConfig` and read in `register()`; keep both in sync with the README options table.
- `eval/fixtures.local.jsonl` and `eval/results/` are gitignored; local (e.g. Vietnamese) prompts go in the local fixtures file.
