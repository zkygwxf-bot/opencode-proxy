# FIX-REPORT v67 — 原生搜索新版型号识别修复 + 并发搜索压力检查

日期：2026-10-17（v66 同日热修）
触发：用户在 RikkaHub 中使用 DeepSeek（Responses 模式）+ 搜索设置选「模型搜索」时，模型回复称自己没有联网搜索工具（工具列表里只有客户端本地工具与 read 占位）；改用带 `-search` 后缀的模型则搜索正常。用户指出 v65 加入一轮多工具并行之前该组合可正常搜索。

## 一、根因

反代对「客户端原生搜索」的识别只精确匹配两个字符串：`web_search`、`web_search_preview`。
RikkaHub 当前版本发送的搜索工具类型为带日期的型号 `web_search_2025_08_26`（及同族的 `web_search_preview_2025_03_11`），不在识别名单内，被当作不支持的工具静默丢弃 → 不注入 websearch/webfetch → 模型如实报告没有搜索工具。`-search` 后缀模型走独立的后缀触发路径，不受影响，故一直正常。

在隔离 mock 测试台上做了 A/B 实证（记录上游实际收到的工具集）：

| 客户端发送的工具类型 | v66 上游工具集 | 结论 |
|---|---|---|
| `web_search` | eval_javascript、read、webfetch、websearch | 正常 |
| `web_search_preview` | 同上 | 正常 |
| `web_search_options`（Chat 侧信号） | 同上 | 正常 |
| `web_search_2025_08_26` | 仅 eval_javascript、read | **搜索被丢弃（本 bug）** |
| `web_search_preview_2025_03_11` | 仅 eval_javascript、read | **搜索被丢弃（本 bug）** |

说明：究竟是 RikkaHub 改了发送的型号、还是上游/生态统一换代，未能从其源码确认（仓库两次克隆均失败）；但症状、A/B 证据与修法均与具体型号无关——识别放宽到前缀匹配后，任何当前与未来的 `web_search*` 型号都能识别。

## 二、修复

`proxy.mjs` 原生搜索检
...[truncated 2129 chars]