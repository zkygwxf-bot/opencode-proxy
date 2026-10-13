# B组 (R41–R70) 修复记录（修复-验证闭环）

> 协议: 发现 bug → 持 `.fixlock` 锁 → 最小化改 proxy.mjs → 重启 PORT=18782 实例 → 全量 30 轮回归 → 放锁。
> 未 git commit（由父 agent 统一检查后提交）。

---

## Fix-1 —— R41: 空请求体返回 502 而非 400

- **轮次**: R41（fuzz/边界：空 body）
- **位置**: `proxy.mjs:3321`（新增）、`proxy.mjs:3473`（新增）
- **现象**: `POST /v1/chat/completions`、`/v1/responses`、`/v1/messages` 发送空 body 时，
  proxy 返回 `502 {"error":{"message":"上游连接失败，稍后重试"}}`。实测上游正常返回 200，
  502 文案把客户端错误伪装成上游故障。
- **根因**: 空 body 时 `body` 保持 `null`，非流式分支直接解引用：
  旧 `:4225` `Array.isArray(body.messages)`、旧 `:4332` `asInputArray(body.input)` 抛 TypeError，
  被外层 catch 统一转成 502。另外 `raw="null"`（字面量 null body）会在解析块内的
  `body.reasoning_effort` / `body.messages ?? body.input` 处先抛错。
- **修复内容**（共 9 行，只加 guard，不动原有逻辑）:
  1. `if (raw.length)` 块内、JSON.parse 成功后立即加：
     ```js
     if (!body || typeof body !== "object") {
       return sendErrorJson(res, 400, "请求体为空或不是 JSON 对象");
     }
     ```
     覆盖 `"null"`、数字、字符串等非对象 body。
  2. 解析块结束后（`const forceSearch` 捕获前）加同样的 guard，
     覆盖 `raw.length === 0`（body 保持 null）的情况。
     `upstreamPath === "/zen/v1/models"`（GET 可无 body）被排除，不受影响。
- **回归验证**:
  - 直接验证：空 body ×3 端点 → 400；`null`/`123`/`"hi"` body → 400；
    `GET /v1/models` → 200；正常 chat 请求 → 200。
  - 全量回归：`node runB.mjs` 30/30 PASS（R41 断言已收紧为期望 400；
    其余 29 轮全部保持 PASS，无回归）。
- **持锁**: 约 12:23–12:36（含等 C 组放锁约 95s）；放锁已确认。

---

## Fix-2 —— B72: 非流式 responses 直连路径静默丢弃 function_call（无 follow-up、空终答）

- **轮次**: B72（加轮深挖：responses 非流式 + -search，spark）
- **位置**: `proxy.mjs` `sseToResponse()`（约 1749 行起；新增 `pushFn` 去重收集器 + `output_item.done` 分支）
- **现象**: `POST /v1/responses`（spark-search，非流式）上游返回 webfetch function_call 后，
  proxy 200 返回但 `output[0].text === ""`，且只发 1 个上游请求（无 follow-up、无本地执行）。
  流式同场景（S2/B73）正常——只有非流式中招。
- **根因**: `sseToResponse` 只从 `response.completed.response.output` 数组收集 function_call
  （代码注释称其为"reliable source"）。但部分网关（及当前 mock）的 completed 事件里
  `output: []`，function_call 只出现在 `response.output_item.done` 事件中 → 被静默丢弃 →
  agentic loop 判定无拦截调用直接 break。
  备注：opencode-src 的真实录制流量显示真上游 completed 会重复 output，因此生产环境可能无感；
  但这属于静默丢弃工具调用的健壮性缺口——换一个不重复 output 的网关就会复现。
- **修复内容**（最小化）:
  抽出 `pushFn(item)`（按 `call_id || id` 去重），completed/incomplete 分支与新增的
  `response.output_item.done` 分支共用。真上游两种事件都有时去重后结果与原来完全一致，
  不改变原有行为；completed 为空时则从 output_item.done 兜底收集。
- **回归验证**:
  - 直接验证：同一请求现在返回 `MOCK-FINAL` 终答（含抓取内容），usage 正确合并（82/17 = 两轮之和）。
  - 全量回归：B2（B71–B80）10/10；R41–R70 30/30（含 R41 的 400 断言），无回归。
- **持锁**: 约 12:31–12:38；放锁已确认。
