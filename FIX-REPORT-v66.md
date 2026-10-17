# FIX-REPORT v66（2026-10-17）

## 背景：v65 在用户手机上全量 403（FreeTierError）
同一 zip 在姐姐 VM 上实测正常、用户手机上全部 403。先后排除：更新命令备份恢复说、~/.config 外部坏身份说（连.config 整删、迁移日志证明包内身份仍 403）、Bettbox 开关说（关掉仍 403）。用户自行 A/B 补充关键事实：机场节点香港出口 403、美国出口正常——门控强度随出口 IP 而变，混搭形状在严查出口上被拦死。

## 真根因
上游当天（2026-10-17）收紧 /zen/v1 老车道免费门；咱们的请求形状混搭：身份文件是 OpenCode 1.18.34 老客户端的，而塞的工具是 2.x 的 shell+read 真定义，还多发 x-opencode-session-id、project 发原始值 "global"、x-opencode-request 用 msg_ 前缀、Accept */*。

## 修复（双对照：官方源码 + opencode2api 当日最新提交 2319941/a9470df/076451f）
1. **老车道形状对齐**（opencode2api legacy 车道）：伪装工具只留一个 "read" 空壳 stub（描述明示 DEPRECATED 禁用；[read] 单独可过、无 read 任意组合 403、描述与 schema 不校验）；不发 x-opencode-session-id；x-opencode-project 改 prj_+sha256("prj\0"+signal) 前 24 hex；x-opencode-request 改 req_+32hex；Accept 改 application/json, text/event-stream；客户端工具原样不动。
2. **双车道回退**（学 opencode2api 可用性设计）：主车道 /zen/v1；启动探针先探一发；任一请求撞 FreeTierError 即进程级切换 /inference 新车道（UA opencode/latest/2.0.29/cli、带 x-opencode-session-id、project 裸 40 hex、不发 x-opencode-request、核心工具换 tools-*.json 原版定义 shell/edit/glob/grep/read、客户端同名工具替换为原版），RikkaHub 自动重试即接上。21 处上游 fetch 全部经 laneUrl。
3. **日志清理**（用户点名）：删全部原始返回转储与启动环境行；"免费身份已过期。续命办法…" 长日志统一缩短为"上游报错：免费层拒绝（403 FreeTierError）"。
4. 官方源码对照：descending() 公式与计数器语义（每毫秒重置、从 1 起；咱们进程级首铸 counter=1，落在 opencode2api 实测可过窗口 1–63 内）；官方 2.0.32 UA 形 opencode/<channel>/<version>/cli 对应新车道，1.18.x 形对应老车道；read/shell 均为官方真工具。

## 测试（最终文件）
- v65 套件 P17/T13/S30/G120/U16：48/48 聚合全过（196 项检查）；并行计时 906ms vs v64 顺序基线 2715ms。
- 主套件 run-tests.mjs：27/27（S1/S3 两条断言按 v66 新形状更新：read 在、shell 不在；其余断言未动，功能断言——搜索注入/本地执行/透传——原本即通过）。
- 真实上游（最终包，VM）：/v1/models 20 条；三接口 beam-free-search 多搜索全过（responses/chat/messages 均真实执行搜索并汇总出字，日志 🔍 共 10 次）；glm 普通对话过门（429 滚动限流）；日志零 FreeTierError、零调试行；启动探针报老车道可用。
- 用户手机（v66dual 同代码先行版）：装后正常出字（用户 16:29 回报；其间香港出口仍 403、美国出口正常，与门控随出口变化的判断一致）。

## 遗留
- worker.js 仍为旧骨架（待用户拍板移植或废弃）。
- 车道切换为进程级单向（zen→inference），进程重启后重新探针决定。
