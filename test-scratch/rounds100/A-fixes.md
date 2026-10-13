# A 组修复记录（修复-验证闭环）

> 基线：d6ad08f。未 git commit。持锁修复，锁已释放。

## FIX-1（R08，BUG-1）：translateToChat 路径仍注入 webfetch/websearch

- **轮次**：R08（B8 回归）
- **位置**：`~/workspace/opencode-proxy/proxy.mjs`
  - `ensureResponsesTools(body)` → `ensureResponsesTools(body, skipProxyTools = false)`（约 547 行）
  - 注入行：`const proxyTools = requestForceSearch && !skipProxyTools ? ALL_PROXY_TOOLS_RESPONSES : []`（约 567 行）
  - 调用处（约 3444–3452 行）：判定 `_skipProxy = typeof body?.model === "string" && !body.model.startsWith("muse-spark-")`，与下方 translateToChat 分支的模型判定条件一致
- **现象**：`/v1/responses` + 非 spark 模型 + `-search` 后缀时，上游 `/zen/v1/chat/completions` 的 tools 为 `["read","shell","webfetch","websearch"]`。B8 只给 `ensureChatTools(chatBody, true)` 加了 `skipProxyTools`，但 `ensureResponsesTools(body)` 在前面的通用分支里已按 `requestForceSearch` 注入，`responsesToChatBody` 原样带入；且日志谎称"已跳过搜索工具注入"。
- **修复内容**：给 `ensureResponsesTools` 加 `skipProxyTools` 可选参数（默认 false，其他两处调用点行为不变）；在 `/v1/responses` 通用分支调用时，若模型是非 spark（即随后会走 translateToChat），传 `true` 跳过代理工具注入。伪装工具 read/shell 的注入不受影响。
- **回归结果**：重跑 40 轮，R08 变 PASS（上游 tools 实测为 `["read","shell"]`）；其余 39 轮保持 PASS。**40/40 PASS**。
- **备注**：`/v1/messages` + 非 spark 路径不受影响（该分支本就不调 `ensureResponsesTools`）；`/v1/chat/completions` direct 路径的 `-search` 注入是预期行为（有拦截逻辑），未动。

## FIX-2（R38 调查中发现，BUG-2）：streamChatToAnthropic 的 message_delta 丢 input_tokens 且无命名回退

- **轮次**：R38 调查时发现（A-bugs.md BUG-2）
- **位置**：`~/workspace/opencode-proxy/proxy.mjs` 约 1095–1101 行（`streamChatToAnthropic` 结尾）
- **现象**：`/v1/messages` + 非 spark + 流式时，`message_delta` 的 usage 只有 `{"output_tokens":0}`：`input_tokens` 字段缺失，且无 `input_tokens/output_tokens` 命名回退（B5 只修了非流式组装）。
- **修复情况**：**本组持锁前，别组已先修好**（其改动：`input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0`、`usage: { input_tokens, output_tokens }` 全量发出，另附带 content_filter 映射与工具名分片修复）。本组未重复改动，避免冲突；两组 diff 已对照确认无重叠冲突。
- **回归结果**：实测验证 `message_delta` usage 现为 `{"input_tokens":11,"output_tokens":7}`（mock 非标准命名经回退正确解析，`input_tokens` 已发出）。40 轮重跑中 R38 及全部 messages 相关轮次 PASS。

## 最终状态

- `proxy.mjs` 当前 diff vs d6ad08f：本组 FIX-1（ensureResponsesTools skipProxyTools）+ FIX-3（incomplete 翻转双路径）+ FIX-4（工具名翻倍双处）+ 别组改动（content_filter 映射多处、工具名分片判定、-search 正则剥离、BUG-2 修复、空 body 400、API key 文件）。各组 diff 已对照，无冲突。
- A-results.jsonl：52/52 PASS（R01–R40 + 深挖 R41–R52，最后一次全量重跑）。
- A-bugs.md 中的 BUG-1/BUG-2/BUG-3 均已修复，无遗留已知问题。

## FIX-3（R44/R45/R52，BUG-3）：translateToChat 翻转路径把 length 硬编码成 status completed

- **轮次**：R44（非流式）、R45（流式）、R52（content_filter 非流式）
- **位置**：`~/workspace/opencode-proxy/proxy.mjs`
  - 非流式 chat→Responses 组装（约 4287 行）：`status: "completed"` 硬编码
  - 流式 `streamChatToResponses` 收尾（约 1024 行）：`type: "response.completed"` + `status: "completed"` 硬编码
- **现象**：`/v1/responses` + 非 spark 模型时，上游 chat `finish_reason=length` 被翻成 `status:"completed"` 的 Responses 响应；按 OpenAI Responses 规范应为 `status:"incomplete"` + `incomplete_details.reason="max_output_tokens"`（content_filter 同理）。spark 直连路径是透传上游的 incomplete 事件的，翻转路径与之不一致，客户端无法识别截断。
- **修复内容**（最小化）：
  - 非流式：`const _fr2 = chatObj.choices?.[0]?.finish_reason;` → `_incReason` 映射（length→max_output_tokens，content_filter→content_filter），`status` 按是否有 `_incReason` 取值，带上 `incomplete_details`。
  - 流式：`streamChatToResponses` 已跟踪 `finishReason`，收尾 emit 改为 `_incReason ? "response.incomplete" : "response.completed"`，同样带 `incomplete_details`。
- **回归结果**：R44（`status=incomplete`+`reason=max_output_tokens`）、R45（`response.incomplete` 事件）、R52（`reason=content_filter`）均由 FAIL 变 PASS；R01–R40 重跑 40/40。

## FIX-4（R48/R49）：别组分片改动引入的工具名翻倍（`get_weatherget_weather`）

- **轮次**：R48、R49（深挖中新发现；属别组/D组分片功能的回归）
- **位置**：`~/workspace/opencode-proxy/proxy.mjs`
  - `streamChatToResponses`（约 977 行）：`entry = { ..., name: tc.function?.name || "", ... }` + `entry.name += tc.function.name`
  - `streamChatToAnthropic`（约 1072 行）：`entry = { ..., name: tc.function?.name || "", ... }` + `entry.name += nameFrag`
- **现象**：别组把 `entry.name = tc.function.name` 改成 `+=` 以支持分片名，但 entry 初始化时已经用首个分片设过 `name`，导致正常（非分片）工具名被拼两次：`get_weather` → `get_weatherget_weather`，客户端 tool_use/function_call 的 name 全错。`streamChatDirectWithIntercept` 的同类代码是对的（else 分支才 `+=`），未动。
- **修复内容**（最小化）：两处 initializer 改为 `name: ""`，累加逻辑不变——分片名（`get_wea`+`ther`）和完整名都能正确组装。
- **回归结果**：R48（tool_use name=`get_weather`，stop=`tool_use`）、R49（function_call 完整参数）由 FAIL 变 PASS；R41（fragname 非流式组装）保持 PASS，分片功能未受影响。
- **备注**：R49 另修正一处测试断言：`streamChatToResponses` 是缓冲后发完整 `output_item.added/done`，不发 `arguments.delta` 逐片事件（设计如此），断言改为检查 added 事件的完整参数。
