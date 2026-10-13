# C组（R71–R100）发现的问题清单

> 基线 commit：d6ad08f。以下均为实测复现。
> **状态更新（2026-10-13 12:5x）**：BUG-1、BUG-2 已按"修复-验证闭环"修复并回归通过（32/32），
> 详情见 [C-fixes.md](./C-fixes.md)。proxy.mjs 当前 diff 仅含这两处修复（+13/-7 行）。

## BUG-1（R99）：双 `-search` 后缀只剥一层，残留 `-search` 进入上游 model

- **位置**：`proxy.mjs` 约 3342 行（`body.model.endsWith("-search")` 单次剥离）
- **现象**：客户端传 `model: "mimo-v2.6-flash-free-search-search"`，proxy 只剥掉一层，
  发往上游的 model 为 `"mimo-v2.6-flash-free-search"`（结尾仍带 `-search`），违反 R96
  "-search 后缀永不进入上游请求体"。真实上游会因此 400（无此模型）。
- **复现请求**：
  ```
  POST http://127.0.0.1:18783/v1/chat/completions
  {"model":"mimo-v2.6-flash-free-search-search","stream":true,
   "messages":[{"role":"user","content":"SCN:text MARK:ZC99c"}]}
  ```
  上游请求体（`test-scratch/requests-full.jsonl`，mark=ZC99c）：`body.model="mimo-v2.6-flash-free-search"`
- **建议修复**：剥离改循环/正则，一次性去掉全部连续后缀，如
  `body.model = body.model.replace(/(-search)+$/, "")`（剥完为空仍报 400"模型名无效"）。
- **严重程度**：低（需用户手误输入双后缀才会触发，但属于输入清洗不彻底）

## BUG-2（R100）：`content_filter` 在翻译路径丢失，变成 stop/end_turn

- **位置**：
  - `proxy.mjs:832`（`streamResponsesToChat` 流式）：
    `finish(hasTools ? "tool_calls" : reason === "max_output_tokens" ? "length" : "stop")`
  - `proxy.mjs:1448`（`streamResponsesToAnthropic` 流式）：`max_output_tokens → "max_tokens"`，其余 → `"end_turn"`
  - `proxy.mjs:2828`（非流式 chat 翻译 `sseToResponses`/`responsesToChatCompletion`）：
    `resp.incompleteReason === "max_output_tokens" ? "length" : "stop"` —— 非流式同样丢失
- **现象**：上游 `response.incomplete` + `incomplete_details.reason="content_filter"` 时，
  - `/v1/chat/completions`（spark 翻译路径）客户端收到 `finish_reason: "stop"`（期望 `content_filter`）
  - `/v1/messages` 客户端收到 `stop_reason: "end_turn"`（期望 `content_filter`）
  - 直接路径（mimo，上游原生 `finish_reason: "content_filter"`）透传正确，不受影响
  - 客户端会把被安全过滤截断的回答误当成正常结束。
- **复现请求**：
  ```
  POST http://127.0.0.1:18783/v1/chat/completions
  {"model":"muse-spark-1.3-contributor-free","stream":true,
   "messages":[{"role":"user","content":"SCN:cf MARK:ZC100h"}]}
  POST http://127.0.0.1:18783/v1/messages
  {"model":"muse-spark-1.3-contributor-free","max_tokens":256,"stream":true,
   "messages":[{"role":"user","content":"SCN:cf MARK:ZC100l"}]}
  ```
- **建议修复**：两个分支加 `reason === "content_filter"` 映射：
  chat 侧 → `"content_filter"`；anthropic 侧 → `"content_filter"`（Anthropic 原生支持该 stop_reason）。
- **严重程度**：低（上游实际返回 content_filter 截断较少见；但信息丢失属翻译保真度问题）

## 观察（R88，非 bug）：上游空 SSE 流时未补发 `data: [DONE]`

- **位置**：`proxy.mjs` `streamChatDirectWithIntercept`（透传路径）
- **现象**：`SCN:empty`（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，
  无 `data: [DONE]`。R88 本轮判 PASS（不崩不挂起），但严格的 OpenAI 客户端可能等待
  `[DONE]` 才认为流结束。
- **建议**：translator 正常返回且 `intercepted` 为空时，若全程未发出过 `[DONE]` 则补发一行。
  注意 responses/anthropic 协议本身无 `[DONE]`，只应在 chat 路径补。
- **严重程度**：极低（上游正常时从不断流；仅上游返回空 body 的异常场景）

## R99 其他变体行为记录（非 bug，仅备查）

- `MIMO-V2.6-FLASH-FREE`（全大写）：按非 spark 模型走 chat 直连，上游 model 原样透传，
  未做大小写归一化。真实上游会 400（模型名大小写敏感），属用户输入问题，proxy 未崩。
- `" mimo-v2.6-flash-free "`（首尾空格）：未 trim，原样发上游。建议可加 `trim()`，非必须。
- `"mimo-v2.6-flash-free-SEARCH"`（大写后缀）：大小写敏感，未触发 `-search` 开关，
  未注入搜索工具。文档约定为小写后缀，行为一致，备查。
- `"mimo-search-v2.6-flash-free"` / `"-searchmimo-v2.6-flash-free"`（-search 在中间/开头）：
  非后缀，不剥离、不触发搜索注入，正确。
- `"-search"`（纯后缀）：干净 400「模型名无效」，正确。

## R88 观察：上游空 SSE 流时 proxy 未补发 data: [DONE]
- 现象：SCN:empty（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，无 data: [DONE]。
- 位置：proxy.mjs streamChatDirectWithIntercept（透传路径不补终结符）。
- 建议：translator 正常返回且 intercepted 为空时，若未发出过 [DONE] 则补发。

## R88 观察：上游空 SSE 流时 proxy 未补发 data: [DONE]
- 现象：SCN:empty（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，无 data: [DONE]。
- 位置：proxy.mjs streamChatDirectWithIntercept（透传路径不补终结符）。
- 建议：translator 正常返回且 intercepted 为空时，若未发出过 [DONE] 则补发。

## R88 观察：上游空 SSE 流时 proxy 未补发 data: [DONE]
- 现象：SCN:empty（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，无 data: [DONE]。
- 位置：proxy.mjs streamChatDirectWithIntercept（透传路径不补终结符）。
- 建议：translator 正常返回且 intercepted 为空时，若未发出过 [DONE] 则补发。

## R88 观察：上游空 SSE 流时 proxy 未补发 data: [DONE]
- 现象：SCN:empty（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，无 data: [DONE]。
- 位置：proxy.mjs streamChatDirectWithIntercept（透传路径不补终结符）。
- 建议：translator 正常返回且 intercepted 为空时，若未发出过 [DONE] 则补发。
