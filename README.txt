OpenCode 免费模型反代 - 手机版 (v34)
==============================================

v34 更新内容（思考参数全接口适配）：
- 修兼容 OpenAI 模式 400：chat 路径的顶层 reasoning_effort 在翻译时
  转成 reasoning: {effort, summary:'auto'} 形状（上游不认顶层参数）
- responses 直连/翻译统一形状；'none' 直接删掉；没要摘要自动补
- 补 seed 参数清洗（responses 上游不认，透传会 400）
- 开/不开 response API，思考参数（无/低/中/高）行为一致，思维链都正常显示

v33 更新内容（思维链修复 + 异常修复）：
- 修 RikkaHub 测试 400：reasoning_effort='none' 上游不认，直接删掉走默认
- 修 1.3 思维链空白：翻译路径之前把思考参数直接丢了，现在透传；
  没要摘要时自动补 reasoning.summary='auto'，上游才会回思维链内容
  （spark 翻译路径默认就要摘要；longcat 直连本来就正常）
- 修"异步任务异常：clientWantsStream is not defined"：
  变量在 try 里声明、catch 里引用，作用域错误，已移到 try 外

v32 更新内容（20 轮循环自查 + 全面优化）：
- Bug 修复 17 轮：webfetch/websearch 工具拦截补全 6 条调用路径；
  非流式主请求结果行丢失（被误标后台）已修；日志结果行加 #seq 前缀，
  并发下开始/结果行可配对；/v1/models 白名单过滤死代码复活；
  CORS 补全 413 超限路径；错误体统一 OpenAI 标准形状
- 酒馆插件适配：top_k 透传导致上游 400→自动剥离；
  response_format: json_object 按规范转成 text.format；
  插件直连"加载模型"可看到 8 个模型（4 白名单 + 4 -search 变体）
- 日志：新增调用方 IP 显示，如 #14 · 11:20:20 · 127.0.0.1(RikkaHub) · 模型名；
  fmtK 超大数走 M 档（不再显示 1000.0K）；非流式请求也打开始行
- 性能：webfetch 改流式限量读（100MB 页面内存 ~205MB→~5MB）；
  htmlToMarkdown 去掉 4 处冗余实体解码（-25%）；大输出拼接改数组 join；
  去掉多余的 Buffer.from 拷贝
- 官方对齐：补发 x-opencode-session-id 头；x-opencode-request 改稳定值

免费档 IP 说明
1. 额度口径：按出口公网 IP 计次（匿名 key "public"，与账号无关），约 1000 次/IP/天。
2. 重置时间：每天北京时间 08:00（即 UTC 午夜）重置，超限只会返回 429，
   次日自动恢复，不封号。
3. IP 类型：不要求住宅 IP，机房/数据中心 IP、家庭宽带、手机流量均可正常使用，无降权。
4. 代理注意：VPN/代理切换出口 IP 不会被封；但同一出口 IP 下所有人共享额度，
   建议勿将本反代地址公开分享，否则额度会被他人耗尽。
5. 额度为官方服务端动态配置，具体数字可能调整；新 IP 初期有双倍额度红利，用完后恢复基准。

v31 更新内容（酒馆插件直连支持）：
- 加 CORS 头：酒馆插件关掉"通过酒馆渠道发送"后可直连本反代
  （之前直连会报 Failed to fetch，就是缺这个）

启动方法 (Termux)：
  cd ~/phone-bundle && node proxy.mjs
  或输入 spark（一键别名）

RikkaHub 配置：
  URL: http://127.0.0.1:8788/v1
  Key: 随便填 (如 123)
  模型: muse-spark-1.3-contributor-free

酒馆插件配置：
  端点填 http://127.0.0.1:8788/v1，协议选"兼容 OpenAI"（走 /chat/completions）；
  关掉"通过酒馆渠道发送"可直连本反代（v31+ 已支持跨域）。
  注意：插件里不要选 /interactions 协议，反代无此路由。

注意：上游是否接受 websearch/webfetch 工具名需真机验证，
若 403 把 WEBFETCH_NAME/WEBSEARCH_NAME 改成 "read" 即可。
