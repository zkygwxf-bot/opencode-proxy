# opencode-proxy v57 修复报告

> 基线：cfa5396（v57: 日志模型名改存局部变量）
> 审计日期：2026-10-13
> 原则：反代只做适配性和可用性修复，保持与官方协议语义一致

## 一、发现并修复的 Bug

### B1. streamResponsesDirectWithIntercept usage 缺 OpenAI 命名回退（致命→已修）
- **位置**：`proxy.mjs:1607`（原 1607-1614）
- **现象**：Responses API 直通流式路径只读 `u.input_tokens`/`u.output_tokens`，上游偶发返回 OpenAI 式 `prompt_tokens`/`completion_tokens` 时，用量日志打印"入?·出?"
- **触发条件**：用户主力模式（Muse Spark + Responses API）偶发
- **修复**：`const _in = u.input_tokens ?? u.prompt_tokens; const _out = u.output_tokens ?? u.completion_tokens;`
- **验证**：静态确认 + 待 mock 测试

### B2. sseToResponse usage 缺 OpenAI 命名回退（严重→已修）
- **位置**：`proxy.mjs:1752`（非流式 Responses 组装）
- **现象**：同 B1，上游返回 OpenAI 式 usage 时非流式路径用量为 undefined
- **修复**：同 B1 的回退逻辑
- **验证**：静态确认 + 待 mock 测试

### B3. responseToChatCompletion usage 缺回退（轻微→已修，防御性）
- **位置**：`proxy.mjs:2831`
- **现象**：Responses→Chat 翻译时只读 input_tokens 命名
- **修复**：加 `?? resp.usage.prompt_tokens` 回退
- **验证**：静态确认（调用方 sseToResponse 已规范化，属防御性）

### B4. responseToAnthropic usage 缺回退（轻微→已修，防御性）
- **位置**：`proxy.mjs:3024`
- **现象**：Responses→Anthropic 翻译时只读 input_tokens 命名
- **修复**：加回退链 `?? resp.usage?.prompt_tokens ?? 0`
- **验证**：静态确认

### B5. 非 spark 模型转 chat 的 Anthropic usage 缺回退（轻微→已修，防御性）
- **位置**：`proxy.mjs:4134`
- **现象**：chatObj.usage 只读 prompt_tokens 命名
- **修复**：加 `?? chatObj.usage?.input_tokens ?? 0` 回退
- **验证**：静态确认

### B6. anthropicToResponsesBodyWithNames 读模块级 requestForceSearch（隐患→已修）
- **位置**：`proxy.mjs:2971`
- **现象**：函数内部直接读模块级变量，并发下理论上有污染风险（实际调用是同步的，当前安全，但属隐患）
- **修复**：改为显式参数 `forceSearch`，调用处传入局部快照
- **验证**：静态确认调用链同步；待并发压测

## 二、已验证安全、无需改动

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
| 9 | | | |
| ... | | | |

（待补充）

## 四、已知未覆盖的风险

1. **真机上游行为**：mock 测试无法 100% 复现 opencode.ai 网关的真实行为（如 FreeTierError 指纹、限流、异常 HTML），需用户真机验证
2. **reasoning_tokens 明细**：上游 Responses usage 可能带 `output_tokens_details.reasoning_tokens`，当前直接丢弃（不影响总量），如需展示需另加
3. **长稳运行**：内存泄漏、连接池耗尽等需长时间运行观察，单次测试覆盖不到

## 五、子任务报告

（待子 agent 回报后补充）
- 代码审计员：进行中
- 测试工程师：进行中
