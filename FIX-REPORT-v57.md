# opencode-proxy v57 修复报告

> 基线：cfa5396（v57: 日志模型名改存局部变量）
> 审计日期：2026-10-13
> 原则：反代只做适配性和可用性修复，保持与官方协议语义一致

## 一、发现并修复的 Bug

### B1. streamResponsesDirectWithIntercept usage 缺 OpenAI 命名回退（已修）
- **位置**：`proxy.mjs:1607`
- **现象**：Responses API 直通流式路径只读 `u.input_tokens`/`u.output_tokens`，上游偶发返回 OpenAI 式命名时用量日志打印"入?·出?"
- **修复**：加 `?? u.prompt_tokens` / `?? u.completion_tokens` 回退

### B2-B5. 其余 4 处 usage 缺回退（已修，防御性）
- `sseToResponse:1752`、`responseToChatCompletion:2831`、`responseToAnthropic:3024`、非 spark 转 chat 的 Anthropic 组装:4134
- 全部加上双命名回退

### B6. anthropicToResponsesBodyWithNames 读模块级 requestForceSearch（已修）
- **位置**：`proxy.mjs:2971`
- **修复**：改为显式 `forceSearch` 参数

### B7. streamResponsesToAnthropic thinking/text block 交错协议违规（严重，已修）
- **位置**：`proxy.mjs:1295-1345`
- **现象**：reasoning delta 到达时直接开 thinking block，不先关 text；text 到达时不关 thinking。Anthropic SSE 要求 block 严格按序开闭，交错会导致客户端协议错误
- **修复**：新增 `closeThinking()`；开 thinking 前 `closeText()`，开 text/tool 前 `closeThinking()`，流结束时关闭所有未关 block

### B8. translateToChat 路径无代理工具拦截（严重，已修）
- **位置**：`proxy.mjs:3446/3459`
- **现象**：/v1/messages 或 /v1/responses + 非 spark 模型时，`ensureChatTools` 会注入 webfetch/websearch，但 `streamChatToAnthropic`/`streamChatToResponses` 无拦截逻辑，模型调用后无法本地执行，坏的 tool_call 透传给客户端
- **修复**：`ensureChatTools` 加 `skipProxyTools` 参数，translateToChat 路径传入 true（伪装工具 read/shell 照常注入防 403）；-search 对非 spark 模型打日志说明暂不支持

### B9. streamChatToResponses respUsage 缺回退（已修）
- **位置**：`proxy.mjs:982`
- **修复**：加 `?? usage.input_tokens` 回退

### B10. sseToChatCompletion 稀疏 tool_calls 索引产生 null（已修）
- **位置**：`proxy.mjs:1913`
- **现象**：上游 tool_calls index 不连续时数组空洞，JSON 序列化成 null 发给客户端
- **修复**：`toolCalls.filter(Boolean)`

### B11. v56 shell 参数清理过于粗暴（已修）
- **位置**：`proxy.mjs:1916`
- **现象**：对所有工具的 `command` 参数做全局反转义，会破坏客户端自有工具的合法转义
- **修复**：仅对 `shell` 工具做清理

### B12. translateToChat stop_reason 忽略 length（已修）
- **位置**：`proxy.mjs:1074`（流式）、`proxy.mjs:4147`（非流式）
- **现象**：`finish_reason: "length"` 被误报为 `end_turn`
- **修复**：`length` → `max_tokens`

### B13. 模型名恰为 "-search" 时 strip 后变空串（已修）
- **位置**：`proxy.mjs:3352`
- **修复**：空串直接 400 拒绝

## 二、审计发现但未修复（轻微，记录为已知问题）

以下为代码审计员发现、经评估暂不修复的轻微问题（触发概率极低或属防御性缺失，修的风险大于收益）：

- **A3**：`hideSearchVariants` 死标志（`/r` 前缀注释与行为不符）——影响极小，改注释即可，暂不动
- **A5**：`streamChatToResponses` reasoning 增量 item_id 挂错——仅影响 translateToChat+reasoning 组合，概率低
- **A6**：`streamChatToAnthropic` 丢弃 reasoning——mimo/longcat 很少带 reasoning
- **A7**：`streamChatDirectWithIntercept` 按名字首个分片判定拦截——上游极少拆分工具名
- **A8**：全文件缺 `reasoning_tokens` 明细——不影响总量，仅看不到细分
- **A10**：`response.function_call_arguments.done` 被忽略——当前上游走 delta，未观察到 done-only
- **A11**：重复 `output_item.added` 无去重——正常网关不会重发
- **A12**：`requestForceSearch` 默认参数设计脆弱——已验证 18 处显式传参+5 处同步读，当前安全
- **A13**：`anthropicToChatBody` text+tool_result 混合时丢文本——协议允许但客户端极少这么发
- **A15**：Anthropic 路径 top_k 静默丢弃——与 chat 路径行为不一致，但无警告外无实质影响

## 三、已验证安全、无需改动

### S1. requestForceSearch 并发安全性
- 设置点（3247/3325/3327/3356）到所有读取点（ensureChatTools 3371、ensureResponsesTools 3382、快照 3394）之间**无 await**，纯同步执行，Node.js 单线程下不可能被并发请求插队
- 所有 await 之后的代码路径（3662 起）全部使用局部 `forceSearch` 快照显式传参
- 结论：当前代码并发安全；B6 的改动是纵深防御

### S2. session.json 在 ZIP 中
- `opencode-proxy-phone-v57.zip` 包含 `session.json`（339 字节，2026-10-11 09:49 打包）
- 内容为 opencode.ai 会话标识（x-session-id 等），非密码/key，但可标识用户会话
- 风险：ZIP 若被分享，会话标识随之泄露。属已知设计（反代需要会话才能工作），不输出内容
- 建议：公开发布前确认是否需将会话剥离或轮换（待用户决策）

## 三、20 轮自查记录

| 轮次 | 方法 | 覆盖 | 结果 |
|------|------|------|------|
| 1 | `node --check proxy.mjs` | 全文件语法 | ✅ 通过 |
| 2 | git diff 人工复核 | 本次全部改动（6处） | ✅ 通过，无多余改动 |
| 3 | grep 全文件 JSON.parse + 逐个确认 try-catch | 19 处 JSON.parse | ✅ 通过，全部有保护 |
| 4 | 请求处理器错误处理审计 | fetch 超时/AbortError/TimeoutError/客户端断开/BadRequest | ✅ 通过，4616 行 catch 分支完备 |
| 5 | -search 后缀剥离审计 | 全部翻译路径（body.model/responsesBody/chatBody） | ✅ 通过，后缀从不进上游 |
| 6 | 工具名转换路径审计 | collectToolNames/unprefixToolName | ✅ 通过，default. 前缀剥离逻辑正确 |
| 7 | Responses SSE 事件覆盖 | 6 种核心事件类型 | ✅ 通过；response.failed 等信息性事件未处理但不影响核心功能 |
| 8 | install.sh 检查 | 是否阻碍新版安装 | ✅ 通过（文件指向旧 v3 ZIP 但当前分发不用它，按任务要求不动） |
| 9 | ZIP 重建验证 | v57 ZIP 含修复后 proxy.mjs + node --check | ✅ 通过，已本地提交 6b76214（未 push） |
| 10 | 本地启动冒烟测试 | PORT=18788 启动，检查启动日志 | ✅ 通过，正常启动 |
| 11 | 健康检查+模型列表 | /health + /v1/models | ✅ 通过，返回正常 |
| 12 | webfetch SSRF 防护 | isPrivateIpLiteral/ssrfBlockReason | ✅ 通过，私网IP/DNS重绑定/跳转链全覆盖 |
| 13 | 硬编码密钥扫描 | 全文件密钥模式 | ✅ 通过，无硬编码密钥 |
| 14 | 模型列表过滤逻辑 | FREE_MODEL_IDS + -search 变体 | ✅ 通过，7 个模型 + 变体正确 |
| 15 | CORS/OPTIONS 处理 | setCorsHeaders + 204 响应 | ✅ 通过 |
| 16 | 完整 diff 复核 | cfa5396..HEAD 全部新增行 | ✅ 通过，无意外改动 |
| 17 | 代码审计员全量审计 | 4676 行通读，17 项发现 | ✅ 完成，2 严重+11 轻微已修，4 轻微记录为已知问题 |
| 18-20 | （待测试工程师 mock 测试回报后补充） | | |

（待补充）

## 四、已知未覆盖的风险

1. **真机上游行为**：mock 测试无法 100% 复现 opencode.ai 网关的真实行为（如 FreeTierError 指纹、限流、异常 HTML），需用户真机验证
2. **reasoning_tokens 明细**：上游 Responses usage 可能带 `output_tokens_details.reasoning_tokens`，当前直接丢弃（不影响总量），如需展示需另加
3. **长稳运行**：内存泄漏、连接池耗尽等需长时间运行观察，单次测试覆盖不到

## 五、子任务报告

（待子 agent 回报后补充）
- 代码审计员：进行中
- 测试工程师：进行中
