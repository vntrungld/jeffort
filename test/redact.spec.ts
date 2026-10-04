import { describe, expect, test } from "bun:test";
import { promptKey, redact, shapePrompt, truncate } from "../hooks/lib/redact.ts";

const sent = (raw: string) => {
  const shaped = shapePrompt(raw);
  if (shaped.skip) throw new Error(`unexpected skip: ${shaped.reason}`);
  return shaped.text;
};

describe("shapePrompt (upstream behavior)", () => {
  test("skips empty and slash-command prompts", () => {
    expect(shapePrompt("   ")).toEqual({ skip: true, reason: "empty" });
    expect(shapePrompt(undefined)).toEqual({ skip: true, reason: "empty" });
    expect(shapePrompt("/jev off")).toEqual({ skip: true, reason: "slash-command" });
  });

  test("replaces pasted blocks with a size marker", () => {
    const raw = 'fix this\n<pasted_content id="a1">\nsecret=hunter2\nline two\n</pasted_content id="a1">\nplease';
    expect(sent(raw)).toBe("fix this\n[pasted text: 23 chars]\nplease");
  });

  test("keeps head and tail of a long prompt", () => {
    const text = sent(`${"x ".repeat(1750)}${"z ".repeat(750)}`.trim());
    expect(text.startsWith("x ".repeat(1500))).toBe(true);
    expect(text.endsWith(" z".repeat(500))).toBe(true);
    expect(text).toContain("chars omitted");
  });

  test("truncate leaves short text alone", () => {
    expect(truncate("short")).toBe("short");
  });

  test("redaction can be turned off", () => {
    const shaped = shapePrompt("see https://internal.example.com/x", { redact: false });
    expect(shaped).toEqual({ skip: false, text: "see https://internal.example.com/x", redactions: 0 });
  });
});

describe("redact", () => {
  test.each([
    ["fenced code", "fix:\n```php\n$a = 1;\n$b = 2;\n```\nthanks", "fix:\n[code block: 2 lines]\nthanks"],
    ["unclosed fence", "look\n```\nconst x = 1", "look\n[code block: 1 lines]"],
    ["long inline code", "run `SELECT * FROM orders WHERE shop_id = 42 AND status = 'paid'` now", "run [code] now"],
    ["short inline code stays", "rename `getUser` to `fetchUser`", "rename `getUser` to `fetchUser`"],
    ["https URL", "check https://posthog.teeinblue.com/project/1?x=2 please", "check <url> please"],
    ["DSN", "DATABASE_URL=postgres://app:pw@db.internal:5432/main", "DATABASE_URL=<url>"],
    ["email", "ask duc@ownego.com", "ask <email>"],
    ["ip and port", "redis at 10.0.0.12:6379", "redis at <ip>"],
    ["absolute path", "error in /var/www/app/Services/Billing.php line 4", "error in <path> line 4"],
    ["home path", "config in ~/.claude/settings.json", "config in <path>"],
    ["windows path", "C:\\Users\\duc\\proj\\a.ts fails", "<path> fails"],
    ["relative path stays", "edit app/Http/Kernel.php", "edit app/Http/Kernel.php"],
    ["key=value secret", "password: hunter2 and token=abc", "password: <secret> and token=<secret>"],
    ["anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstuv", "key <secret>"],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "<secret>"],
    ["aws key", "AKIAABCDEFGHIJKLMNOP leaked", "<secret> leaked"],
    ["jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "Bearer <secret>"],
    ["long hex", "commit 3f786850e387550fdab836ed7e6dc881de23001b", "commit <secret>"],
    ["pem", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "<secret>"],
    ["dates and fractions stay", "due 2026/10/04, ratio 3/4, and/or later", "due 2026/10/04, ratio 3/4, and/or later"],
    ["vietnamese text stays", "sửa lỗi thanh toán bị trùng khi retry", "sửa lỗi thanh toán bị trùng khi retry"],
  ])("%s", (_name, input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  test("counts what it replaced", () => {
    expect(redact("a@b.co and 1.2.3.4").count).toBe(2);
  });
});

test("promptKey ignores whitespace differences", () => {
  expect(promptKey("  fix   the\nbug ")).toBe(promptKey("fix the bug"));
});

test("an import alias is not a path", () => {
  expect(redact("Cannot find module '@/lib/utils'").text).toBe("Cannot find module '@/lib/utils'");
});
