# B组 (R41–R70) 发现的 bug 清单

> 被测: `~/workspace/opencode-proxy/proxy.mjs` v57.0.0 (commit d6ad08f 起测)
> 测试时间: 2026-10-13 12:15–13:00 CST ｜ 初测 29 PASS / 1 FAIL；加轮 B71–B80 初测 9/10
> 更新: Bug-1、Bug-2 均已按"修复-验证闭环"协议修复并回归通过（R41–R70 30/30、B71–B80 10/10，
> 合计 40/40），详见 `B-fixes.md`。当前 proxy.mjs 为修复后状态。

---

## Bug-1 (FAIL R41 → 已修复 ✅): 空请求体返回 502 而非 400, 且错误文案误导

**位置**: `proxy.mjs`（修复前行号）`:4225`、`:4332`；**修复后新增 guard**：`:3321`、`:3473`

**现象**:
`POST /v1/chat/completions`(空 body, 非流式) → `502 {"error":{"message":"上游连接失败，稍后重试"}}`;
`POST /v1/responses` 空 body → 502; `POST /v1/messages` 空 body → 502。
三端点一致复现。此时上游实际工作正常(mock 返回了 200), 502 文案把客户端错误伪装成上游故障, 用户会徒劳重试。

**根因**:
空 body 时 `body` 保持 `null`(解析分支 `if (raw.length)` 被跳过), 随后非流式分支直接解引用:
- `:4225` chat 非流式: `let currentMessagesC = Array.isArray(body.messages) ? ...` →
  `TypeError: Cannot read properties of null (reading 'messages')`
- `:4332` responses 非流式(`/v1/messages` 空 body 也落到此分支, 因 anthropic 翻译分支要求 `body` 为真被跳过):
  `let currentInputE = asInputArray(body.input)` → 同样 TypeError

TypeError 被外层 catch 吞掉, 统一转成 502"上游连接失败"。

**复现请求**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:18782/v1/chat/completions --data-binary ''
# 502 (期望 400)
```

**修复状态**: ✅ 已修复（2026-10-13 约 12:30，持锁修复，30/30 回归通过）。
采用的正是下述方案 1（body 解析后统一 400 拦截），位置见上。回归证据见 `B-fixes.md`。

---

## Bug-2 (FAIL B72 → 已修复 ✅): 非流式 responses 直连路径静默丢弃 function_call

**位置**: `proxy.mjs` `sseToResponse()`（修复前约 1822–1838 行）

**现象**: `POST /v1/responses`（muse-spark-1.3-contributor-free-search，非流式）上游返回
webfetch function_call 后，proxy 回 200 但终答文本为空，且只发 1 个上游请求
（无本地执行、无 follow-up）。流式同场景正常。

**根因**: `sseToResponse` 只从 `response.completed.response.output` 收集 function_call；
当网关的 completed 事件不重复 output（当前 mock `output: []`，部分真实网关亦然）时，
调用被静默丢弃，agentic loop 直接 break。真上游（opencode-src 录制流量）在 completed
里重复 output，故生产可能无感，但属于健壮性缺口。

**修复**: `sseToResponse` 内新增 `pushFn`（按 call_id 去重），同时从
`response.output_item.done` 事件收集 function_call。真上游两种事件都有时去重后与原行为一致。

**回归**: B72 通过（终答 MOCK-FINAL，usage 82/17 正确合并）；B2 10/10、R41–R70 30/30 无回归。
详见 `B-fixes.md` Fix-2。

**原建议修复**（已实施方案 1，留档）:
1. body 解析后统一加空 body 拦截: 需要 body 的 POST 路由, 若 `raw.length === 0` 或 body 不是对象,
   直接 `400 "请求体为空"`。一次修复整个类别, 不用逐个分支打补丁。
2. 退而求其次: `:4225` 改 `body?.messages`、`:4332` 改 `body?.input`(asInputArray 已处理非数组输入),
   让请求走到上游由上游报 400。但 502 误导文案的根子还在, 不如方案 1。

**严重程度**: 低。正常客户端不会发空 body; 但 502 误导文案会浪费排查时间, 且这是 fuzz 轮里唯一的真 5xx。

---

## 观察项 (非 bug, 记录备查)

1. **R44/R45 (缺 messages / messages:null) → 200**: proxy 不做消息列表校验, 直接透传给上游。
   mock 容忍缺字段返回了文本; 真实上游会报 400。这是"透传优先"的设计选择, 非 bug, 在此记录以免误判。
2. **R70 断言修正**: 初版用 `r.text.includes("webfetch")` 判"工具泄露"误报 FAIL。
   真因是 mock 的 `echoOutputs`(mock-upstream.mjs:58) 把 webfetch 抓取结果(含"webfetch"字样)
   ECHO 进终答文本 —— 抓取内容进终答是符合 -search 语义的。已改为断言"无 `tool_calls` chunk 泄露",
   50/50 通过。注意: 共享 mock 的 ECHO 行为会让任何基于子串的"泄露"断言不可靠,
   A 组 run-tests.mjs 的 S1/S2 `!exposed` 断言在当前 mock 下已不再成立(环境漂移, 非 proxy 问题)。
3. **R50 (上游中途断流)**: 直连与翻译两条路径都不挂起, 均 200 返回已收到的部分内容(无 `[DONE]`)。
   客户端看到流提前 EOF, 属合理降级。
4. **R48**: 四种 usage 命名在直连路径原样透传(符合"直连不归一化"的既有设计), 翻译路径的
   `normalizeUsage` 对字符串/空对象/混搭命名均不抛错(返回 null 或 undefined 字段, 日志显示"?")。
5. **mock 扩展说明**: 为 R48–R56 在 `test-scratch/mock-upstream.mjs` 追加了 10 个纯加法场景
   (`u-inout/u-prco/u-mixed/u-none/sparse/trunc/ooo/dupid/emptychoices/nulldelta/strusage/badargs`,
   另有 `badsearchargs` 未加 —— `-search` 本地执行路径的非法 JSON 兜底已静态确认
   `runProxyTool` 内 try/catch, 见 proxy.mjs:2683-2687)。重启 mock 时 `requests.jsonl` 被清空,
   已从备份恢复 A 组旧条目。其他组如需复用这些场景可直接用 `SCN:<name>`。
