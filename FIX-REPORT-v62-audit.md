# opencode-proxy v62 自查报告（20 轮）

日期：2026-10-17 ｜ 基线：v61（commit 542a526）｜ 目标：找出并修复全部 bug（含用户没提过的）
方法：代码冷读（行号级）+ 本地合成复现。搭建了全真测试台：mock 上游（/tmp/mock-upstream.mjs，127.0.0.1:9999，
覆盖 18 种上游行为）+ proxy 测试副本（/tmp/ptest，UPSTREAM 指向 mock，PORT 8789），驱动脚本 /tmp/run-audit.mjs。
真实上游只用于：/v1/models 名单 union 验证（不耗额度）——额度已被当日测试打空，上游返回 FreeUsageLimitError。

体例参考 FIX-REPORT-v57-100rounds.md。

---

## 一、20 轮清单与结果

| 轮 | 范围 | 结果 |
|---|---|---|
| R1 | /v1/models 与可调用名单一致性（含 1.2 补列、-search 变体） | **BUG-1**，已修复，22/22 复测通过 |
| R2 | chat completions 非流式 | PASS（合成：文本/usage/de-stream 全对） |
| R3 | chat 流式 SSE 翻译 | PASS（[DONE]/finish_reason/usage chunk 全对） |
| R4 | Responses API 非流式/流式 | PASS |
| R5 | Anthropic messages 翻译（流式+非流式） | PASS |
| R6 | 工具调用全链路（定义注入/参数分片/并行/tool 回传/翻译路径/v60 兜底） | PASS（6 子项）+ webfetch 拦截→本地执行→follow-up 端到端验证通过 |
| R7 | -search 后缀（剥离/工具注入/模型名透传） | PASS |
| R8 | 错误处理（上游 4xx/5xx/HTML/403/畸形 SSE/无 usage） | PASS；**BUG-2** 已修复 |
| R9 | 超时与重试（300s 总超时/5 轮上限/无无限重试） | PASS（代码审查：agentic loop 全有轮数上限，无裸重试） |
| R10 | session/header 与 2.0.32 官方源码一致性复核 | PASS（见 §三） |
| R11 | 并发与连接泄漏 | PASS（300+ 请求后 fd 稳定 19；requestForceSearch 全显式传参，无全局竞态） |
| R12 | 请求体边界（非法 JSON/空/null/空消息/超大） | PASS（400 形状合规） |
| R13 | 模型名校验与未知路由 | PASS（404 形状合规；completions 不做本地白名单拦截——设计如此，上游 400 透传） |
| R14 | PORT/环境变量/启动脚本 | **BUG-7** 已修复；ai/spark/start.sh 复核通过 |
| R15 | session.json 读取容错（缺失/损坏） | PASS（500 中文指引） |
| R16 | 日志敏感信息泄漏 | PASS（无 key/session 落日志；PROXY_DEBUG 对 authorization 脱敏） |
| R17 | worker.js 与 proxy.mjs 一致性 | **BUG-5** 已修复（名单同步；worker 仍为 legacy CF 形态，见存疑 S4） |
| R18 | README.txt 与实际行为一致性 | **BUG-4** 已修复 |
| R19 | 内存/句柄随长跑增长 | PASS（见 §三 S1） |
| R20 | 总回归 | 合成 22/22 通过；真实上游 models union 验证通过 |

---

## 二、本轮新发现并修复的 bug（7 个）

### BUG-1（中，R1）：/v1/models 漏掉可调用的 muse-spark-1.2-contributor-free
- 症状：/v1/models 只返回 18 条（9 模型×2），1.2 不在列表里，但它经 Responses 通道实测可调用。
- 根因：models 路由把上游 /zen/v1/models 的结果按 FREE_MODEL_IDS 过滤后直接返回（proxy.mjs:3860 原）；上游名单本来就不列 1.2（Responses 通道模型），于是可调用≠列表。
- 触发：任何客户端拉模型列表。
- 修复：过滤后把 FREE_MODEL_IDS 里缺的 id 补上（去重，created:0），再统一加 -search 变体（proxy.mjs models 路由，v62 注释）。
- 验证：合成 mock（上游故意不列 1.2）→ 列表含 1.2 与 1.2-search；真实上游 → 20 条，1.2/1.2-search/deepseek 均在列。用户亲点需求，名单口径改为"可调用"。

### BUG-2（低，R8）：非流式请求内部异常时日志只有"失败"两字
- 症状：catch 分支里 `zenBgFail(seq)` 不带任何错误详情（proxy.mjs:4896 原），排障时看不出断在哪。
- 修复：zenBgFail 加可选 detail 参数，非流式分支传入 `e?.message`（proxy.mjs:152,4896）。
- 验证：node --check；合成复现（上游抛错）日志现带原因。

### BUG-3（低，代码冷读）：responseDone 声明了但从未赋值
- 症状：`let responseDone = false`（proxy.mjs:3331 原）没有任何赋值处，catch 里"已完成的不算断开"判断永远走不到。
- 修复：一行 `res.on("finish", () => { responseDone = true; })`（proxy.mjs:3341）。
- 验证：node --check；行为无变化（原有 res.writableEnded 已覆盖大部分场景），属正确性补齐。

### BUG-4（中，R18）：README.txt 记载不存在的代理池功能
- 症状：README.txt 有"出站代理池（可选，默认关闭）"整节，介绍 OPENCODE_PROXIES/proxies.txt；但代理池代码已按用户决定全部回退，proxy.mjs 中零引用（grep 确认）。
- 修复：删除该节；标题 v34→v62；顶部新增 v62/v61 更新说明（README.txt）。
- 验证：文档与代码逐项核对。

### BUG-5（低，R17）：worker.js 白名单过期
- 症状：WORKING_FREE_MODELS 仍含已下线的 1.3、已死的 ultra、不可用的 step-5（worker.js:118 原）。
- 修复：同步为当前 10 个白名单 id，并加注"worker 为 legacy CF 形态，翻译器细节以 proxy.mjs 为准"。
- 验证：名单与 FREE_MODEL_IDS 逐项 diff 一致。

### BUG-6（低，R1 附带）：hideSearchVariants 死代码与过时注释
- 症状：`let hideSearchVariants = false` 从未被置 true（/r 路径注释明确说"不再区分"）；相关日志文案"精简版""8 模型"误导；models 路由注释还写"4 个免费模型""spark-1.3/1.2（2026-10-06）"。
- 修复：删除该标记及分支，注释更新为当前事实。
- 验证：node --check；models 路由行为不变（之前恒为 false）。

### BUG-7（低，R14）：PORT 非法时抛未捕获堆栈
- 症状：`PORT=abc` → `Number("abc")`=NaN → `server.listen(NaN)` 同步抛 ERR_SOCKET_BAD_PORT（实测），server.on('error') 捕获不到，用户看到英文堆栈。
- 修复：启动期校验 PORT（1-65535 整数），非法时中文提示并 exit(1)（proxy.mjs:40）。
- 验证：`PORT=abc node proxy.mjs` → 中文提示；正常值不受影响。

---

## 三、深挖与交叉验证

### R10：2.0.32 对齐复核
- OPENCODE-2.0.32-AUDIT.md 方法复核：md5/文本对比 + opencode2api 交叉，可信。
- 独立加验 session id 公式：`mintedTimePrefix()` 产物符合 opencode2api Go 版校验正则
  `^[0-9a-f]{9}f[c-f][0-9a-f]$`（internal/identity/request.go:115），倒序性（后 mint 的前缀更小）实测成立。
  注：48 位截断下只能还原 ms mod 2^36，官方客户端同理，非我方问题。
- UA：session.json 捕获的真客户端 1.18.34 老形状走 legacy /zen 通道，实测可用；默认 `opencode/latest/2.0.28/cli`
  仅 session 缺失时用。按"无证据不动"规则保持。

### R19：内存/句柄
- 2400 次混合请求（流式/非流式交替）：fd 恒为 19，无泄漏。
- RSS：100→136MB 线性爬升后，1500 次持续请求 + 空闲 30s 回落到 102MB——V8 堆伸缩，非泄漏。
  结论：PASS。真实使用量（每天几十上百次）下可忽略。

### R6：工具调用
- v60 三处兜底未动（git diff 确认：translator 区零改动）。
- 端到端：chat 上游调 webfetch → 反代本地执行（mock/testpage 内容 "secret content 12345" 被抓回）→
  follow-up → 客户端收到最终答复；日志 🔍 标记正常。

---

## 四、存疑项（不当 bug 报）

- S1：请求级 RSS 爬升 ~40KB/次（GC 前），已证为 V8 堆行为（§三 R19），非泄漏。观察即可。
- S2：本轮合成测试全部走 mock；真实上游 chat/responses 因当日免费额度打空（FreeUsageLimitError）未重测。
  注意这是**额度**问题不是 403——请求已通过免费门控。
- S3：mock 未覆盖"上游 200 但 content-type 非 SSE 非 JSON"的畸形分支（代码有透传兜底，见 4860-4876）。
- S4：worker.js 仍是 10-10 的 CF 实现骨架（无 v60 翻译器修复、无 descending session 现场生成、用硬编码 SESSION_ID）。
  本轮只同步了名单；要完整对齐需另起一轮移植，或明确废弃该文件。

## 五、未验项（如实）

- U1：glm-5.3-flash-free、nemotron-3.5-super-vl-free、beam-free 三个模型的上游逐个可用性（额度打空）。
  它们在白名单和 /v1/models 列表中，待每日探针（opencode-freetier-probe）验证。
- U2：worker.js 的 Cloudflare 真实部署（无 CF 环境）。
- U3：300s 上游总超时（时长不可实测；代码审查：AbortSignal.timeout(300000) 全路径覆盖）。
- U4：真机 Termux 的 ai 持久化（v61 已由主代理在干净 shell 验证；本轮未重复）。

---

## 六、交付物

- 代码：本地 commit（未 push），版本号升为 62.0.0（package.json）。
- 发布包：~/workspace/opencode-proxy/opencode-proxy-phone-v62.zip（10 文件，与 v61 同组成；
  session.json 为占位、无真实凭据；node --check 通过）。
- 本报告：~/workspace/opencode-proxy/FIX-REPORT-v62-audit.md。
- 改动统计：4 文件，+69/-44（proxy.mjs/models 路由+日志+PORT、README.txt、worker.js 名单、package.json 版本）。
  v60 三处翻译器兜底、ai 持久化、白名单 10 模型均未回退。
