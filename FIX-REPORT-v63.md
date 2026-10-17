# FIX-REPORT-v63（搜索翻译路径修复 + 真机实锤用量 bug + 100 轮自查）

- 版本：63.0.0（package.json），本地 commit，不 push、不发布 GitHub、不改 GitHub README（主代理验收后发布）
- 基线：v62（GitHub 正式版 release id 415610057）
- 日期：2026-10-17，交付约 14:30（Asia/Shanghai）
- 测试方式：合成测试台为主（mock 上游 HTTPS 127.0.0.1:443 + fetch-target 127.0.0.1:18901）；今日上游免费额度已打空（FreeUsageLimitError/429），真实小流量验证待额度恢复

## 一、确认的 bug 清单（3 个，全部已修）

### BUG-1（高）：翻译路径搜索静默失效（用户亲报 + 日志实锤）
- 症状：/v1/responses 或 /v1/messages 配非 spark 模型（全部 9 个 chat 通道模型）时，选 -search 或发原生 web_search，日志打"注意：-search 搜索暂不支持非 spark 模型，已跳过搜索工具注入"，搜索不执行。真机截图 #31/#32 前各有一行该日志。
- 根因：proxy.mjs 两处 translateToChat 装配分支以 skipProxyTools=true 跳过搜索工具注入（当年该路径无拦截执行逻辑，怕注入后无人执行）。
- 复现：合成台 T1（/v1/responses + deepseek-search 流式）v62 行为=不注入；修后=注入→拦截→本地执行→follow-up 出最终答案。
- 修复（proxy.mjs）：
  - L3683、L3696：`ensureChatTools(chatBody, true)` → `ensureChatTools(chatBody, !forceSearch)`；删除跳过日志。
  - L4340 起 translateToChat 响应分支：新增 interceptNamesX/knownX；无搜索走 v62 直接翻译（逐字节一致）；搜索开时走 chat 层 agentic loop：
    - 流式：tee 保留本轮 SSE + streamChatDirectWithIntercept 拦截，follow-up 最多 5 轮（第 5 轮后最终 fetch 不再拦截），末轮 SSE 用合成 Response 喂 streamChatToResponses/streamChatToAnthropic；follow-up 失败发下游格式错误事件（responses 用 response.failed、anthropic 用 {"type":"error"}），绝不漏 proxy tool_call。
    - 非流式：同 C 循环的 chat object 层 loop，末轮加兜底剥离未执行的 proxy tool_call。
    - usage 累计：每轮 merge 后清 null 防重复。
- 验证：T1/T2/T4/T7/T8（搜索执行）、T3/T5（无搜索不注入）、T6（客户端工具不拦截）、120 格矩阵搜索列全绿。

### BUG-2（中）：翻译路径非流式日志用量永远 "?tok/s"（真机实锤 #33）
- 症状：真机截图 `#33 · deepseek-v4.1-flash-free · 1条消息` → `#33 ✓ · 总计3.7秒 · ?tok/s · 入? · 出?`。无"首字"→非流式；同页 #31/#32（流式）用量正常。
- 根因：v62 translateToChat 非流式两个分支（anthropic 客户端 / responses 客户端）的 zenLog 传了 `timing.usage`，但该分支从未给 timing.usage 赋值（usage 只存在 chatObj 里）→ 日志永远问号。客户端响应体的 usage 当时是对的（由 chatObj.usage 映射），属"日志与客户端不一致"。
- 证据链：#31/#32 流式用量正常→证明上游 SSE 含 usage chunk；#33 非流式→走 sseToChatCompletion 同样能抓到 usage；代码 v62 L~4398/L~4448 两处 zenLog(usage: timing.usage) 与分支内零赋值对照。
- 复现：合成台 U1（/v1/responses + deepseek 非流式）修前日志 `?tok/s · 入? · 出?`（代码级确认），修后 `#12 ✓ · 总计0.0秒 · 636tok/s · 入11 · 出7`。
- 修复（proxy.mjs L4678）：非流式 X 分支在转下游格式前加 `timing.usage = chatObj?.usage ?? null;`，日志与客户端同源。
- 验证：U1-U8 16/16（3 接口 × 流式/非流式，响应体 usage + 日志双正确）。

### BUG-3（中）：翻译路径流式搜索 usage 末轮重复计数（自查发现）
- 症状：搜索流式多轮时，末轮 token 被算两遍。合成复现：round0(31,12)+末轮(51,5) 应为入82/出17，修前日志入133/出22。
- 根因：X 循环内每轮已把 timing.usage 并入 totalUsageX（含末轮），循环后又 `mergeUsageSum(totalUsageX, timing.usage)` 把翻译器刚从末轮 SSE 提取的 usage 加了一遍。
- 修复：循环后改为 `timing.usage = totalUsageX;`；5 轮上限的收尾 fetch 没走拦截循环，在分支内用 sseToChatCompletion 提取其 usage 补入 totalUsageX。
- 验证：DC3 复测入82/出17；R91 静态断言已更新为新口径。

## 二、其他自查结论（无新增 bug，均为"合理"项）

- skip/降级分支全清查（R88 及本轮复核）：剩余 skip 均为合理降级——无搜索不注入、非 function 工具丢弃+警告、webfetch 跳过图片 URL、SSE 帧 skipStart；无其他静默失效。
- translateToResponses（Anthropic→Responses，spark）路径：zenLog 用 respObjFN.usage（totalUsageFN 已合并），正确。
- 直连 chat 非流式（C 循环）、responses 直连非流式（E 循环）：分别用 chatObj.usage / respObj.usage，已合并多轮，正确。
- 流式各循环（B/D/F/E/X）：timing.usage 在末轮由翻译器设置后取用，正确。
- 截断行为：翻译非流式 trunc→502，与直连 chat 非流式一致（v62 同行为）；messages 翻译流式 trunc→502（v62 同路径；直连 chat 流式为 200——v62 既有差异，已记录为已知行为，本轮不改）。
- 上游不给 usage 的极端情况：未在合成台复现（mock 各场景均带 usage chunk）；真实上游行为待额度恢复后验证，列入未验项。
- responses 流式透传 usage 命名：mock 故意用非标准 prompt_tokens 命名测回退，上游透传原样；真实上游发标准 input_tokens 时透传即标准。日志端两种命名都兼容（usageNum 回退），显示正确。
- worker.js：仅注释示例模型 1.3→1.2（v62 名单已同步）；仍是旧骨架（无 v60 翻译器修复），移植/废弃待下轮决定（v62 遗留）。
- redirect-dns.mjs（test-scratch，仅测试用）：补了 fetch URL 重写兜底——实测 Node 24 undici 用 named import 取 dns.lookup，原 dns 补丁覆盖不到，fetch 会直连真实上游。不碰 proxy.mjs。

## 三、测试结果总表

| 套件 | 内容 | 结果 |
|---|---|---|
| T1-T12（/tmp/v63-tests.mjs） | 搜索修复：翻译路径搜索流式/非流式、原生 web_search 自动开、无搜索不注入、客户端工具不拦截、回归 | 12/12 PASS |
| R13-R39（test-scratch/run-tests.mjs） | 既有回归矩阵 | 26/27（S1 为测试台 artifact：fetch-target 页面正文含"webfetch"字样，该路径代码与 v62 逐字节一致，非回归） |
| R40-R100（/tmp/v63-audit.mjs） | 本轮 61 轮审计 | 61/61 PASS |
| 接口矩阵（/tmp/v63-matrix.mjs） | 3 接口 × 10 模型 × 流式/非流式 × 搜索开/关 = 120 格 | 120/120 PASS |
| U1-U8（/tmp/v63-usage.mjs） | 3 接口 × 流式/非流式 × chat/spark：响应体 usage + 日志双正确 | 16/16 PASS |
| node --check | 语法 | 通过 |
| zip 校验 | proxy.mjs md5 与仓库一致，10 文件 | 通过 |

### 接口矩阵分接口结果（各 40 格）
- 接口 A /v1/chat/completions：40/40（10 模型 × 流式/非流式 × 搜索开/关；搜索开仅当 -search/原生 web_search；上游路由均为 /zen/v1/chat/completions）
- 接口 B /v1/responses：40/40（spark 走 /zen/v1/responses；其余 9 模型走 /zen/v1/chat/completions 翻译；搜索开才注入 webfetch/websearch）
- 接口 C /v1/messages：40/40（spark 走 /zen/v1/responses 翻译；其余 9 模型走 /zen/v1/chat/completions 翻译；同上）

## 四、100 轮逐轮记录

### R1-R12：搜索修复专项（/tmp/v63-tests.mjs）
- R1（T1）：/v1/responses + deepseek-search 流式→搜索执行、follow-up 出最终答案、无 proxy tool_call 泄漏 PASS
- R2（T2）：/v1/responses + deepseek + 原生 web_search 工具→自动转 forceSearch 执行 PASS
- R3（T3）：/v1/responses + deepseek 无搜索→不注入（仅 read/shell 伪装）、单轮 PASS
- R4（T4）：/v1/messages + big-pickle-search 流式→搜索执行 PASS
- R5（T5）：/v1/messages + big-pickle 无搜索→不注入 PASS
- R6（T6）：/v1/responses + deepseek + 客户端自有工具→透传翻译、不拦截 PASS
- R7（T7）：/v1/responses + deepseek-search 非流式→搜索执行 PASS
- R8（T8）：/v1/messages + big-pickle-search 非流式→搜索执行 PASS
- R9（T9）：/v1/responses + deepseek-search + searchloop→5 轮上限后收尾 PASS
- R10（T10）：回归 spark responses + -search PASS
- R11（T11）：回归直连 chat + -search PASS
- R12（T12）：回归直连 chat 无搜索流式 PASS

### R13-R39：既有回归（test-scratch/run-tests.mjs，26/27）
覆盖：各模型路由、工具调用、reasoning、截断、错误透传（上游 500/HTML/空 body/延迟）、伪装工具防 403 等；唯一失败 S1 系测试台页面文案 artifact，非代码回归。

### R40-R100：本轮审计（/tmp/v63-audit.mjs，61/61）
- R40-R59：10 模型 × -search 开关路由与注入矩阵（chat 通道走 completions、spark 走 responses；搜索开才注入）PASS
- R60-R69：翻译路径搜索开/关 × 流式/非流式行为（注入、拦截、follow-up、无泄漏）PASS
- R70-R72：5 轮上限（翻译流式/翻译非流式/直连对照均为 6 次上游请求后收尾）PASS
- R73-R76：客户端工具在翻译路径透传、伪装工具保留、防 403 PASS
- R77-R79：-search 但模型不调工具→单轮直接返回（流式/非流式/并发隔离）PASS
- R80-R87：错误与边界（上游 500 透传、空 body、畸形 SSE 行跳过、超大行保护、超时、空/非法请求体）PASS
- R88：skip/暂不支持分支清查→剩余均为合理降级 PASS
- R89：tee 单处且仅搜索分支 PASS
- R90：R89 复核（命名调整）PASS
- R91：usage 累计无重复计数（静态口径；发现 BUG-3 后更新为新口径）PASS
- R92：5 轮上限与直连路径一致 PASS
- R93：无搜索时 skip 与 v62 一致 PASS
- R94：下游错误事件格式（response.failed / {"type":"error"}）PASS
- R95：interceptNamesX 去重客户端同名工具 PASS
- R96：knownX 覆盖注入名 PASS
- R97：翻译非流式截断→502 与直连一致 PASS
- R98：v62 回归 responseDone finish 打标 PASS
- R99：v62 回归 hideSearchVariants 死代码已删 PASS
- R100：worker.js 名单同步 PASS

### U1-U8：用量专项（/tmp/v63-usage.mjs，16/16）
- U1：B 接口 + deepseek 非流式→响应体 usage{11,7} + 日志入11/出7（BUG-2 精确复现格）PASS
- U2：C 接口 + deepseek 非流式→同上 PASS
- U3：A 接口 + deepseek 非流式→usage{prompt 11,completion 7} + 日志 PASS
- U4：B 接口 + deepseek 流式→SSE response.completed 带 usage + 日志 PASS
- U5：C 接口 + deepseek 流式→message_delta 带 usage + 日志 PASS
- U6：A 接口 + deepseek 流式→usage chunk + 日志 PASS
- U7：B 接口 + spark 非流式→usage{11,7} + 日志 PASS
- U8：B 接口 + spark 流式→completed 带 usage + 日志 PASS

## 五、未验项（实测待条件恢复）
1. 真实上游小流量验证（deepseek + responses + -search）：今日免费额度打空（429），合成台为主要证据。
2. 上游真实 usage 缺失时的表现：合成台各场景均带 usage chunk；真实 DeepSeek/Zen 的 usage 形状与缺失概率待额度恢复后抓包确认。
3. worker.js 旧骨架移植/废弃：v62 遗留，不属本轮范围。

## 六、交付物
- 代码：proxy.mjs（搜索翻译路径拦截 + 用量日志修复 + usage 防重复计数）、worker.js（注释）、package.json（63.0.0）
- 包：opencode-proxy-phone-v63.zip（10 文件，proxy.mjs md5 c95a52d16d7e35b660fdcb5abeffb7a3 与仓库一致，session.json 为占位）
- 本报告：FIX-REPORT-v63.md
- 本地 commit，不 push；不发布 GitHub；不改 GitHub README。
