# OpenCode 2.0.32 对齐审计（2026-10-17）

对照基线：v59 对齐的是 2.0.28。本次查官方最新 2.0.x = **v2.0.32**
（GitHub tags：v2.0.32 > v2.0.31 > v2.0.30 > v2.0.29 > v2.0.28；仓库已迁移
sst/opencode → anomalyco/opencode，默认分支 dev）。

审计方法：逐项拉取官方源码（tag v2.0.32）与 2.0.28 版做 md5/文本对比，
关键结论与 opencode2api 最新 main（a9470df，v1.4.1 之后）交叉验证。

## 1. 会话 ID 生成（packages/schema/src/session-id.ts + identifier.ts）

- 结论：**2.0.28 → 2.0.32 无变化**。
- 官方算法：`"ses_" + descending()`；descending() = `~(unix_ms*0x1000+counter)` 取低 48 位
  转 12 位 hex + 14 位 base62（字符集 `0-9A-Za-z`）。
- 咱们的 `freshSessionId()`/`mintedTimePrefix()` 与官方逐行一致（v58 已验证，
  本次复核确认未变）。**无需改动。**

## 2. User-Agent 形状（packages/core/src/app.ts）

- 官方：`` `opencode/${app.channel}/${app.version}/${app.name}` ``
  即 `opencode/<channel>/<version>/cli`（如 `opencode/latest/2.0.32/cli`）。
- 官方升级服务（services/update/src/index.ts）用正则
  `/^opencode\/(?:([^/]+)\/([^/]+)\/cli|(.*))$/` 解析 UA —— 证实 2.x 形状为
  `opencode/<channel>/<version>/cli`，括号内为兼容 1.18.x 老形状。
- 咱们：session.json 捕获的是真客户端 1.18.34 的老形状
  `opencode/1.18.34 (linux x64)`，走 legacy /zen/v1 通道，实测 200 通过。
  默认 UA `opencode/latest/2.0.28/cli` 仅在 session.json 缺失时用，实际走不到。
- **结论：无需改 UA。** 上游接受多个版本区间（opencode2api 内部注释亦如此：
  "Upstream accepts a range of releases, so this only needs bumping when it
  starts rejecting older ones"）。当前 1.18.34 老形状在 /zen 通道实测可用，
  无证据表明必须升级；按既有规则不动。

## 3. 请求头（packages/core/src/session/model-request.ts @ v2.0.32）

官方 2.x 发往 Zen 的头：
- `x-opencode-session-id: session.id`
- `x-opencode-parent-session-id`（有父会话时）
- `x-session-affinity: affinity`
- `X-Session-Id: affinity`
- `User-Agent: App.useragent(app)`
- `x-opencode-project: session.projectID`
- `x-opencode-session: affinity`
- `x-opencode-client: app.name`

注意：**官方 2.x 不发 `x-opencode-request`**。咱们发它是 1.18.x 老形状的
一部分（与 opencode2api 最新 main 的 legacy /zen/v1 通道做法一致：
a9470df/2319941 恢复 v1.3.7 请求形状），/zen 通道实测 200。**无需改动。**

## 4. 工具定义（packages/core/src/tool/*.ts）

- 抽查 read-filesystem / shell / edit / glob / grep / write 六个工具，
  v2.0.28 与 v2.0.32 源码 **md5 完全一致**，无变化。
- 咱们 tools-chat.json / tools-responses.json（10-14 按官方 wire 格式还原）
  依然有效。**无需改动。**

## 5. 免费层门控（黑盒实测结论，非官方源码可查）

上游 403 FreeTierError 的触发条件（2026-10-17 实测 + opencode2api 交叉）：
1. session id 非官方 descending() 格式 → 403（v58 已修）。
2. 非流式请求（stream:false）→ 403；**stream:true 才放行**。
   咱们 proxy.mjs 已在三处强制上游流式（与 opencode2api v1.3.2 做法一致）。
3. 匿名/新 session 在 /zen/v1/chat/completions 上需 1.18.x 老指纹
   （老 UA + x-opencode-request + read/shell 工具名在场）；咱们的
   session.json 捕获指纹 + 每 12 小时轮换 fresh session id，实测全通。
4. opencode2api 10-14 的 /inference 新门控（2.x UA + 40 位 hex project +
   官方工具定义逐字节校验）是**匿名通道**的事；咱们走 legacy /zen 真身份
   通道，不受影响（其最新 main 仍把 legacy /zen/v1 作为首选通道）。

## 6. 本次审计触发的改动

- `FREE_MODEL_IDS` 白名单更新（2026-10-17 逐个实测）：
  移除 `muse-spark-1.3-contributor-free`（上游 410 下线）、
  `nemotron-3-ultra-free`（200 但流内 error、上游已从免费名单移除）、
  `step-5-preview-free`（400 不可用）；
  新增 `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、
  `nemotron-3.5-super-vl-free`、`beam-free`（均 200 且有真回复）。
- `probe.mjs` 升级为模型可用性探针：除 /v1/models 连通性外，逐个模型发
  最小流式请求并校验流内容（防 200 包 error 的"假活"），失败即 exit 1
  供 cron 告警（对标 opencode2api v1.3.6 的自动探测）。

## 7. 未改动项及理由

- UA 版本号（2.0.28 默认值）：无证据表明被拒，不动。
- 鉴权/session 生成逻辑：与官方 2.0.32 一致，不动。
- 工具定义：官方无变化，不动。
- 上游端点：继续 `https://opencode.ai/zen/v1`（opencode2api 最新仍首选此通道），不动。
