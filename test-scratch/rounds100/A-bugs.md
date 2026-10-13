# A 组（R01–R40）发现的 bug 清单

> 测试时间：2026-10-13 约 12:35（基线 commit d6ad08f）。proxy.mjs 未改动，只记录。

## BUG-1（R08 FAIL）：B8 修得不彻底 —— /v1/responses + 非 spark + -search 时 webfetch/websearch 仍被注入上游

- **位置**：`~/workspace/opencode-proxy/proxy.mjs:3398`（`ensureResponsesTools(body)` 调用处）与 `:3455–3471`（translateToChat 分支）
- **现象**：`POST /v1/responses`，model=`mimo-v2.6-flash-free-search`，上游 `/zen/v1/chat/completions` 请求的 tools 为 `["read","shell","webfetch","websearch"]`，按 B8 意图应只有 `["read","shell"]`。对照组（同请求不带 `-search`）上游 tools 为 `["read","shell"]`，符合预期。
- **根因**：B8 只给 translateToChat 分支里的 `ensureChatTools(chatBody, true)` 加了 `skipProxyTools`，但 `ensureResponsesTools(body)` 在前面的通用分支（3398 行，`upstreamPath === "/zen/v1/responses" && url.pathname !== "/v1/messages"`）里已经按 `requestForceSearch` 把 webfetch/websearch 注入了 `body.tools`；随后 `responsesToChatBody(body)` 把它们原样带进 `chatBody`。`skipProxyTools` 只能阻止"再注入"，去不掉已经注入的。
- **附加问题**：3471 行在此时还打印日志"注意：-search 搜索暂不支持非 spark 模型，已跳过搜索工具注入"（本次测试中出现 2 次），与实际行为矛盾，会误导排查。
- **影响**：translateToChat 路径无拦截逻辑（`proxyInterceptNames` 为 `ensureChatTools` 返回的空集），模型若调用 webfetch/websearch，tool_call 会被透传给客户端（客户端从未声明这些工具）→ 客户端报错或产生坏调用。正是 B8 注释里要防的后果（"反而透传坏的 tool_call 给客户端"）。
- **复现请求**：
  ```json
  POST http://127.0.0.1:18781/v1/responses
  {"model":"mimo-v2.6-flash-free-search","stream":false,"input":"SCN:text MARK:R08"}
  ```
  然后查 `test-scratch/requests.jsonl` 里 `mark=="R08"` 的条目，看 `toolNames`。
- **建议修复**：把 translateToChat 的判定提前到 `ensureResponsesTools` 之前，或给 `ensureResponsesTools` 加 `skipProxyTools` 参数（translateToChat 时不注入代理工具）；同时修正/删除那句误导性日志。注意 `/v1/messages` + 非 spark 路径不受影响（3398 行已排除 messages，且走 `anthropicToChatBody` 不经过 `ensureResponsesTools`），修的时候别扩大化。
- **备注**：`/v1/chat/completions` + 非 spark（direct 路径）的 `-search` 注入是预期行为（该路径有拦截逻辑），不在本 bug 范围内。

## BUG-2（R38 调查中发现）：B5 漏了流式那处 —— streamChatToAnthropic 的 message_delta 丢 input_tokens 且无命名回退

- **位置**：`~/workspace/opencode-proxy/proxy.mjs:1076–1083`（`streamChatToAnthropic` 结尾）
- **现象**：`POST /v1/messages`，model=`mimo-v2.6-flash-free`（非 spark），`stream:true`，客户端收到的 `message_delta` 为：
  ```json
  {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}
  ```
  两个问题：(1) `usage` 里整个缺失 `input_tokens` 字段（Anthropic 流式规范里 message_delta.usage 应含 input_tokens/output_tokens；同文件的 `streamResponsesToAnthropic` 就是全量发的）；(2) `output_tokens` 为 0 —— mock 上游回的是非标准命名 `input_tokens=11/output_tokens=7`，B5 的回退（`?? usage.input_tokens`）只加到了非流式组装（4131 行），流式这处 `usage?.prompt_tokens ?? 0` / `usage?.completion_tokens ?? 0` 漏了。
- **生产影响说明**：真实上游 chat 接口回标准命名时，数值是对的，但 `input_tokens` 字段缺失是稳定复现的（与上游命名无关）。
- **复现请求**：
  ```json
  POST http://127.0.0.1:18781/v1/messages
  {"model":"mimo-v2.6-flash-free","stream":true,"max_tokens":1024,"messages":[{"role":"user","content":"SCN:text MARK:DBGU"}]}
  ```
  看最后一个 SSE `data` 行（message_delta）的 usage。
- **建议修复**：
  ```js
  const outUsage = {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
  };
  // ...
  emitEvent({ type: "message_delta", delta: { stop_reason: stopReason }, usage: outUsage });
  ```
  即补上回退，并把 `input_tokens` 发出去（与 `streamResponsesToAnthropic` 对齐）。

## 说明： honest 标注的"代码级确认"项（非 bug）

以下场景 mock 上游造不出来，测试里如实标注为代码级确认 + 相邻行为端到端通过，不算 FAIL：

- R10/B10：mock 无法产生稀疏索引的 tool_calls（`filter(Boolean)` 防的是上游坏数据），正常组装端到端通过。
- R11/B11：mock 无法产生被转义坏的 shell 参数（如 `/\"echo ok\"/`），门控逻辑（仅 `name==="shell"` 或以 `.shell` 结尾才清理）经代码确认；`my.shell` 工具的干净参数原样透传，`get_weather` 同样不受影响。
- R12/B12：mock 无 `finish_reason=length` 场景，`length→max_tokens` 两处映射（流式 `streamChatToAnthropic:1076`、非流式 translateToChat 组装 `:4160`）经 grep 确认存在；`stop→end_turn`、`tool_calls→tool_use` 端到端通过。
- R38：mock 无法强制上游截断；`max_tokens:5` 下 `stop_reason` 仍为 `end_turn`，无误报。
- R39：mock 每轮只回一个 tool_call，多工具并行调用不可触发；已验证多工具声明能完整透传到上游（`nTools`/toolNames）。
