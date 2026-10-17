# FIX-REPORT v65（本地包，未发布）

> 版本：65.0.0 ｜ 基线：v64（GitHub 正式版，commit 85e4c9f）｜ 时间：2026-10-17
> 本报告分两节：第一节 = 一轮内多个内置工具调用并行执行（主任务）；第二节 = 上游异常断流不再"假装完成"（截断核查确认的真缺陷）。
> 不发布 GitHub、不改 README，待主代理验收后发布。

---

## 第一节：一轮内多个内置工具调用并行执行

### 0. 参照的官方源码位置

OpenCode 2.0.32 官方（`~/workspace/opencode-source`）：

- `packages/core/src/session/runner/step.ts` L86–L155：同一步内的工具调用被 fork 为独立 fiber 并发执行（`toolRuns` 数组），`Fiber.awaitAll` 等待全部完成，`Effect.exit` 逐个分类错误（`classifyToolExits`，单个工具失败只污染自己的结果），中断时 `interruptTools` 用 `Fiber.interruptAll` 一并取消；L103 按源顺序保序回填。
- 官方 websearch 工具定义：`packages/core/src/tool/plugin/websearch.ts`（name="websearch"，input={query}，Exa 为其 provider 之一——与本代理的 Exa hosted MCP 后端兼容）。

本代理的对齐实现（`proxy.mjs` L3281 `runProxyToolsParallel`）：

- `Promise.all` 同时发起同轮全部工具调用，结果按调用原顺序（数组索引）与 call_id 配对回填——对应官方"按源保序"；
- 内层 try/catch 兜底：单个工具异常只污染自己的结果文本，其余照常、整轮不中断——对应官方 `classifyToolExits` 错误隔离；
- 所有调用共享同一 abort signal：客户端断开时未完成的工具一并取消——对应官方 `interruptAll`；
- 每条工具的 `🔍 websearch/webfetch · 关键词 · 耗时 · 结果数` 日志行仍逐条完整打印（并行下允许交错）。

### 1. 改动点（proxy.mjs，行号为本文件当前行号）

| 位置 | 内容 |
|---|---|
| L3281 | 新增 `runProxyToolsParallel(calls, seq, signal, forceSearch)` helper（唯一新增函数） |
| L4370（F 循环，messages+spark 流式） | `for+await runProxyTool` → `runProxyToolsParallel` |
| L4459（FN 循环，messages+spark 非流式） | 同上（含参数归一化，表达式与原代码逐字一致） |
| L4591（4447 循环，chat+spark 流式） | 同上 |
| L4707（NS 循环，responses+spark 非流式） | 同上（含参数归一化） |
| L4872（X 循环，翻译路径流式） | 同上 |
| L5048（Y 循环，messages 非流式） | 同上（含参数归一化） |
| L5268（C 循环，chat 非流式） | 同上（含参数归一化） |
| L5381（E 循环，responses 非 spark 非流式） | 同上（含参数归一化） |
| L5500（B 循环，chat 直连流式） | 同上 |
| L5612（D 循环，responses 直连流式） | 同上 |

diff 自查结论：39 个 hunk 中，本节占 10 处调用点 + 1 个 helper；删除行全部是顺序 `for+await` 循环，新增行全部是执行方式变化（归一化表达式、`call_id \|\| call_proxy_${++proxyCallSeq}` 回退、传入参数逐字一致）。拦截判定、工具注入、结果格式、用量统计、流式下发一律未动；单调用轮次行为与 v64 逐字节一致（除耗时外无可观察差异）。

### 2. 提速对照（mock 实测，3×900ms 慢速搜索同轮）

| | v65（并行） | v64（顺序基线） |
|---|---|---|
| 一轮 3 websearch 总耗时 | **903ms** | **2722ms** |
| 发起时间散布（3 个调用） | ≤500ms（同时发起） | — |

约 3 倍提速，符合"同时发出执行"预期。

### 3. P 组测试（17 项，全绿）

- P1：一轮 3 搜索并行，同发起、总耗时≈900ms 量级 —— PASS
- P1b：v64 顺序基线对照 ≈2700ms —— PASS
- P2：3 个可区分关键词结果逐一对上 call_id（配对正确） —— PASS
- P2b：乱序完成（FAST 先于 SLOW）下配对仍正确 —— PASS
- P3：3 调用中 1 个 Exa 失败 → 其余 2 正常、失败者带错误文本、整轮完成 —— PASS
- P3b：首个调用失败不拖垮整轮 —— PASS
- P4：websearch+webfetch 同轮并行 —— PASS
- P4b：webfetch 404 不影响同轮 websearch —— PASS
- P5：多轮搜索 2 轮正常接续（3 次上游请求） —— PASS
- P6：单调用轮次行为与 v64 一致 —— PASS
- P7：responses 翻译路径（X 循环）并行+配对 —— PASS
- P8：messages 翻译路径并行+配对 —— PASS
- P9：responses 非流式（NS 循环）并行+usage —— PASS
- P10：chat+spark 路径并行+配对 —— PASS
- P11：messages 非流式（Y 循环）单调用 —— PASS
- P12：responses 原生 spark（F 循环）并行+配对 —— PASS
- P13：5 轮上限回归（6 次上游、无泄漏、正常收尾） —— PASS

### 4. 与原生的差异清单（按用户要求单列）

1. **并发原语**：官方用 Effect Fiber，本代理用 `Promise.all`。理由：反代是单进程 Node 脚本，无 Effect 运行时；`Promise.all` 的"同时发起、按索引保序、内层 catch 隔离、共享 signal 取消"与官方语义逐项对应，测试 P1–P4b 已验证。
2. **工具事件发布**：官方发布全部工具调用事件给客户端；本代理吞掉内置工具调用（websearch/webfetch 对客户端透明，属既有产品语义，v60 起如此，本次不动）。

---

## 第二节：上游异常断流不再"假装完成"

### 0. 缺陷来源与官方口径

依据 `TRUNCATION-CHECK-deepseek-v41.md`（2026-10-17 实测结论）：上游流在没发 completed/incomplete、没给 finish_reason 就 EOF/断开时，5 条路径全部伪造正常结束。

官方原生口径（"原生即规格"）：`packages/ai/src/protocols/` 下 4 个协议适配器一致——流结束时未收到完成信号即抛 `incomplete-stream` 错误：

- `openai-chat.ts:1228` `"OpenAI Chat stream ended without finish_reason"`（`requireFinishReason` 默认为 true）
- `mistral-chat.ts:735`、`cohere-chat.ts:323`、`google-interactions.ts:546` 同语义

### 1. 改动点（proxy.mjs，行号为本文件当前行号）

**流式 translator（6 个）**——跟踪完成信号，未收到即视为截断：

| 函数 | 完成信号 | 截断时的下游信号 |
|---|---|---|
| `streamResponsesToChat`（L993 返回 `truncated`） | `response.completed/incomplete`（L940/944 置 `sawUpstreamEnd`） | chat `data: {"error":{...upstream_truncated}}`（无 `[DONE]`） |
| `streamChatDirectWithIntercept`（L1459） | `finish_reason` 或 `[DONE]`（L1340/1412 置 `sawFinishSignal`） | 由 handler 按下游格式报错（B 循环发 error chunk；X 循环调 `xlateX.fail()`） |
| `streamChatToResponses`（L1170） | `finish_reason != null` | `response.failed`（形状沿用 X 会话 `fail()` 先例） |
| `streamChatToAnthropic`（L1293） | `finish_reason != null` | `{"type":"error"}` 事件（形状沿用 X 会话 `fail()` 先例） |
| `streamResponsesToAnthropic`（L2212，F 循环） | `response.completed/incomplete` | `error` 事件（替代原"优雅关闭"伪造的 end_turn/message_stop） |
| `streamResponsesDirectWithIntercept`（L2212→实际返回处，D 循环） | `response.completed/incomplete` | 补发 `response.failed`（原为静默结束） |

另：6 个 translator 的读循环统一加 `catch`——上游读异常（断开/RST，如 `terminated`）视为截断走上述分支，不再抛给外层静默 `res.end()`；客户端主动断开（`AbortError`）原样抛出，仍由外层按"客户端断开"处理。

**非流式聚合（2 个）**——未收到完成信号返回错误形状：

- `sseToChatCompletion`（L2432/2447 置 `sawFinish`；L2450 起返回 `{error:{...upstream_truncated}}` 而非伪造 stop 的半截 completion）
- `sseToResponse`（L2306 置 `sawEnd`；未收到返回 `{error:{...}}` 而非伪造 completed）

**调用方短路（11 处非流式 + 5 处流式 handler）**：

- 非流式 11 处（FN L4442/4487、NS L4692/4729、X L4987、Y L5024/5098、C L5246/5308、E L5364/5409）：`if (x.error) return sendJson(res, 502, x)`，不再把残缺对象往下传；
- 流式 5 处：F 循环 L4365 `if (rF.truncated) break`、4447 循环 L4586、D 循环 L5607、B 循环 L5481（补发 error chunk 后 break）、X 循环 L4855/4933（置 `failedX` → `xlateX.fail()`，跳过 `finish()`）。

**已收到上游完成信号的正常路径逐字节不变**；上游明确声明的 `length`/`content_filter` 截断照旧如实透出（T9 验证）。

**直连 chat 原始透传路径说明**：B 循环（chat 直连）此前"只转发、不伪造"，断流时靠连接结束。本次把它纳入修复：截断时显式补发 `data: {"error":{...}}` 收尾，比静默结束更明确。D 循环（responses 直传）同理补发 `response.failed`。

### 2. T 组测试（13 项，全绿）

mock 上游在正文一半处直接断开（`SCN:trunc`/`SCN:truncresp`，无完成信号）：

- T1：chat 流式断流 → error chunk，无伪造 stop/`[DONE]` —— PASS
- T2：responses 流式断流 → `response.failed`，无伪造 completed —— PASS
- T3：messages 流式断流 → error 事件，无伪造 message_stop —— PASS
- T4：chat 非流式断流 → 502 + 错误形状，无伪造 completion —— PASS
- T5：responses 非流式断流 → 502 + 错误形状，无伪造 completed —— PASS
- T6：X 会话断流 → `response.failed`，无伪造 completed —— PASS
- T7：X 会话（anthropic）断流 → error 事件，无伪造 message_stop —— PASS
- T8：正常完成不受影响（stop+`[DONE]`，无误报） —— PASS
- T9：声明式 length 截断照旧透出（不误报） —— PASS
- T10：X 会话正常完成（completed，无误报） —— PASS
- T11：无搜索翻译路径断流 → `response.failed` —— PASS
- T12：无搜索翻译路径（messages）断流 → error 事件 —— PASS
- T13：chat+spark 流式断流 → error chunk —— PASS

### 3. 与原生的差异清单

1. **错误载体**：原生在 provider 适配层抛 `AIError(incomplete-stream)` 中断整轮；本代理作为反代不能抛给客户端，必须按下游格式（Responses/Anthropic/Chat）给出错误信号后结束。语义一致（都是"显式报错而非伪造完成"），载体按反代场景调整。
2. **非流式 502**：原生非流式同样抛错；本代理返回 `502 + {error:{...upstream_truncated}}`（OpenAI 错误形状），便于客户端重试。

---

## 第三节：回归

| 套件 | 结果 |
|---|---|
| v65 P 组（并行，17 项） | 17/17 PASS |
| v65 T 组（断流，13 项） | 13/13 PASS |
| v65 S 组（真流式矩阵 30 格：3 接口×10 模型，搜索开+流式，慢速分块） | 30/30 PASS |
| v65 G 组（120 格：3 接口×10 模型×流式/非流式×搜索开/关） | 120/120 PASS |
| v65 U 组（用量 16 项：非流式精确值 11/7/18 + 流式尾部 usage） | 16/16 PASS |
| v64 主套件 run-tests.mjs（27 项，含 H/R/M/Q/S/C/E） | 27/27 PASS |

合计：223 项断言全绿（注：v64 报告中的"76 项"为旧口径；run-tests.mjs 实际 27 个 rec 项，全部通过）。

测试中修过的 2 个测试侧问题（非产品 bug）：

1. S1 误报：`fetch-target.mjs`（未入库的测试 artifact）抓取页正文含"webfetch"字样，触发 S1 的"工具名泄漏"断言。已把页正文改为"用来验证抓取全链路"（不影响 S1 本意：工具调用不泄漏）。
2. E4 断言更新：`SCN:empty`（上游 200 空 body）旧断言期望静默空回；按第二节已批准的新行为改断言为"200 + upstream_truncated 错误信号、无伪造 stop"。

v63 的 `v63-matrix.mjs`（120 格）与 `v63-usage.mjs`（16 项）文件已失传（git 无记录），本轮按同样维度在 v65-tests.mjs 中重建为 G 组/U 组并全绿，见上表。

## 第四节：打包哈希对照表（用户亲点铁律）

包：`opencode-proxy-phone-v65.zip`（10 文件，与 v64 包文件清单一致）。

| 文件 | v65 包内 md5 | v64 包内 md5 | 结论 |
|---|---|---|---|
| proxy.mjs | 42226a939cef99103f0480868d8d882b | 123f498364e9db1f2361f6e2efe24c94 | **不同**——并行执行 + 断流修复（唯二代码变更） |
| package.json | cbaa59bc465e320c9bf747ebb74cde1c | c7692a2e36e19b8b6d1f0a072c48abff | **不同**——版本号 64.0.0→65.0.0（唯一原因） |
| worker.js | 31d43d12b7bc3dfd4cc4f948f53e9f0d | 31d43d12b7bc3dfd4cc4f948f53e9f0d | 同 v64，逐字节一致 |
| tools-chat.json | 3cedf47b474aec9e348e80d532291a6f | 3cedf47b474aec9e348e80d532291a6f | 同 v64 |
| tools-responses.json | c4f74e3a8916fbac5c849db57c35d726 | c4f74e3a8916fbac5c849db57c35d726 | 同 v64 |
| session.json | 6649d6b3867d9314137944a1ab8b7d7e | 6649d6b3867d9314137944a1ab8b7d7e | 同 v64；与仓库当前文件、~/.config/opencode-proxy/session.json 三处 md5 一致，为已验证可用身份，无旧身份混入 |
| README.txt | 101704aa9b8142c6934bf61e5b8de17b | 101704aa9b8142c6934bf61e5b8de17b | 同 v64 |
| spark | 45d1697f8ebb7353b016c0a5fc957069 | 45d1697f8ebb7353b016c0a5fc957069 | 同 v64 |
| start.sh | 91b7236bccfe790c03e3bff09d08f4d5 | 91b7236bccfe790c03e3bff09d08f4d5 | 同 v64 |
| ai | 45d1697f8ebb7353b016c0a5fc957069 | 45d1697f8ebb7353b016c0a5fc957069 | 同 v64 |

- zip 内 proxy.mjs md5（42226a93…）与仓库已测代码逐字一致，已校验。
- `node --check proxy.mjs` 通过；零新依赖。

## 第五节：未验项

- 真实上游验证（beam-free/deepseek 真实断流与搜索）：免费额度/窗口原因未做，mock 覆盖已全绿（与 v64 遗留一致）。
- v63-audit.mjs 的 3 项陈旧断言（R89/R90/R91）为测试台 artifact 问题，与本轮无关，未重跑。

---

*交付：代码已本地 commit（不 push）；package.json 65.0.0；`opencode-proxy-phone-v65.zip` 就绪；不发布 GitHub、不改 README。*
