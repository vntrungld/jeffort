# jeffort

Mod cho Claude Code: hỏi [Jev](https://typesafe.ai) (TypeSafe) xem mỗi prompt cần effort bao nhiêu, rồi gửi mọi request của lượt đó ở mức effort ấy. Model của luồng chính không bao giờ bị đổi. Mặc định tắt, bật bằng `/jev on`.

Đây là fork của [jjjjjjjjjjjjjjjjacob/jev-router](https://github.com/jjjjjjjjjjjjjjjjacob/jev-router) (MIT), lấy từ commit `50d7e40` ngày 2026-09-27. Bộ câu hỏi gửi Jev (`hooks/lib/questions.ts`), chính sách chọn level (`hooks/lib/policy.ts`) và bộ eval giữ nguyên từ upstream. Phần áp effort và phần lọc dữ liệu được viết lại.

## Khác gì upstream

| | upstream jev-router | jeffort |
| --- | --- | --- |
| Cách áp effort | Bảo Claude load skill `jev-<level>`, chặn tool call cho tới khi load xong | Mod `turn.step` ghi `effort` vào từng request của lượt |
| Lượt trả lời không gọi tool | Có thể chạy ở level của session (bỏ qua skill) | Vẫn được route |
| Lượt từ notification, peer, plugin | Bị route như prompt thường | Bỏ qua, chỉ route prompt bạn gõ |
| Dữ liệu gửi TypeSafe | Prompt (bỏ pasted block), cắt đầu/đuôi | Như upstream, thêm che code block, secret, URL, e-mail, IP, đường dẫn tuyệt đối |
| Effort tối đa | `max` | `xhigh` (chỉnh được) |
| Cache | Tin tài liệu | Theo dõi `cache_read`/`cache_creation` thật, cảnh báo rồi tự dừng khi đổi effort làm mất cache |
| Subagent | Ăn theo effort của lượt; model route theo judgment/delegated | Giữ effort riêng; model route như upstream, qua `agent.spawn` |
| Runtime | Bun/Node, shell script, hook theo tool call | Chạy trong engine của Claude Code, không cần Bun/Node |

## Cài đặt

Yêu cầu: Claude Code **2.1.289** trở lên (bản đã test), và một TypeSafe API key.

```bash
# 1. Đặt repo ở đâu tùy bạn, ví dụ:
mkdir -p ~/tools && tar -xzf jeffort.tar.gz -C ~/tools

# 2. Key: lưu vào keychain qua /plugin configure (bước 4), hoặc đặt env
export TYPESAFE_API_KEY=ts_...

# 3a. Thử nhanh cho một session:
claude --plugin-dir ~/tools/jeffort

# 3b. Hoặc cài cố định từ marketplace local (đọc thẳng từ thư mục, sửa xong /reload-plugins):
claude plugin marketplace add ~/tools/jeffort
claude plugin install jeffort@vntrungld
```

4. Trong Claude Code: `/plugin configure jeffort@vntrungld` để nhập key và chỉnh tùy chọn. Các tùy chọn không nhạy cảm cũng có trong `/config`.

Nếu công ty bật `allowManagedModsOnly` hoặc `allowManagedHooksOnly` trong managed settings, mod sẽ không load. Nếu Claude Code của bạn cũ hơn và báo function hooks đang tắt, đặt `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Dùng

```
/jev on       bật cho session này
/jev status   xem trạng thái và 8 quyết định gần nhất
/jev off      tắt
```

Mỗi lượt được route sẽ hiện một dòng mờ như `jev → high · verification decides success (conf 0.72)`. Thanh trạng thái hiện `jev · <level>` khi đang bật. Lượt sau tự quay về level của session nếu Jev không chọn level khác.

## Tùy chọn

| Tùy chọn | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `typesafe_api_key` | (trống) | Key. Trống thì đọc `TYPESAFE_API_KEY` hoặc `JEV_API_KEY` |
| `enabled_by_default` | `false` | Bật sẵn ở mọi session |
| `max_effort` | `xhigh` | Level cao nhất router được chọn |
| `route_subagents` | `true` | Route model của subagent |
| `judgment_model` / `delegated_model` | `opus` / `sonnet` | Model cho subagent review/debug/thiết kế và cho subagent làm việc được giao |
| `redact` | `true` | Che dữ liệu trước khi gửi (xem bên dưới) |
| `cache_safe_only` | `true` | Chỉ đổi effort trên Opus 5.5, Sonnet 5.5, Fable 5.1 |
| `cache_guard` | `true` | Cảnh báo ở lần mất cache đầu, tự dừng ở lần thứ hai |
| `timeout_ms` | `2500` | Chờ Jev tối đa bao lâu, quá thì lượt chạy ở level của session |
| `show_decisions` | `true` | Hiện dòng `jev → …` |
| `base_url` | `https://api.typesafe.ai` | Chỉ nhận https, hoặc http tới localhost |
| `jev_model` | `jev-1.13.0` | Được ghim vì ngưỡng của policy được hiệu chỉnh trên bản này |

## Dữ liệu gửi đi

Chỉ khi đang bật, và chỉ với prompt bạn gõ (không gửi slash command, notification, tin nhắn từ session khác). Mỗi lượt có **một** request tới `api.typesafe.ai/v1/systemone`, gồm:

- prompt hiện tại sau khi lọc, tối đa 3.000 ký tự đầu và 1.000 ký tự cuối;
- 1.500 ký tự đầu của prompt trước (đã lọc), để Jev nhận ra câu "ok làm đi";
- với subagent: `prompt` và `description` của lệnh Agent, cũng đã lọc.

Phần lọc thay:

| Nội dung | Thành |
| --- | --- |
| pasted block | `[pasted text: N chars]` |
| code block có rào ``` | `[code block: N lines]` |
| inline code dài từ 40 ký tự | `[code]` |
| PEM key, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, JWT, `password=…`, hex hoặc base64 dài | `<secret>` |
| URL, DSN (`postgres://…`) | `<url>` |
| e-mail | `<email>` |
| IPv4 | `<ip>` |
| đường dẫn tuyệt đối, `~/…`, `C:\…` | `<path>` |

Giữ lại: tên hàm ngắn trong backtick (`getUser`) và đường dẫn tương đối (`app/Http/Kernel.php`), vì đó là thứ cho Jev biết việc gì đang được yêu cầu. Bộ lọc dùng regex, không phải DLP: secret dạng lạ hoặc tên khách hàng viết thường vẫn lọt qua. Với repo của công ty, hãy hỏi chính sách nội bộ trước khi bật.

Trên máy, các quyết định được lưu trong `$.store` của mod (tối đa 200 dòng, mỗi dòng là 80 ký tự đầu của prompt đã lọc) để chỉnh ngưỡng sau này.

## Kết quả kiểm tra

- `bun test ./test`: 79 unit test cho policy (port từ upstream), bộ lọc, client Jev và cache guard.
- `claude plugin test .`: 18 test chạy mod trên engine thật của Claude Code (route theo lượt, subagent, notification, timeout, base URL, lọc dữ liệu, cache guard, `/jev`). Đã thử phá 3 hành vi chính (bỏ qua bước của subagent, lọc dữ liệu, chỉ route model giữ cache) để chắc test bắt được từng cái.
- `claude plugin validate .` và `tsc` đều sạch.
- **Chạy thật trong một session headless của Claude Code 2.1.289** (Sonnet 5.5), với một server giả lập Jev chạy trên localhost:
  - Transcript ghi đúng `effort: high` / `low` cho từng lượt được route, nghĩa là effort thực sự tới API.
  - Ở môi trường test (container cloud, request đi qua proxy `ANTHROPIC_BASE_URL`), mỗi lần đổi effort giữ cache của system prompt và tools (~13k token) nhưng **ghi lại phần hội thoại** (~4,5k token). Lệnh `/effort` có sẵn của Claude Code cũng tốn đúng như vậy, nên chi phí này đến từ môi trường, không phải từ mod. Cache guard bắt được và dừng route sau lần thứ hai.

**Chưa kiểm chứng:**
1. Chưa gọi TypeSafe thật (không có key), nên độ chính xác 97% là số của upstream, đo trên prompt tiếng Anh không bị lọc. Bộ lọc không làm thay đổi fixture nào trong 42 fixture của upstream, vì chúng không chứa code hay dữ liệu nhạy cảm; prompt thật của bạn sẽ khác. Hãy chạy `TYPESAFE_API_KEY=… bun eval/run.ts` và `--no-redact` để so, rồi thêm prompt tiếng Việt thật vào `eval/fixtures.local.jsonl`.
2. Chưa test trên máy bạn với subscription gọi thẳng API. Theo tài liệu thì ở đó đổi effort giữ được cache; mở `/usage` xem dòng `Prompt cache (main)`, hoặc để cache guard tự kiểm.
3. Chưa test route subagent trong session thật, mới test qua bộ test của engine.

## Phát triển

```bash
bun install
bun test ./test            # unit test
claude plugin test .       # test mod trên engine
claude plugin validate .
tsc -p tsconfig.bun.json && tsc -p .   # tsc -p . cần .claude-plugin/types, engine tự sinh khi load bằng --plugin-dir
TYPESAFE_API_KEY=… bun eval/run.ts     # eval thật; --no-redact; --replay
```

`hooks/lib/questions.ts` được giữ nguyên từng chữ, vì Jev hiểu câu hỏi theo nghĩa đen. Sửa câu chữ thì phải chạy lại eval thật.

## License

MIT. Xem `LICENSE`: bản quyền gốc của jjjjjjjjjjjjjjjjacob, phần sửa đổi của fork này.
