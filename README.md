# jeffort

A Claude Code mod that asks [Jev](https://typesafe.ai) (TypeSafe) how much effort each prompt needs, then sends every request of that turn at that effort. The main loop's model is never changed. Off by default; turn it on with `/jev on`.

This is a fork of [jjjjjjjjjjjjjjjjacob/jev-router](https://github.com/jjjjjjjjjjjjjjjjacob/jev-router) (MIT), taken from commit `50d7e40` on 2026-09-27. The questions sent to Jev (`hooks/lib/questions.ts`), the level policy (`hooks/lib/policy.ts`) and the eval set are kept from upstream. The parts that apply effort and filter data were rewritten.

## How it differs from upstream

| | upstream jev-router | jeffort |
| --- | --- | --- |
| How effort is applied | Tells Claude to load a `jev-<level>` skill and blocks tool calls until it does | A `turn.step` mod writes `effort` into each request of the turn |
| Turns that call no tools | May run at the session level (skill skipped) | Still routed |
| Turns from notifications, peers, plugins | Routed like ordinary prompts | Skipped; only prompts you type are routed |
| Data sent to TypeSafe | Prompt (pasted blocks removed), head/tail truncated | Same as upstream, plus masking of code blocks, secrets, URLs, e-mails, IPs and absolute paths |
| Highest effort | `max` | `xhigh` (configurable) |
| Cache | Trusts the docs | Watches real `cache_read`/`cache_creation`, warns and then pauses when an effort change loses the cache |
| Subagents | Inherit the turn's effort; model routed by judgment/delegated | Keep their own effort; model routed as upstream, via `agent.spawn` |
| Runtime | Bun/Node, shell scripts, tool-call hooks | Runs inside Claude Code's engine; no Bun/Node needed |

## Install

Requires Claude Code **2.1.289** or later (the tested version) and a TypeSafe API key.

```bash
# 1. Get the code
git clone git@github.com:vntrungld/jeffort.git ~/tools/jeffort

# 2. Key: store it in the keychain via /plugin configure (step 4), or set the env var
export TYPESAFE_API_KEY=...

# 3a. Try it for one session:
claude --plugin-dir ~/tools/jeffort

# 3b. Or install it permanently from the vntrungld marketplace (hosted in the tightlip repo):
claude plugin marketplace add vntrungld/tightlip
claude plugin install jeffort@vntrungld
```

The `vntrungld` marketplace lives in [vntrungld/tightlip](https://github.com/vntrungld/tightlip) and lists both of its plugins; this repo has no marketplace of its own, so adding it can't replace that one. The permanent install pulls jeffort from GitHub, so for local edits use `--plugin-dir` (step 3a).

4. In Claude Code: `/plugin configure jeffort@vntrungld` to enter the key and adjust options. The non-sensitive options are also in `/config`.

If your organization sets `allowManagedModsOnly` or `allowManagedHooksOnly` in managed settings, the mod will not load. If your Claude Code is older and reports that function hooks are disabled, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Usage

```
/jev on       turn on for this session
/jev status   show state and the last 8 decisions
/jev off      turn off
```

Each routed turn shows a dim line such as `jev → high · verification decides success (conf 0.72)`. The status line shows `jev · <level>` while routing is on. The next turn goes back to the session level unless Jev picks another level.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `typesafe_api_key` | (empty) | The key. When empty, reads `TYPESAFE_API_KEY` or `JEV_API_KEY` |
| `enabled_by_default` | `false` | Start every session with routing on |
| `max_effort` | `xhigh` | Highest level the router may pick |
| `route_subagents` | `true` | Route subagent models |
| `judgment_model` / `delegated_model` | `opus` / `sonnet` | Model for review/debug/design subagents, and for subagents doing delegated work |
| `redact` | `true` | Mask data before sending (see below) |
| `cache_safe_only` | `true` | Only change effort on Opus 5.5, Sonnet 5.5, Fable 5.1 |
| `cache_guard` | `true` | Warn on the first cache miss, pause on the second |
| `timeout_ms` | `2500` | How long to wait for Jev before the turn runs at the session level |
| `show_decisions` | `true` | Show the `jev → …` line |
| `base_url` | `https://api.typesafe.ai` | https only, or http to localhost |
| `jev_model` | `jev-1.13.0` | Pinned because the policy thresholds were tuned on this version |

## What gets sent

Only while routing is on, and only for prompts you type (no slash commands, notifications, or messages from other sessions). Each turn makes **one** request to `api.typesafe.ai/v1/systemone`, containing:

- the current prompt after filtering, at most the first 3,000 and last 1,000 characters;
- the first 1,500 characters of the previous prompt (filtered), so Jev recognizes "ok, go ahead";
- for subagents: the Agent call's `prompt` and `description`, also filtered.

The filter replaces:

| Content | With |
| --- | --- |
| pasted block | `[pasted text: N chars]` |
| fenced ``` code block | `[code block: N lines]` |
| inline code of 40+ characters | `[code]` |
| PEM keys, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, JWTs, `password=…`, long hex or base64 | `<secret>` |
| URLs, DSNs (`postgres://…`) | `<url>` |
| e-mail | `<email>` |
| IPv4 | `<ip>` |
| absolute paths, `~/…`, `C:\…` | `<path>` |

Kept: short function names in backticks (`getUser`) and relative paths (`app/Http/Kernel.php`), since they tell Jev what kind of work is being asked for. The filter is regex-based, not DLP: unusual secret formats or lowercase customer names can slip through. For company repositories, check your internal policy before turning it on.

Locally, decisions are kept in the mod's `$.store` (at most 200 entries, each the first 80 characters of the filtered prompt) for tuning thresholds later.

## Test results

- `bun test ./test`: 79 unit tests for the policy (ported from upstream), the filter, the Jev client and the cache guard.
- `claude plugin test .`: 18 tests running the mod on Claude Code's real engine (per-turn routing, subagents, notifications, timeouts, base URL, filtering, cache guard, `/jev`). Three key behaviours were deliberately broken (skipping subagent steps, filtering, routing only cache-safe models) to confirm the tests catch each one.
- `claude plugin validate .` and `tsc` are clean.
- **Real run in a headless Claude Code 2.1.289 session** (Sonnet 5.5), against a mock Jev server on localhost:
  - The transcript records `effort: high` / `low` correctly for each routed turn, so the effort really reaches the API.
  - In the test environment (a cloud container, requests going through an `ANTHROPIC_BASE_URL` proxy), each effort change kept the cache for the system prompt and tools (~13k tokens) but **rewrote the conversation part** (~4.5k tokens). Claude Code's built-in `/effort` command costs exactly the same, so this cost comes from the environment, not the mod. The cache guard caught it and paused routing after the second time.

**Not yet verified:**
1. TypeSafe has not been called for real (no key), so the 97% accuracy is upstream's number, measured on unfiltered English prompts. The filter changes none of upstream's 42 fixtures, since they contain no code or sensitive data; your real prompts will differ. Run `TYPESAFE_API_KEY=… bun eval/run.ts` and `--no-redact` to compare, then add your own real prompts to `eval/fixtures.local.jsonl`.
2. Not tested on a machine with a subscription calling the API directly. Per the docs, effort changes keep the cache there; check the `Prompt cache (main)` line in `/usage`, or let the cache guard check for you.
3. Subagent routing has not been tested in a real session, only through the engine test suite.

## Development

```bash
bun install
bun test ./test            # unit tests
claude plugin test .       # mod tests on the engine
claude plugin validate .
tsc -p tsconfig.bun.json && tsc -p .   # tsc -p . needs .claude-plugin/types, generated by the engine when loaded with --plugin-dir
TYPESAFE_API_KEY=… bun eval/run.ts     # live eval; --no-redact; --replay
```

`hooks/lib/questions.ts` is kept word for word, because Jev reads the questions literally. Changing the wording means rerunning the live eval.

## License

MIT. See `LICENSE`: original copyright by jjjjjjjjjjjjjjjjacob, modifications by this fork.
