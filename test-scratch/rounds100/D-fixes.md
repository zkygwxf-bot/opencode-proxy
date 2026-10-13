# 协调人（D组）修复记录（修复-验证闭环）

## FIX-D1：工具名分片三处处理 bug（A7 类）

- **发现**：代码冷读（对照 OpenAI SSE 语义）
- **位置**：
  1. `proxy.mjs:1139`（`streamChatDirectWithIntercept`，即原 A7）：首个 name 分片到达就判定拦截/放行
  2. `proxy.mjs:946`（`streamChatToResponses`）：`entry.name = tc.function.name` 覆盖写，分片时只剩最后一个分片
  3. `proxy.mjs:1041`（`streamChatToAnthropic`）：同上覆盖写 + 首个分片就发 content_block_start（Anthropic 协议 name 发出后无法修正）
- **现象**：上游把 tool 名拆成多个 SSE chunk（如 "webse"+"arch"）时：(1) 拦截判定用残缺名，"websearch" 被误判为客户端工具透传；(2)(3) 客户端收到的工具名为残缺分片
- **修复内容**：
  1. `streamChatDirectWithIntercept`：新增 `decideEntry`/`finalizeUndecided` 闭包；判定条件改为 `st.entry.name && (!nameFrag || argsFrag)`（收齐后再判定）；[DONE]/finish_reason/流结束三处收尾未判定项
  2. `streamChatToResponses`：`=` 改 `+=` 累积（该函数流结束才组装，无需延迟判定）
  3. `streamChatToAnthropic`：`=` 改 `+=` + block_start 改为收齐后触发 + 流结束时补发未 started 的 block（防 tool_call 丢失）
- **回归**：`node --check` 通过；分片专项测试 F1–F4（待 mock 支持 fragname 场景后跑）；三组全量脚本重跑即回归
- **备注**：触发概率低（上游极少拆分工具名），但属于协议正确性问题，修

## FIX-D2：A-BUG-2 一并修复（R38，streamChatToAnthropic message_delta）

- **位置**：`proxy.mjs:1076-1080`（流式 message_delta usage 组装）
- **现象**：`usage` 缺 `input_tokens` 字段；`usage?.prompt_tokens ?? 0` 无 `input_tokens` 回退
- **修复**：`input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0`，`output_tokens` 同理；message_delta.usage 补上 `input_tokens` 字段
- **回归**：待 A 组重跑 R38 验证

## 验证（分片专项 F1–F4，4/4 PASS）
- F1 chat直接路径：webfetch 分片被正确拦截（无泄露），客户端工具分片透传可拼装
- F2 responses翻译路径：function_call 名完整
- F3 messages翻译路径：tool_use 名完整
- F4 非分片回归：三路径正常
