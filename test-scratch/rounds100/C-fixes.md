# C组（R71–R100）修复记录（修复-验证闭环）

> 基线 commit：d6ad08f。未 git commit。修复经加锁协议（`.fixlock`）执行，proxy 18783/18784 已重启生效。

## FIX-1（R99）：双 `-search` 后缀只剥一层

- **轮次**：R99（R96 扫描同步验证）
- **位置**：`proxy.mjs:3342-3343`
- **现象**：`model: "mimo-v2.6-flash-free-search-search"` 只剥掉一层后缀，
  上游收到 `model: "mimo-v2.6-flash-free-search"`（结尾残留 `-search`），真实上游会 400。
- **修复内容**（1 行）：
  ```diff
  -        body.model = body.model.slice(0, -"-search".length);
  +        body.model = body.model.replace(/(-search)+$/, "");
  ```
  一次性剥掉全部连续 `-search` 后缀；剥完为空仍走原有 `400 模型名无效` 分支。
- **回归结果**：R99 PASS（双后缀 → 上游 `mimo-v2.6-flash-free`，forceSearch 正常触发）；
  R96 PASS；其余 30 轮无回归。32/32。

## FIX-2（R100）：`content_filter` 在翻译路径丢失

- **轮次**：R100
- **现象**：上游 `response.incomplete` + `incomplete_details.reason="content_filter"` 时，
  翻译路径把终结符降级为 `stop`（chat）/`end_turn`（anthropic），客户端会把被安全过滤
  截断的回答误判为正常结束。直接路径（上游原生 `finish_reason`）透传正确，不受影响。
- **修复内容**：6 处同类映射，各加 `content_filter` 分支（最小化改动，不碰其他逻辑）：
  1. `proxy.mjs:832`（`streamResponsesToChat` 流式）：
     `reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "stop"`
  2. `proxy.mjs:1076`（`streamChatToAnthropic` 流式，非 spark 模型）：
     `finishReason === "length" ? "max_tokens" : finishReason === "content_filter" ? "content_filter" : "end_turn"`
  3. `proxy.mjs:1448`（`streamResponsesToAnthropic` 流式）：
     `incompleteReason === "max_output_tokens" ? "max_tokens" : incompleteReason === "content_filter" ? "content_filter" : "end_turn"`
  4. `proxy.mjs:2828`（非流式 chat 翻译）：`incompleteReason === "content_filter" → "length"` 旁加 `"content_filter"` 分支
  5. `proxy.mjs:3027`（非流式 anthropic 翻译，responses 上游）：同上 → `"content_filter"`
  6. `proxy.mjs:4160`（非流式 anthropic 翻译，chat 上游）：`_fr === "content_filter" ? "content_filter" : "end_turn"`
- **回归结果**：R100 PASS，实测映射表：
  `chat: stop/length/tool_calls/content_filter`，
  `spark-chat: stop/length/tool_calls/content_filter`，
  `anthropic: end_turn/max_tokens/tool_use/content_filter`，
  `error: N/A（协议无此终结符，错误走 HTTP 状态码）`。
  其余 31 轮无回归。32/32。

## 未修复项

- R88 观察（上游空 SSE 流时 chat 透传路径未补 `data: [DONE]`）：属极低频异常场景的
  体验优化，非正确性 bug；改动涉及流终结语义，需用户拍板后再动。已记入 C-bugs.md。
