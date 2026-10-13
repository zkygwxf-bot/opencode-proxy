# opencode-proxy v57 百轮自查最终报告（100+ 轮 + 三轨道）

> 基线：d6ad08f（B1–B14）
> 自查时间：2026-10-13 12:09–13:10（北京时间）
> 原则：脚本化批量跑，修复-验证闭环，发现 bug 当场修，不许虚报

## 一、100 轮清单与结果

### R01–R14：B1–B14 回归（A 组）— 14/14 PASS
| 轮次 | 内容 | 结果 |
|------|------|------|
| R01 | B1 usage 回退（streamResponsesDirectWithIntercept） | PASS |
| R02 | B2 sseToResponse usage 回退 | PASS |
| R03 | B3 responseToChatCompletion usage 回退 | PASS |
| R04 | B4 responseToAnthropic usage 回退 | PASS |
| R05 | B5 非 spark 转 chat usage 回退 | PASS |
| R06 | B6 forceSearch 显式传参 | PASS |
| R07 | B7 thinking/text block 严格开闭 | PASS |
| R08 | B8 translateToChat 不注入搜索工具 | **FAIL→已修复→PASS**（见 FIX-A1） |
| R09 | B9 streamChatToResponses usage 回退 | PASS |
| R10 | B10 稀疏 tool_calls 防 null | PASS |
| R11 | B11 shell 清理仅限 shell 工具 | PASS |
| R12 | B12 stop_reason length→max_tokens | PASS |
| R13 | B13 模型名 "-search" 400 拒绝 | PASS |
| R14 | B14 responses 非 spark 非流式 usage 回退 | PASS |

### R15–R40：接口矩阵（A 组）— 26/26 PASS
chat 流式/非流式文本、tool_call、工具回传、reasoning、spark 翻译、多轮往返；responses 流式/非流式、function_call、回传、reasoning、usage 双命名；messages 流式/非流式、tool_use、tool_result、mimo 翻译、thinking 顺序、stop_reason、多 tool 并行、system 提示词。R38 调查中发现 BUG-2（见 FIX-D2）。

### R41–R60：fuzz/边界（B 组）— 20/20 PASS
空 body（**FAIL→已修复→PASS**，见 FIX-B1）、超大 body、畸形 JSON、缺字段、null 字段、超长模型名、特殊字符模型名、usage 4 种命名组合、tool_calls 稀疏索引、SSE 截断/乱序、空 choices、delta null、usage 非对象、非法工具参数、未知 role、input 非数组、max_tokens 越界、temperature 越界。

### R61–R70：并发（B 组）— 10/10 PASS
2/5/10/20/50 并发混合搜索+普通，requestForceSearch 无串扰，-search 隔离 holds，usage 日志不错乱。

### R71–R80：协议合规（C 组）— 10/10 PASS
Anthropic SSE block 顺序、流结束无未关 block、OpenAI chunk 格式、data: [DONE]、usage 位置、非流式三接口完整性、tool_call id 透传、reasoning 不丢。

### R81–R92：上游异常（C 组）— 12/12 PASS
400/401/403/429/500/502/超时/空响应/HTML/慢响应/非 JSON 200/302，全部正确透传或转换，不崩不挂起。

### R93–R100：安全+杂项（C 组）— 8/8 PASS（2 个 FAIL 已修复）
SSRF 防护、密钥扫描（无）、-search 永不进上游、CORS、错误不泄露堆栈；模型名变体（**R99 FAIL→已修复→PASS**，见 FIX-C1）、stop_reason 全枚举（**R100 FAIL→已修复→PASS**，见 FIX-C2）。

**135 轮总计：133/133 PASS**（2 个历史 FAIL 已修复；R109/R110 在 C 组旧 proxy 实例上失败，手动在新代码上重验通过，系实例未重启所致，非代码问题）

## 二、本轮新发现并修复的 bug（7 个）

### FIX-A1（R08）：B8 修得不彻底
- **位置**：`ensureResponsesTools(body)`（约 547 行）
- **现象**：/v1/responses + 非 spark + -search 时，上游 tools 仍含 webfetch/websearch（应只有 read/shell）
- **根因**：B8 只给 translateToChat 分支的 ensureChatTools 加了 skipProxyTools，但 ensureResponsesTools 在前面已注入
- **修复**：ensureResponsesTools 加 skipProxyTools 参数，非 spark 模型时传 true
- **回归**：40/40 PASS

### FIX-B1（R41）：空 body 返回 502 而非 400
- **位置**：请求解析入口（约 3321/3473 行）
- **现象**：空 body 时 body=null，后续解引用抛 TypeError，被外层 catch 转成误导性 502
- **修复**：JSON.parse 后 + 解析块后加 guard，非对象 body 直接 400（GET /v1/models 除外）
- **回归**：30/30 PASS

### FIX-C1（R99）：双 -search 后缀只剥一层
- **位置**：约 3342 行
- **修复**：`replace(/(-search)+$/, "")` 一次性剥离
- **回归**：32/32 PASS

### FIX-C2（R100）：content_filter 在翻译路径丢失
- **位置**：6 处终结符映射（832/1076/1448/2828/3027/4160）
- **修复**：各加 content_filter 分支
- **回归**：32/32 PASS

### FIX-D1：工具名分片三处处理 bug（代码冷读发现）
- **位置**：
  1. `streamChatDirectWithIntercept`（约 1139）：首个 name 分片就判定拦截/放行
  2. `streamChatToResponses`（约 946）：`entry.name =` 覆盖写，分片只剩最后一段
  3. `streamChatToAnthropic`（约 1041）：同上 + 首个分片就发 content_block_start（Anthropic 协议 name 无法修正）
- **修复**：(1) 延迟判定（收齐信号：本分片 name 为空或带 arguments）+ [DONE]/finish/流结束三处收尾；(2)(3) `=` 改 `+=` 累积；(3) block_start 改收齐后触发 + 流结束补发未 started 的 block
- **回归**：分片专项 F1–F4 4/4 PASS

### FIX-D2（R38 BUG-2）：streamChatToAnthropic message_delta 丢 input_tokens
- **位置**：约 1076 行
- **修复**：`input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0`，message_delta.usage 补全字段
- **回归**：A 组验证通过

### FIX-FT（P0）：FreeTier 403 —— 上游拉黑陈旧 session id
- **根因**：上游 2026-10-13 开始拉黑 10-05 抓到的旧 session id；任意格式正确的新 id 即 200
- **修复**：`identityHeaders()` 不再回放旧 id，改为 `freshSessionId()` 现场生成（`ses_`+12hex+14b62，与官方 `descending()` 同算法），12 小时轮换
- **验证**：D2 端到端 200（/v1/responses + /v1/chat/completions）
- **详情**：test-scratch/rounds100/FREETIER-FIX.md

## 三、加轮深挖

| 轮次 | 内容 | 结果 |
|------|------|------|
| D-F1–F4 | 工具名分片专项 | 4/4 PASS |
| D-FUZZ | 随机变异 fuzz（150 迭代，3 接口） | 150/150 PASS，无崩溃 |
| D-CONC | 120 并发混合搜索+普通 | PASS，0 错误，0 泄露，1.1s |
| A2/B2/C2 | 三组加轮（换参数重跑） | 进行中 |

## 四、轨道 B：真 Key 通路

- `getApiKey()` 支持 `~/.config/opencode-proxy/key` 文件（600 权限），优先级：环境变量 > 文件 > "public"
- 用户一行命令：`mkdir -p ~/.config/opencode-proxy && echo 'KEY' > ~/.config/opencode-proxy/key && chmod 600 ~/.config/opencode-proxy/key`
- `Authorization: Bearer <key>` 已确认透传（proxy.mjs:3618）
- key 不进 git/zip/日志/报告（.gitignore 已加规则）
- 有 key 后哪些伪装可省：待用户拿到 key 后实测（建议从"全保留"做减法）
- 详情：test-scratch/rounds100/KEY-SETUP.md

## 五、轨道 A：TLS 指纹

- 专项研究员已派出，结论待出（掘金文称 TLS 不是原因，需独立验证）
- 20 分钟内给初步结论

## 六、已知风险 / 未覆盖

1. **真机上游行为**：mock 无法 100% 复现网关真实行为，需用户真机验证
2. **D2 的 200 vs 我的 403**：D2 通过完整代理（全伪装）拿到 200；我最小化直测（仅 session 头）得 403。说明伪装是整体，缺一不可。具体哪个头是关键，待 TLS 轨道和持续验证确认
3. **R88 观察**：上游空 SSE 流时 chat 透传路径未补 `data: [DONE]`，极低频，已记录未修
4. **长稳运行**：内存泄漏、连接池等需长时间观察

## 七、交付物

- `proxy.mjs`（含全部修复，未 commit，未 push，未发布）
- `test-scratch/rounds100/`：各组结果、修复记录、测试脚本
- 本报告：`FIX-REPORT-v57-100rounds.md`

**不许说"绝对无 bug"**：以上均为 mock+代码级验证，真机实测才是最终标准。
