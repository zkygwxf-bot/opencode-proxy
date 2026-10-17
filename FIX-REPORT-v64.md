# FIX-REPORT v64（本地包，未发布）

> 版本：64.0.0 ｜ 基线：v63（GitHub 正式版，commit 8895290）｜ 时间：2026-10-17
> 本报告分两节：第一节 = 真流式修复与测试（第一阶段）；第二节 = 对照 OpenCode 2.0.32 官方源码自查 + 日志专项 + 边角组合 + 打包哈希（第二阶段）。
> 不发布 GitHub、不改 README，待主代理验收后发布。

---

## 第一节：翻译路径带搜索流式的真流式化

### 0. 先说清一个关键事实（用户要求写进报告）

**上游对所有模型都是流式供数，不存在"只有 spark 能流式搜索"。**
v63 整段返回纯粹是咱们翻译路径的实现问题：`translateToChat` 的搜索分支把每轮上游 SSE 整轮 `tee()` 缓存、全部轮次跑完后才把末轮喂给翻译器一次性发出——客户端体感非流式。上游 `/zen/v1/chat/completions` 对 10 个免费模型一律返回标准 SSE 流，与模型无关。v64 只改翻译路径的消费方式，不改上游。

### 1. 改动点（proxy.mjs，行号为本文件当前行号）

**新增：增量翻译会话 `makeXlateSessionX`（约 L1389–L1560）**

- `head()`：收到首个 chat chunk 前只发 `response.created` / `message_start`，并打开正文 item/block（Responses：`response.output_item.added` + `response.content_part.added`；Anthropic：`message_start` + `content_block_start`），与现有 `streamChatToResponses` / `streamChatToAnthropic` 的事件形状逐字段镜像。
- `pushChatChunk(chunk)`：把 `streamChatDirectWithIntercept` 的每块 chat SSE 实时翻译成下游事件下发：
  - 正文 delta：即时下发（`response.output_text.delta` / `content_block_delta`），并在首字到达时记录真实首字时间（`timing.firstTokenAt`，日志"首字"恢复正常）；
  - usage chunk：吞掉不下发，只累计进本轮；
  - 客户端工具调用：按轮缓冲（沿用现有翻译器"暂缓"语义，不实时下发）；
  - proxy 工具调用（websearch/webfetch）：解析器在 `decideEntry` 判定后直接吞掉，**绝不进入翻译器输出**（见下文 G2 修复）。
- `endRound(wasIntercepted)`：轮末若无拦截→下发本轮暂缓的客户端工具调用；有拦截→工具事件扣住不发（避免"工具调用事件已下发、结果却要下一轮才回来"的次序矛盾）。
- `finish(totalUsage)`：一次性下发完成类事件（`response.completed` 带累计 usage / `message_delta`+`message_stop`）；`fail(msg)` 按下游格式发错误事件。

**重写：X 流式搜索分支（约 L4616–L4700，原 tee 缓存整段删除）**

- 每轮改为 `streamChatDirectWithIntercept(upX, chunk => xlateX.pushChatChunk(chunk), ...)` 增量下发；有拦截→扣住完成事件、本地执行 websearch/webfetch、结果回填 chat 上下文、下一轮继续（**同一条下游 response/message 保持打开**）；无拦截→收尾。5 轮上限与 v63 一致。
- 收尾轮（第 5 轮仍有拦截）：改为"解析拦截 + 丢弃调用 + 本轮文本直接收尾"，修复 v63 的潜在泄漏（v63 旧代码在收尾轮可能把 proxy tool_call 透给下游，G2 实测验证已封堵）。
- usage 口径：沿用 BUG-3 修复后的 `totalUsageX` 累计（每轮 merge 后清 null，末轮直接取用，不再 merge 翻译器 usage 以防重复计数），逐轮事件形状不变。
- 上游中途断流/报错→下游格式错误事件收尾（`response.failed` / Anthropic `{"type":"error"}`），不 hang；客户端断开→`req.on("close")` 停上游与后续轮次。

**未动**：无搜索分支（与 v63 逐字节一致）、非流式 X 分支、直连 chat 循环 B、spark 原生路径、`mergeUsageSum`、日志行格式。

**官方源码参照**（用户硬要求"照官方学"）：

- `~/workspace/opencode-source`（tag v2.0.32）`packages/core/src/session/runner/step.ts`：官方每轮一个 `llm.stream` 调用逐事件消费，工具判定与正文流式并行，不等待整轮结束——v64 的"逐轮增量下发 + 轮末拦截判定"即移植此做法。
- `packages/core/src/session/runner/publish-llm-event.ts`：`text-delta` 到达即 `text.append` 发布；工具调用事件一完整即发布并并发执行——v64 的"正文 delta 即时下发"与之一致。
- `packages/core/src/github-copilot/responses/openai-responses-language-model.ts`（L1282–L1300 的 zod schema）：官方 `response.output_text.delta` = `{item_id, delta}`、`response.completed` = `{response:{usage}}`——咱们的事件形状与之对齐（`created` vs 官方 `created_at` 为历史字段差异，客户端兼容，保持不动）。
- 与官方的**两处有意差异**（反代场景合理，非 bug）：①官方工具并发执行（forked fibers），咱们顺序执行（沿用 v60+ 既有语义，简单确定）；②官方发布全部工具事件，咱们吞掉内置工具调用（对客户端透明的产品语义，v42 起既定）。

### 2. 流式性验证（合成慢速 mock：350ms/块，全量 30 格）

判定标准：客户端收到首个正文增量的时间 ≪ 整轮结束时间（阈值：首字 < 总时长 − 1200ms）。

| 下游接口 | deepseek-v4.1-flash-free | glm-5.3-flash-free | mimo-v2.6-flash-free | nemotron-3.5-lightning-free | nemotron-3.5-super-vl-free | big-pickle | beam-free | longcat-2.5-preview-free | space-bunny-free | muse-spark-1.2-contributor-free |
|---|---|---|---|---|---|---|---|---|---|---|
| /v1/responses | 143/5062ms ✓ | 13/4931 ✓ | 10/4974 ✓ | 13/4931 ✓ | 8/4930 ✓ | 12/4971 ✓ | 27/4945 ✓ | 12/4930 ✓ | 9/4928 ✓ | 709/6348 ✓ |
| /v1/messages | 16/4931 ✓ | 15/4937 ✓ | 12/4925 ✓ | 8/4924 ✓ | 8/4922 ✓ | 6/4922 ✓ | 9/4929 ✓ | 13/4942 ✓ | 17/4943 ✓ | 730/6431 ✓ |
| /v1/chat（直连对照） | 18/4948 ✓ | 8/5125 ✓ | 29/4959 ✓ | 16/4947 ✓ | 9/4940 ✓ | 9/4925 ✓ | 8/4926 ✓ | 9/4919 ✓ | 7/4927 ✓ | 713/7032 ✓ |

（spark 行首字 ~700ms 系 mock 自身分块节奏所致，仍远早于整轮结束；chat 行中 spark 走原生路径，本就真流式，仅作确认。）

每格另断言：完成事件唯一（恰 1 个 completed/stop）、无 proxy 工具泄漏、follow-up 真实发生（上游 2 次请求）——30 格全部 PASS。

### 3. 功能 / 用量 / 异常测试

- F1 拦截续轮流式：正文增量实时到达、proxy tool_call 零泄漏、第二轮正文继续实时下发、完成事件只出现一次且在最后 —— PASS
- F2 两轮连续搜索：两轮搜索都执行、文本拼接正常 —— PASS
- F3 同轮客户端工具+内置工具：客户端工具暂缓到收尾才下发、无重复、内置调用零泄漏 —— PASS
- F4 纯客户端工具（无搜索）：工具调用对客户端可见 —— PASS；F4 非流式搜索：正常，usage 82/17 —— PASS
- F5 无搜索纯聊天流式对照：真流式、单轮 —— PASS
- U1 多轮流式搜索用量：响应体 usage 82/17 = 手工累计（61+11+10+6…按场景累计值 82/17）；代理日志行 `#36 ✓ 首字0.0秒 · 总计4.9秒 · 3tok/s · 入82 · 出17` ——响应与日志一致，BUG-3 未回退 —— PASS
- E1 上游中途断流：`response.failed` 收尾、不 hang（总 730ms） —— PASS
- E2 follow-up 上游 500：`response.failed` 收尾 —— PASS
- E3 客户端中途断开：代理存活、后续请求正常 —— PASS
- v64 主套件：**76/76 PASS**

### 4. 旧套件回归（v64 代码重跑 v63 套件）

- v63-tests.mjs：12/12 PASS
- v63-matrix.mjs：120/120 PASS（3 接口×10 模型×流式/非流式×搜索开/关）
- v63-usage.mjs：16/16 PASS（日志路径用软链接指向本次代理日志后）
- v63-audit.mjs：58/61 —— 3 项失败均为**陈旧断言**（测试台 artifact，非回归）：R89 断言版本号=62.0.0（现 64）、R90 断言 `.body.tee()` 恰出现 1 次（v64 已按设计删除 tee）、R91 断言源码含旧注释串"收尾轮没走拦截循环"（注释改写，usage 语义经 U1 实测 82/17 未变）。

### 5. 真实上游抽查

未执行：免费层额度今日已打空（与 v63 报告一致，待 2026-10-18 恢复）。合成台已覆盖全部行为断言，如实标注。

---

## 第二节：第二阶段（对照源码自查到 15:30）

### 1. 官方源码对账结论

| 比对项 | 官方参照 | 结论 |
|---|---|---|
| 事件形状与次序 | `github-copilot/responses/openai-responses-language-model.ts` L1282–L1300 schema | 一致；`created`/`created_at` 为历史差异，保持兼容 |
| 流式+工具并行 | `session/runner/step.ts`、`publish-llm-event.ts` | v64 已移植（逐事件消费、delta 即时发布） |
| 工具结果回填 | `session/runner/to-llm-message.ts` | 咱们的 chat 格式 follow-up（assistant tool_calls + role:tool）与既有行为一致，未动 |
| usage 累计 | `session/usage.ts`（跨步累加） | 一致（`mergeUsageSum` 逐轮累加） |
| 错误形状/状态码 | 官方 schema 的 error chunk `{code,message,param}` | 咱们的 `response.failed`/`{"type":"error"}` 形状合规；HTTP 状态码透传逻辑未动 |
| 流式中断/收尾 | 官方中断语义 | `req.on("close")` 停上游+停后续轮次；上游断流→下游错误事件，不 hang |

### 2. 日志专项（逐类审计）

- 开始行/结果行配对：正常（`#N · 时间 · 模型 🔍 · N条消息` ↔ `#N ✓ 首字x秒 · 总计y秒 · 入a · 出b`）。
- 搜索 🔍 标记：`-search` 后缀与原生 web_search 均正确标注。
- **发现并修复 1 处**：responses 字符串 `input` 时消息数打 `?条消息` → 改为记 `1条消息`（日志-only，零行为风险；G3 验证）。
- 首字时间：v64 恢复真实值（日志 `首字0.0秒` 系 mock 首块 350ms 内到达，非问号/占位）。

### 3. 接口与搜索边角组合（第二阶段追加）

- G1：/v1/messages + `-search` + 非流式 → 正常、usage 82/17 —— PASS
- G2：5 轮上限（每轮都 webfetch）：6 次上游后收尾、**无 proxy 泄漏**（v63 潜在泄漏已封堵）、usage 366/66 累计正确 —— PASS
- G3：日志字符串 input 记 1 条消息 —— PASS
- H1/H2：客户端自带同名 `websearch` 工具（responses/messages）：**不被拦截**，正常透给客户端；模型调用它时可见、无 follow-up 搜索 —— PASS（4/4）
- 边界说明（合理差异，非 bug）：Anthropic 格式下客户端具名 `web_search` 工具不自动触发搜索（防劫持客户端自有工具）；Anthropic 客户端用 `-search` 后缀开启搜索。

### 4. 打包哈希对照表（用户亲点铁律）

包：`opencode-proxy-phone-v64.zip`（10 文件，与 v63 包文件清单一致）。

| 文件 | v64 包内 md5 | v63 包内 md5 | 结论 |
|---|---|---|---|
| proxy.mjs | 123f498364e9db1f2361f6e2efe24c94 | c95a52d16d7e35b660fdcb5abeffb7a3 | **不同**——本次真流式改动+日志小修（唯一代码变更） |
| package.json | c7692a2e36e19b8b6d1f0a072c48abff | 543cf111330b95f5a2440148936b4f5a | **不同**——版本号 63.0.0→64.0.0（唯一原因） |
| worker.js | 31d43d12b7bc3dfd4cc4f948f53e9f0d | 31d43d12b7bc3dfd4cc4f948f53e9f0d | 同 v63，逐字节一致 |
| tools-chat.json | 3cedf47b474aec9e348e80d532291a6f | 3cedf47b474aec9e348e80d532291a6f | 同 v63 |
| tools-responses.json | c4f74e3a8916fbac5c849db57c35d726 | c4f74e3a8916fbac5c849db57c35d726 | 同 v63 |
| session.json | 6649d6b3867d9314137944a1ab8b7d7e | 6649d6b3867d9314137944a1ab8b7d7e | 同 v63；与仓库当前文件、~/.config/opencode-proxy/session.json 三处 md5 一致，为已验证可用身份，无旧身份混入 |
| README.txt | 101704aa9b8142c6934bf61e5b8de17b | 101704aa9b8142c6934bf61e5b8de17b | 同 v63 |
| spark | 45d1697f8ebb7353b016c0a5fc957069 | 45d1697f8ebb7353b016c0a5fc957069 | 同 v63 |
| start.sh | 91b7236bccfe790c03e3bff09d08f4d5 | 91b7236bccfe790c03e3bff09d08f4d5 | 同 v63 |
| ai | 45d1697f8ebb7353b016c0a5fc957069 | 45d1697f8ebb7353b016c0a5fc957069 | 同 v63 |

- zip 内 proxy.mjs md5（123f4983…）与仓库已测代码逐字一致，已校验。
- `node --check proxy.mjs` 通过；零新依赖。

### 5. 未验项

- 真实上游真流式验证（beam-free/deepseek）：免费额度今日打空，待 2026-10-18 恢复后补（与 v63 遗留一致）。

---

*交付：代码已本地 commit（不 push）；package.json 64.0.0；`opencode-proxy-phone-v64.zip` 就绪；不发布 GitHub、不改 README。*
