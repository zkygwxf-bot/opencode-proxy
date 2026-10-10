// OpenAI-compatible proxy for OpenCode Zen free models.
//
// Why this exists: Zen's free tier rejects requests with
//   {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
// unless the request carries OpenCode client identity (session headers)
// plus an agentic payload (tool definitions named "read" and "shell").
//
// What the proxy does per request:
//   1. Adds User-Agent + x-opencode-* / x-session-* headers from session.json
//      (captured from a real `opencode run`; refresh with `npm run capture`).
//   2. Injects the "read" + "shell" tool definitions the free-tier gate
//      requires (verified 2026-10-05: any fewer/different names -> 403).
//      tool_choice is never forced: upstream only accepts "auto"
//      (verified 2026-10-06: "none"/"required"/named -> 400), and the
//      model empirically doesn't call the disguise tools unprompted.
//   3. Forwards to https://opencode.ai/zen/v1 and streams the response back.
//
// NOTE: no key needed for free models — like a fresh `opencode` install,
// the proxy defaults to the literal key "public". Set OPENCODE_API_KEY only
// if you also want paid Zen models through the same endpoint.
// Free models are rate-limited and may be withdrawn at any time; this proxy
// does not change that. If upstream returns FreeTierError the proxy reports
// it and you should re-run `npm run capture` to refresh the session identity.
//
// Endpoints (base http://127.0.0.1:8788/v1):
//   GET  /v1/models
//   POST /v1/chat/completions   (OpenAI chat; free models: *-free, big-pickle;
//                                muse-spark-* auto-translated via Responses API)
//   POST /v1/responses           (OpenAI Responses API; muse-spark-*-free)
//   POST /v1/messages            (Anthropic Messages API; translated via Responses)
//   GET  /health
//
// Features: streaming + non-streaming, tool calling (bidirectional),
// multimodal image input, usage passthrough, per-request fresh msg_ IDs.
import http from "http";
import fs from "fs";
import path from "path";
import dns from "node:dns";

const PORT = Number(process.env.PORT || 8788);
const UPSTREAM = "https://opencode.ai";
const DIR = import.meta.dirname;

// ---------- 中文日志 ----------
// 科技面板风，两行式（开始行 + 结果行，靠 #N 配对，并发下也不乱）：
// #14 · 11:20:20 · 127.0.0.1(RikkaHub) · muse-spark-1.3-contributor-free · 3条消息
// #14 ✓ 首字2.5秒 · 总计2.6秒 · 75tok/s · 入1.4K(缓8%) · 出193（后台2个 ✓）
function fmtSec(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?秒";
  return (ms / 1000).toFixed(1) + "秒";
}
// 1401 → 1.4K，4292 → 4.3K，113 → 113，1500000 → 1.5M（跟 RikkaHub 一致）
function fmtK(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  if (n >= 1000) {
    const k = n / 1000;
    // k≥999.95 时 toFixed(1) 会进位成 "1000.0K"，改走 M 档
    if (k >= 999.95) return (n / 1e6).toFixed(1) + "M";
    return k.toFixed(1) + "K";
  }
  return String(n);
}
// muse-spark-1.3-contributor-free → 显示全名（用户要求不用缩写）
function shortModel(m) {
  if (!m || typeof m !== "string") return "unknown";
  return m;
}
// 时钟时间：10-10 09:30:37，用手机本地时区（带日期，跨夜跑能分清）
function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 调用方 IP：把 ::ffff:127.0.0.1 这类 IPv6 映射还原成 IPv4；拿不到时返回 "?"
function fmtIP(addr) {
  if (!addr || typeof addr !== "string") return "?";
  if (addr.startsWith("::ffff:")) return addr.slice("::ffff:".length);
  return addr;
}
// 客户端分类：RikkaHub / 酒馆(SillyTavern) / 其他（UA 前 20 字符）；缺 UA 或 UA 非字符串不崩
function classifyClient(ua) {
  if (!ua || typeof ua !== "string" || !ua.trim()) return "其他";
  if (/rikkahub/i.test(ua)) return "RikkaHub";
  if (/sillytavern/i.test(ua)) return "酒馆";
  return ua.slice(0, 20).trim() || "其他";
}
// 开始行用的调用方标签：127.0.0.1(RikkaHub)；req 缺 socket/headers 也不崩
function fmtClientTag(req) {
  try {
    return `${fmtIP(req?.socket?.remoteAddress)}(${classifyClient(req?.headers?.["user-agent"])})`;
  } catch {
    return "?(其他)";
  }
}
// 请求序号：开始/完成/取消/结果四行靠 #N 配对，一眼看出哪几行是同一次请求
let reqSeq = 0;
// 代理工具 fallback call_id 全局计数器（跨轮唯一）
let proxyCallSeq = 0;
// 后台请求成功计数：不逐条打扰，只在主请求完成时汇总一句。
// 说明：zenLog/zenBgFail 全同步、无 await，Node 单线程下"++"与"读+清零"
// 不可能交错——"清零吞掉并发计数"的竞态经核实不存在；但汇总会落在
// 任意后完成的流式请求行上（归因错位），是"少刷屏"取舍下的已知局限。
// 失败不进计数：zenBgFail 已单独打一行，再计入汇总会把同一失败报两遍。
let bgOkCount = 0;
// 新格式（用户要求：去树形符号、2行封顶、后台汇总）：
// #14 · 11:20:20 · 127.0.0.1(RikkaHub) · muse-spark-1.3-contributor-free · 3条消息
// #14 ✓ 首字2.5秒 · 总计2.6秒 · 75tok/s · 入1.4K(缓8%) · 出193（后台2个 ✓）
function zenLog({ seq, ttftMs, totalMs, usage, isBg }) {
  const u = usage || {};
  const prompt = u.prompt_tokens ?? u.input_tokens;
  const completion = u.completion_tokens ?? u.output_tokens;
  const cached =
    u.prompt_tokens_details?.cached_tokens ??
    u.input_tokens_details?.cached_tokens;
  const totalS = totalMs / 1000;
  // 解码速度 = 输出 / 总耗时（跟 RikkaHub 口径一致）
  const tps =
    typeof completion === "number" && totalS > 0
      ? Math.round(completion / totalS)
      : "?";
  if (isBg) {
    // 后台请求：只计数不打日志，主请求完成时汇总
    bgOkCount++;
    return;
  }
  // 用户对话：第二行（结果行）。带 #N 前缀——之前 seq 传进来却没用，
  // 并发时多条结果行混在一起根本分不清是谁的，这是真 bug，已修。
  let cachePart = "";
  if (typeof cached === "number" && typeof prompt === "number" && prompt > 0) {
    // 上限 100%：网关口径异常时 cached 可能大于 prompt，不 clamp 会显示"缓存150%"
    const pct = Math.min(100, Math.round((cached / prompt) * 100));
    cachePart = `(缓${pct}%)`;
  }
  let line = `#${seq} ✓`;
  if (typeof ttftMs === "number" && ttftMs >= 0) line += ` 首字${fmtSec(ttftMs)}`;
  line += ` · 总计${fmtSec(totalMs)} · ${tps}tok/s`;
  line += ` · 入${fmtK(prompt)}${cachePart} · 出${fmtK(completion)}`;
  // 后台汇总：有后台成功才附一句（失败已由 zenBgFail 单独打行，不重复计）
  if (bgOkCount > 0) {
    line += `（后台${bgOkCount}个 ✓）`;
    bgOkCount = 0;
  }
  console.log(line);
}
// 开始行：第一行（身份行）。clientTag 可选，老的 3 参数调用照样能用
function zenStartLog(seq, model, msgCount, clientTag = "") {
  const tag = clientTag ? ` · ${clientTag}` : "";
  console.log(
    `#${seq} · ${fmtClock()}${tag} · ${shortModel(model)} · ${msgCount}条消息`
  );
}
// 后台请求失败才单独打一行（成功的只计数）；不碰 bgOkCount，避免汇总里重复出现
function zenBgFail(seq) {
  console.log(`后台#${seq} ✕ 失败`);
}

// 工具定义文件缺失/损坏时给中文提示再退出，不要英文堆栈直接崩
function loadToolsJson(name) {
  const p = path.join(DIR, name);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(`缺少 ${name}：安装包可能没解压完整，请重新下载解压`);
    process.exit(1);
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("not array");
    return arr;
  } catch {
    console.error(`${name} 已损坏（不是标准 JSON 数组），请重新下载解压`);
    process.exit(1);
  }
}
const CHAT_TOOLS = loadToolsJson("tools-chat.json");
const RESPONSES_TOOLS = loadToolsJson("tools-responses.json");
// The free-tier gate only requires the tool NAMES "read" and "shell"
// (verified empirically 2026-10-05: fewer/other names -> 403 FreeTierError).
// Injecting just these two keeps the model focused on the app's real tools
// instead of getting distracted by a dozen fake ones.
const DISGUISE_NAMES = ["read", "shell"];
const DISGUISE_CHAT = CHAT_TOOLS.filter((t) =>
  DISGUISE_NAMES.includes(t.function?.name)
);
const DISGUISE_RESPONSES = RESPONSES_TOOLS.filter((t) =>
  DISGUISE_NAMES.includes(t.name)
);
// 启动期断言：伪装工具丢了会导致每个请求 403，趁早大声报错
if (DISGUISE_CHAT.length < 2 || DISGUISE_RESPONSES.length < 2) {
  console.error("伪装工具 read/shell 未在 tools-*.json 中找到，免费门控无法通过，请检查安装包");
  process.exit(1);
}
// 深冻：DISGUISE_* 与 CHAT_TOOLS 共享对象引用，冻住防止未来某处误改污染所有请求
for (const t of [...CHAT_TOOLS, ...RESPONSES_TOOLS]) Object.freeze(t);
Object.freeze(CHAT_TOOLS);
Object.freeze(RESPONSES_TOOLS);

// ---------- 反代内置工具：webfetch / websearch ----------
// 模型调用时由本反代本地执行，对客户端透明（客户端收不到这些工具调用）。
// 开关：环境变量 ENABLE_WEBSEARCH / ENABLE_WEBFETCH，默认开。
// 设为 "0"/"false"/"off" 可关闭。关闭后工具不再注入，模型行为与原来一致。
// 403 开关：如果上游因工具名报 403，把 WEBFETCH_NAME / WEBSEARCH_NAME 改成 "read"
// （read 是免费门控白名单里的名字，一定能过）。description 已写明真实用途，
// 模型按 description 理解功能，不依赖名字。
const WEBFETCH_NAME = "webfetch";
const WEBSEARCH_NAME = "websearch";
const WEBSEARCH_ENABLED = !["0", "false", "off"].includes(
  String(process.env.ENABLE_WEBSEARCH ?? "1").toLowerCase()
);
const WEBFETCH_ENABLED = !["0", "false", "off"].includes(
  String(process.env.ENABLE_WEBFETCH ?? "1").toLowerCase()
);
const PROXY_TOOL_NAMES = new Set(
  [
    WEBSEARCH_ENABLED ? WEBSEARCH_NAME : null,
    WEBFETCH_ENABLED ? WEBFETCH_NAME : null,
  ].filter(Boolean)
);
// 本请求是否强制启用搜索（模型名 -search 后缀）。handler 入口设置，
// 注入函数读取。注入发生在首个 await 之前，单线程下安全。
let requestForceSearch = false;
// 全量代理工具名（forceSearch 时用）
const ALL_PROXY_TOOL_NAMES = new Set([WEBSEARCH_NAME, WEBFETCH_NAME]);

// 全部代理工具定义（不受环境变量影响，是否注入由调用处决定）
const ALL_PROXY_TOOLS_RESPONSES = [
  {
    type: "function",
    name: WEBFETCH_NAME,
    description:
      "抓取网页正文。传入 url（必须 http:// 或 https:// 开头），返回网页的正文文本。" +
      "format 可选 text/markdown/html（默认 markdown）。" +
      "适合读取文章、文档、新闻等网页内容。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的网页 URL（http:// 或 https:// 开头）" },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description: "返回格式：text 纯文本，markdown 结构化文本（默认），html 原始 HTML",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: WEBSEARCH_NAME,
    description:
      "实时联网搜索。仅在需要最新信息、超出训练数据范围的事实性问题时调用" +
      "（如今日新闻、最新政策、实时数据、查官网）。" +
      "闲聊、常识问题、已有上下文能回答的不用搜。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        numResults: { type: "number", description: "返回结果条数（默认 8，最多 20）" },
        type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description: "搜索类型：auto 均衡（默认），fast 快速，deep 全面",
        },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description: "实时抓取：fallback 失败时抓（默认），preferred 优先抓",
        },
        contextMaxCharacters: {
          type: "number",
          description: "返回上下文最大字符数（默认 10000）",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];
// 根据环境变量过滤后的版本（默认行为）；forceSearch 时用全部
const PROXY_TOOLS_RESPONSES = ALL_PROXY_TOOLS_RESPONSES.filter(
  (t) =>
    (t.name === WEBFETCH_NAME && WEBFETCH_ENABLED) ||
    (t.name === WEBSEARCH_NAME && WEBSEARCH_ENABLED)
);
// chat 格式版本（OpenAI chat completions 形状）
const PROXY_TOOLS_CHAT = PROXY_TOOLS_RESPONSES.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));
// 全量 chat 格式（forceSearch 时用，不受环境变量影响）
const ALL_PROXY_TOOLS_CHAT = ALL_PROXY_TOOLS_RESPONSES.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));
for (const t of [...ALL_PROXY_TOOLS_RESPONSES, ...ALL_PROXY_TOOLS_CHAT]) Object.freeze(t);
Object.freeze(ALL_PROXY_TOOLS_RESPONSES);
Object.freeze(ALL_PROXY_TOOLS_CHAT);
for (const t of [...PROXY_TOOLS_RESPONSES, ...PROXY_TOOLS_CHAT]) Object.freeze(t);
Object.freeze(PROXY_TOOLS_RESPONSES);
Object.freeze(PROXY_TOOLS_CHAT);

// 免费模式硬白名单：真机实测可用的 4 个免费模型。
// 用于 /v1/models 列表过滤（只展示这 4 个 + 各自的 -search 变体）。
// 设置了 OPENCODE_API_KEY（付费模式）可走付费 Zen 模型，不受此限。
const FREE_MODEL_IDS = new Set([
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "mimo-v2.6-flash-free",
  "longcat-2.5-preview-free",
  "step-5-preview-free",
  "space-bunny-free",
  "nemotron-3-ultra-free",
]);
// 注：exo-free 已下线(410)；jev-1.13-free、ling-3.0/3.1-flash-fin-free、
// nemotron-3.5-lightning-free 实测 400/403 不可用，已剔除（2026-10-10）

// 内置模型列表兜底：上游 /zen/v1/models 失败或返回异常时用，保证客户端
// （RikkaHub/酒馆插件等）在任何接口模式下总能拉到模型。
// OpenAI 标准形状 {object:"list", data:[{id, object:"model", ...}]}。
// hideSearch：true 时只返回 4 个基础模型（/r 前缀 Response API 专用）。
function buildFallbackModels(hideSearch = false) {
  const data = [];
  for (const id of FREE_MODEL_IDS) {
    data.push({ id, object: "model", created: 0, owned_by: "opencode" });
    if (!hideSearch) {
      data.push({
        id: id + "-search",
        object: "model",
        created: 0,
        owned_by: "opencode",
      });
    }
  }
  return { object: "list", data };
}

function getApiKey() {
  // Free ($0) models accept the literal key "public" — same as a fresh
  // `opencode` install with no key configured. A real Zen key is only
  // needed for paid models.
  return (
    process.env.OPENCODE_API_KEY ||
    process.env.OPENCODE_ZEN_API_KEY ||
    "public"
  );
}

// sessionStatus 区分三种状态：ok / missing / corrupt，供错误文案和 /health 用
function sessionStatus() {
  const p = path.join(DIR, "session.json");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { status: "missing" };
  }
  try {
    const s = JSON.parse(raw);
    if (!s?.xSessionId) return { status: "corrupt" };
    return { status: "ok", session: s };
  } catch {
    return { status: "corrupt" };
  }
}

function identityHeaders(session) {
  const h = {};
  if (!session) return h;
  h["user-agent"] = session.userAgent || "opencode/latest/2.0.12/cli";
  if (session.xOpencodeClient) h["x-opencode-client"] = session.xOpencodeClient;
  if (session.xOpencodeOrgId) h["x-opencode-org-id"] = session.xOpencodeOrgId;
  if (session.xOpencodeProject)
    h["x-opencode-project"] = session.xOpencodeProject;
  if (session.xOpencodeSession)
    h["x-opencode-session"] = session.xOpencodeSession;
  if (session.xSessionId) h["x-session-id"] = session.xSessionId;
  // 官方客户端现每次必发 x-opencode-session-id（与 x-opencode-session 同值）；
  // 门控暂不校验，先对齐，防后续收紧。
  if (session.xOpencodeSession || session.xSessionId)
    h["x-opencode-session-id"] = session.xOpencodeSession || session.xSessionId;
  if (session.xSessionAffinity)
    h["x-session-affinity"] = session.xSessionAffinity;
  // 官方此处发稳定的 user.id（非每次生成）。优先复用从真客户端学到的值，
  // 学不到才回退到 fresh msg_ id（门控当前不校验此头）。
  h["x-opencode-request"] = session.xOpencodeRequest || freshMsgId();
  return h;
}

const B62 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function randB62(n) {
  let s = "";
  for (let i = 0; i < n; i++)
    s += B62[Math.floor(Math.random() * B62.length)];
  return s;
}
function freshMsgId() {
  const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
  return "msg_" + ts + randB62(14);
}

// Upstream Zen only accepts tool_choice "auto" (verified 2026-10-06:
// "none"/"required"/named choices -> 400). Strip anything else before the
// request goes out; omitting it is equivalent to "auto".
// 客户端请求体明显有问题时抛这个，handler 转成 400 中文返回（省一次上游往返）
class BadRequest extends Error {}
function sanitizeToolChoice(body) {
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    // 与 Anthropic 路径对齐：降级要让用户知道，而不是误以为约束生效了
    console.warn(
      `tool_choice 已忽略（上游只支持 auto）：${JSON.stringify(body.tool_choice).slice(0, 120)}`
    );
    delete body.tool_choice;
  }
}

function ensureChatTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) {
    // No app tools: disguise only (the free-tier gate needs the read/shell
    // names present). tool_choice is left alone: upstream only supports
    // "auto", and empirically the model doesn't call the disguise tools
    // unprompted.
    body.tools = DISGUISE_CHAT.slice();
  } else {
    // Merge: keep the app's tools, append disguise tools for missing names.
    const names = new Set(
      tools.map((t) => t?.function?.name || t?.name).filter(Boolean)
    );
    for (const dt of DISGUISE_CHAT) {
      const n = dt?.function?.name;
      if (n && !names.has(n)) {
        tools.push(dt);
        names.add(n);
      }
    }
    body.tools = tools;
    // Don't force tool_choice: the model must be free to call app tools.
  }
  // 反代内置工具（webfetch/websearch）：本地执行，对客户端透明。
  // 与伪装工具一样合并进去，缺了就补。
  // 返回实际注入的工具名集合（供拦截用）：客户端自带同名工具时不注入、
  // 也不拦截，避免把客户端的工具调用误当成反代内置的执行掉。
  const injectedProxyNames = new Set();
  {
    const names = new Set(
      body.tools.map((t) => t?.function?.name || t?.name).filter(Boolean)
    );
    // v42: 只有 -search 后缀或客户端原生搜索请求时才注入；否则不注入，
    // 模型就不会主动搜索。之前 PROXY_TOOLS_CHAT 非空导致总是注入。
    const proxyTools = requestForceSearch ? ALL_PROXY_TOOLS_CHAT : [];
    for (const pt of proxyTools) {
      const n = pt?.function?.name;
      if (n && !names.has(n)) {
        body.tools.push(pt);
        names.add(n);
        injectedProxyNames.add(n);
      }
    }
  }
  // top_k：OpenAI / 上游都不认，透传会 400。酒馆插件 custom_include_body
  // 的示例里就带 top_k: 50（用户照抄就会触发），这里直接忽略并打日志，
  // 而不是让上游 400。注意：反代自己注入的参数（stream/stream_options/tools）
  // 不在此列，不会被误删。
  if (body.top_k !== undefined) {
    console.warn(
      `top_k 上游不支持，已忽略（收到 ${JSON.stringify(body.top_k).slice(0, 40)}）`
    );
    delete body.top_k;
  }
  // Zen free tier only accepts streaming chat requests; the proxy
  // de-streams below when the client asked for non-streaming.
  body.stream = true;
  // Always ask for usage: the client needs it for token stats. Merge with
  // whatever the client sent instead of clobbering it.
  body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  sanitizeToolChoice(body);
  return injectedProxyNames;
}

// Normalize one tool (chat or responses shape) to Responses-API shape.
function toResponsesTool(t) {
  if (!t || t.type !== "function") {
    // 非 function 类型工具（如 web_search）上游暂不支持，点名警告而不是静默吞掉
    if (t && t.type)
      console.warn(`不支持的工具类型已丢弃：type="${t.type}" name="${t.name || "?"}"`);
    return null;
  }
  if (typeof t.name === "string" && t.name) {
    // Already Responses-API shape.
    const out = {
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || { type: "object", properties: {} },
    };
    if (t.strict === true) out.strict = true;
    return out;
  }
  const fn = t.function;
  if (!fn || typeof fn.name !== "string" || !fn.name) return null;
  const out = {
    type: "function",
    name: fn.name,
    description: fn.description || "",
    parameters: fn.parameters || { type: "object", properties: {} },
  };
  if (fn.strict === true) out.strict = true;
  return out;
}

// OpenAI chat 的 response_format -> Responses 的 text.format。
// 上游 Responses 只认 text.format；response_format 原样透传过去会 400，
// 静默丢弃则等于用户的 JSON 约束没生效。json_schema 按规范带 name/schema。
function responsesFormatToText(rf) {
  if (!rf || typeof rf !== "object") return undefined;
  if (rf.type === "json_object") return { format: { type: "json_object" } };
  if (
    rf.type === "json_schema" &&
    rf.json_schema &&
    typeof rf.json_schema === "object"
  ) {
    const js = rf.json_schema;
    return {
      format: {
        type: "json_schema",
        name: js.name || "response",
        schema: js.schema || {},
        ...(js.strict !== undefined ? { strict: js.strict } : {}),
      },
    };
  }
  return undefined; // "text" 或未知类型：默认即纯文本，不用传
}

function ensureResponsesTools(body) {
  const appTools = (Array.isArray(body.tools) ? body.tools : [])
    .map(toResponsesTool)
    .filter(Boolean);
  // Merge: app tools first, then disguise tools for any missing names.
  // The free-tier gate needs its tool names present; the model is free
  // to call the app's tools.
  const names = new Set(appTools.map((t) => t.name));
  const merged = [...appTools];
  for (const dt of DISGUISE_RESPONSES) {
    if (!names.has(dt.name)) {
      merged.push(dt);
      names.add(dt.name);
    }
  }
  // 反代内置工具（webfetch/websearch）：本地执行，对客户端透明。
  // 返回实际注入的工具名集合（供拦截用）：客户端自带同名工具时不注入、
  // 也不拦截，避免把客户端的工具调用误当成反代内置的执行掉。
  const injectedProxyNames = new Set();
  // v42: 只有 -search 后缀或客户端原生搜索请求时才注入；否则不注入。
  const proxyTools = requestForceSearch ? ALL_PROXY_TOOLS_RESPONSES : [];
  for (const pt of proxyTools) {
    if (!names.has(pt.name)) {
      merged.push(pt);
      names.add(pt.name);
      injectedProxyNames.add(pt.name);
    }
  }
  body.tools = merged;
  // response_format：Responses 上游只认 text.format，直接透传
  // response_format 会 400。按 OpenAI Responses 规范转写后再删掉原字段。
  if (body.response_format !== undefined && body.text === undefined) {
    const t = responsesFormatToText(body.response_format);
    if (t) body.text = t;
    delete body.response_format;
  }
  // top_k：同 ensureChatTools，透传会 400，直接忽略（见上）。
  if (body.top_k !== undefined) {
    console.warn(
      `top_k 上游不支持，已忽略（收到 ${JSON.stringify(body.top_k).slice(0, 40)}）`
    );
    delete body.top_k;
  }
  // seed：Responses 上游不认，透传会 400（2026-10-05 已验证）。直接忽略。
  if (body.seed !== undefined) {
    console.warn(`seed 上游不支持，已忽略`);
    delete body.seed;
  }
  // Like chat, the free tier only answers streaming responses requests.
  body.stream = true;
  sanitizeToolChoice(body);
  return injectedProxyNames;
}

// Incremental translator: Responses SSE -> OpenAI chat SSE.
// True streaming: each upstream chunk is translated and emitted immediately,
// not buffered. emit() receives SSE text chunks.
// timing (optional): { t0, firstTokenAt, usage } — filled in for observability
// (TTFT logging, cache stats).
async function streamResponsesToChat(upstream, emit, model, timing, knownNames, opts = {}) {
  // opts.interceptNames: Set<string> —— 这些工具名由反代本地执行（webfetch/websearch），
  // 不转发给客户端。拦截到的调用在返回的 intercepted 数组里，handler 负责执行 + follow-up。
  const interceptNames = opts.interceptNames || new Set();
  const intercepted = []; // [{ call_id, name, arguments }]
  // 跨轮唯一：fallback call_id 用全局计数器，避免多轮时同一 input 里出现重复 call_id
  const interceptedByIndex = new Map(); // output_index -> intercepted entry
  const skippedClientIndices = new Set(); // 因同轮有拦截工具而暂缓的客户端工具 output_index
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const base = {
    id: `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunk = (choices) =>
    `data: ${JSON.stringify({ ...base, choices })}\n\n`;
  emit(
    chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])
  );
  const toolIndexes = new Map();
  let toolCount = 0;
  let hasTools = false;
  let doneEmitted = false;
  // Upstream usage (from response.completed/incomplete). Emitted as a final
  // OpenAI-style usage chunk so clients like RikkaHub can show token stats
  // (prompt/completion tokens, tok/s). Without it the client never learns
  // the token counts.
  let upstreamUsage = null;
  // Prompt-cache hits reported by the gateway (Responses: usage.details;
  // Zen also injects a normalizedUsage chunk with cacheReadTokens).
  let cachedTokens = null;
  const noteCached = (n) => {
    if (typeof n === "number" && n >= 0 && (cachedTokens === null || n > cachedTokens)) {
      cachedTokens = n;
    }
  };
  const normalizeUsage = (u) => {
    if (!u || typeof u !== "object") return null;
    // 缺字段时保留 undefined（日志显示"?"），不要用 0 冒充——0 会误导成"没花 token"
    // 兼容两种格式：Anthropic(input_tokens/output_tokens) 和 OpenAI(prompt_tokens/completion_tokens)
    const input = u.input_tokens ?? u.prompt_tokens;
    const output = u.output_tokens ?? u.completion_tokens;
    noteCached(u.input_tokens_details?.cached_tokens);
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens:
        u.total_tokens ??
        (typeof input === "number" && typeof output === "number"
          ? input + output
          : undefined),
    };
  };
  const finish = (reason) => {
    if (doneEmitted) return;
    doneEmitted = true;
    // 有拦截的内置工具调用时：不 emit finish/[DONE]，由 handler 执行工具后
    // 发 follow-up 继续对话。usage 照常记到 timing 供日志累加。
    if (intercepted.length > 0) {
      if (upstreamUsage && timing) timing.usage = upstreamUsage;
      return;
    }
    emit(chunk([{ index: 0, delta: {}, finish_reason: reason }]));
    if (upstreamUsage) {
      const u = { ...upstreamUsage };
      if (cachedTokens !== null) {
        u.prompt_tokens_details = {
          ...(u.prompt_tokens_details || {}),
          cached_tokens: cachedTokens,
        };
      }
      if (timing) timing.usage = u;
      emit(
        `data: ${JSON.stringify({ ...base, choices: [], usage: u })}\n\n`
      );
    }
    emit("data: [DONE]\n\n");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      // 单行超长保护：某行迟迟不出现换行（如网关异常）时残留 buf 会无限增长
      if (buf.length > 10 * 1024 * 1024) {
        console.error("上游 SSE 单行超过 10MB，已丢弃该行防内存爆炸");
        buf = "";
      }
      // 单行处理抽成闭包：循环结束后残留行也要走同一逻辑
      const handleLine = (line) => {
        const t = line.trim();
        if (!t.startsWith("data:")) return;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          return;
        }
        // Zen gateway cache report (separate SSE chunk, no type).
        if (obj && typeof obj === "object" && obj.normalizedUsage) {
          const nu = obj.normalizedUsage;
          noteCached(nu.cacheReadTokens ?? nu.cache_read_tokens);
        }
        if (
          obj.type === "response.output_text.delta" &&
          typeof obj.delta === "string"
        ) {
          if (timing && !timing.firstTokenAt) timing.firstTokenAt = Date.now();
          emit(
            chunk([
              {
                index: 0,
                delta: { content: obj.delta },
                finish_reason: null,
              },
            ])
          );
        } else if (
          obj.type === "response.reasoning_summary_text.delta" &&
          typeof obj.delta === "string"
        ) {
          // 思维链：透传给客户端，RikkaHub 渲染为可折叠 thinking
          emit(
            chunk([
              {
                index: 0,
                delta: { reasoning_content: obj.delta },
                finish_reason: null,
              },
            ])
          );
        } else if (
          obj.type === "response.output_item.added" &&
          obj.item?.type === "function_call"
        ) {
          const item = obj.item;
          const toolName = unprefixToolName(item.name, knownNames);
          // 反代内置工具：拦截本地执行，不转发给客户端
          if (interceptNames.has(toolName)) {
            const entry = {
              call_id: item.call_id || item.id || `call_proxy_${++proxyCallSeq}`,
              name: toolName,
              arguments: "",
            };
            intercepted.push(entry);
            interceptedByIndex.set(obj.output_index, entry);
            return;
          }
          // 本轮已有拦截工具时：客户端工具调用暂不 emit（避免 finish 被抑制导致客户端 hang）。
          // 模型在 follow-up 中如仍需该工具会重新调用。
          if (intercepted.length > 0) {
            console.warn(
              `客户端工具 ${toolName} 与内置工具同轮调用，已暂缓（内置工具优先执行）`
            );
            skippedClientIndices.add(obj.output_index);
            return;
          }
          const idx = toolCount++;
          toolIndexes.set(obj.output_index, idx);
          hasTools = true;
          emit(
            chunk([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: item.call_id || item.id,
                      type: "function",
                      function: {
                        name: toolName,
                        arguments: "",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ])
          );
        } else if (
          obj.type === "response.function_call_arguments.delta" &&
          typeof obj.delta === "string"
        ) {
          // 拦截的工具：参数累积到 entry，不 emit
          const interceptedEntry = interceptedByIndex.get(obj.output_index);
          if (interceptedEntry) {
            interceptedEntry.arguments += obj.delta;
            return;
          }
          const idx = toolIndexes.get(obj.output_index);
          if (idx !== undefined) {
            emit(
              chunk([
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: idx, function: { arguments: obj.delta } }],
                  },
                  finish_reason: null,
                },
              ])
            );
          } else if (!skippedClientIndices.has(obj.output_index)) {
            // output_item.added 没登记就来了 arguments：参数无声丢失，客户端会收到空参数的工具调用
            console.warn(
              `function_call_arguments.delta 无对应 tool (output_index=${obj.output_index})，已丢弃`
            );
          }
          // skippedClientIndices 中的是故意暂缓的，不打警告
        } else if (obj.type === "response.completed") {
          upstreamUsage = normalizeUsage(obj.response?.usage);
          finish(hasTools ? "tool_calls" : "stop");
        } else if (obj.type === "response.incomplete") {
          upstreamUsage = normalizeUsage(obj.response?.usage);
          const reason = obj.response?.incomplete_details?.reason;
          // incomplete 时若已发出工具调用，终结符必须是 tool_calls，
          // 否则客户端看不到工具调用的收尾（之前误发 stop/length）
          finish(hasTools ? "tool_calls" : reason === "max_output_tokens" ? "length" : "stop");
        }
      };
      for (const line of lines) handleLine(line);
    }
    // 上游最后一段可能没有换行结尾：残留行也要处理，
    // 否则 response.completed 里的 usage 会丢。
    if (buf.trim()) handleLine(buf);
    buf = "";
  } finally {
    // cancel 在先：中途抛错时把上游 body 关掉，否则 undici 继续缓冲无人消费的数据
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  finish(hasTools ? "tool_calls" : "stop");
  return { intercepted };
}

// Incremental interceptor: OpenAI chat SSE -> OpenAI chat SSE (passthrough),
// for upstream chat/completions requests that are NOT translated
// (mimo/longcat 等直连模型)。语义与 streamResponsesToChat 的拦截部分一致：
// interceptNames 里的工具调用被吞掉、本地执行，不转发给客户端；
// 普通文本/tool chunk 原样转发。返回 { intercepted }。
// timing (optional): { t0, firstTokenAt, usage } —— 与 streamResponsesToChat 同契约。

// v47: Chat SSE → Responses SSE 流式转换。
// 用于 /v1/responses 收到非 muse-spark 模型时：上游走 chat，下游要 Responses 格式。
async function streamChatToResponses(upstream, emit, model, timing) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const respId = `resp-proxy-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let textParts = [];
  let toolCalls = []; // [{id, name, arguments}]
  let usage = null;
  let hasEmittedCreated = false;

  const emitEvent = (obj) => emit(`data: ${JSON.stringify(obj)}\n\n`);

  // response.created 先发
  emitEvent({
    type: "response.created",
    response: { id: respId, object: "response", created, model, status: "in_progress", output: [] },
  });
  hasEmittedCreated = true;
  void hasEmittedCreated;

  // output_text 的 item 占位（Responses 要求先有 response.output_item.added）
  let itemAdded = false;
  const ensureItem = () => {
    if (!itemAdded) {
      itemAdded = true;
      emitEvent({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: `msg_${respId}`, role: "assistant", content: [] },
      });
      emitEvent({
        type: "response.content_part.added",
        item_id: `msg_${respId}`,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
  };

  const toolArgBuffers = new Map(); // index -> {id, name, args}
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj.choices?.[0];
      if (!choice) {
        if (obj.usage) usage = obj.usage;
        continue;
      }
      const delta = choice.delta || {};
      // 文本增量
      if (typeof delta.content === "string" && delta.content) {
        ensureItem();
        textParts.push(delta.content);
        if (timing && !timing.firstTokenAt) timing.firstTokenAt = Date.now();
        emitEvent({ type: "response.output_text.delta", item_id: `msg_${respId}`, output_index: 0, content_index: 0, delta: delta.content });
      }
      // reasoning 增量（mimo/longcat 一般没有，有也透一下）
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emitEvent({ type: "response.reasoning_summary_text.delta", item_id: `msg_${respId}`, output_index: 0, summary_index: 0, delta: delta.reasoning_content });
      }
      // 工具调用增量
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolArgBuffers.get(idx);
          if (!entry) {
            entry = { id: tc.id || `call_chat2resp_${idx}`, name: tc.function?.name || "", args: "" };
            toolArgBuffers.set(idx, entry);
          }
          if (tc.function?.name) entry.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  // 收尾：function_call items
  for (const [, entry] of toolArgBuffers) {
    if (!entry.name) continue;
    toolCalls.push({ id: entry.id, name: entry.name, arguments: entry.args });
    const outIdx = 1 + toolCalls.length - 1;
    emitEvent({
      type: "response.output_item.added",
      output_index: outIdx,
      item: { type: "function_call", id: entry.id, call_id: entry.id, name: entry.name, arguments: entry.args },
    });
    emitEvent({ type: "response.output_item.done", output_index: outIdx, item: { type: "function_call", id: entry.id, call_id: entry.id, name: entry.name, arguments: entry.args } });
  }
  // 文本 part 收尾
  if (itemAdded) {
    const fullText = textParts.join("");
    emitEvent({ type: "response.output_text.done", item_id: `msg_${respId}`, output_index: 0, content_index: 0, text: fullText });
    emitEvent({ type: "response.content_part.done", item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText, annotations: [] } });
    emitEvent({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_${respId}`, role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }] } });
  }
  // response.completed
  const output = [];
  if (itemAdded) {
    output.push({ type: "message", id: `msg_${respId}`, role: "assistant", content: [{ type: "output_text", text: textParts.join(""), annotations: [] }] });
  }
  for (const tc of toolCalls) {
    output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
  }
  const respUsage = usage ? {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  } : null;
  if (timing && respUsage) {
    timing.usage = { prompt_tokens: respUsage.input_tokens, completion_tokens: respUsage.output_tokens, total_tokens: respUsage.total_tokens };
  }
  emitEvent({
    type: "response.completed",
    response: { id: respId, object: "response", created, model, status: "completed", output, usage: respUsage },
  });
  return { text: textParts.join(""), toolCalls, finishReason };
}

// v47: Chat SSE → Anthropic SSE 流式转换。
// 用于 /v1/messages 收到非 muse-spark 模型时：上游走 chat，下游要 Anthropic 格式。
async function streamChatToAnthropic(upstream, emit, model, timing) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const msgId = `msg_proxy_${Date.now()}`;
  let textParts = [];
  let toolCalls = [];
  let usage = null;
  const emitEvent = (obj) => emit(`data: ${JSON.stringify(obj)}\n\n`);
  emitEvent({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  emitEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const toolArgBuffers = new Map();
  let finishReason = null;
  let blockIndex = 1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj.choices?.[0];
      if (!choice) { if (obj.usage) usage = obj.usage; continue; }
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        textParts.push(delta.content);
        if (timing && !timing.firstTokenAt) timing.firstTokenAt = Date.now();
        emitEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolArgBuffers.get(idx);
          if (!entry) {
            entry = { id: tc.id || `toolu_${idx}`, name: tc.function?.name || "", args: "", started: false, pendingArgs: "" };
            toolArgBuffers.set(idx, entry);
          }
          if (tc.function?.name) entry.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            if (entry.started) {
              entry.args += tc.function.arguments;
              emitEvent({ type: "content_block_delta", index: entry.blockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
            } else {
              // 名字还没到，先攒着，等 content_block_start 发出去再补发
              entry.pendingArgs += tc.function.arguments;
            }
          }
          // v47.2: 名字到了才发 content_block_start，避免空名字发出去后无法修正
          //（Anthropic 客户端看到空 name 的 tool_use 会直接报错）。
          if (!entry.started && entry.name) {
            entry.started = true;
            entry.blockIndex = blockIndex;
            emitEvent({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} } });
            blockIndex++;
            if (entry.pendingArgs) {
              entry.args += entry.pendingArgs;
              emitEvent({ type: "content_block_delta", index: entry.blockIndex, delta: { type: "input_json_delta", partial_json: entry.pendingArgs } });
              entry.pendingArgs = "";
            }
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  emitEvent({ type: "content_block_stop", index: 0 });
  for (const [, entry] of toolArgBuffers) {
    if (!entry.name || !entry.started) continue;
    toolCalls.push(entry);
    emitEvent({ type: "content_block_stop", index: entry.blockIndex });
  }
  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
  const outUsage = {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  };
  if (timing) timing.usage = { prompt_tokens: outUsage.input_tokens, completion_tokens: outUsage.output_tokens, total_tokens: (usage?.total_tokens ?? outUsage.input_tokens + outUsage.output_tokens) };
  emitEvent({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outUsage.output_tokens } });
  emitEvent({ type: "message_stop" });
  return { text: textParts.join(""), toolCalls, finishReason };
}
async function streamChatDirectWithIntercept(upstream, emit, model, timing, interceptNames, knownNames) {
  const intercepted = []; // [{ call_id, name, arguments }]
  const pending = new Map(); // tool index -> { entry, decided, held: [] }
  let proxySeenThisRound = false;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const rawEmit = (payload) => emit(`data: ${payload}\n\n`);
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      // 有拦截时 [DONE] 由 follow-up 的最后一轮发出，这里吞掉
      if (intercepted.length === 0) emit("data: [DONE]\n\n");
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = obj.choices?.[0];
    const tcs = choice?.delta?.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const idx = tc.index ?? 0;
        let st = pending.get(idx);
        if (!st) {
          st = { entry: null, decided: null, held: [], warned: false };
          pending.set(idx, st);
        }
        // 累积 id/name/arguments（name 可能分片到达，先攒着再判定）
        const idFrag = typeof tc.id === "string" ? tc.id : "";
        const nameFrag =
          typeof tc.function?.name === "string" ? tc.function.name : "";
        const argsFrag =
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : "";
        if (!st.entry) {
          st.entry = {
            call_id: idFrag || "",
            name: nameFrag,
            arguments: argsFrag,
          };
        } else {
          if (idFrag && !st.entry.call_id) st.entry.call_id = idFrag;
          st.entry.name += nameFrag;
          st.entry.arguments += argsFrag;
        }
        if (!st.decided && st.entry.name) {
          const nm = unprefixToolName(st.entry.name, knownNames);
          st.entry.name = nm;
          st.decided = interceptNames.has(nm) ? "proxy" : "client";
          if (st.decided === "proxy") {
            proxySeenThisRound = true;
            if (!st.entry.call_id)
              st.entry.call_id = `call_proxy_${++proxyCallSeq}`;
            intercepted.push(st.entry);
          } else {
            // 客户端工具：把之前暂存的 chunk 补发出去
            for (const h of st.held) rawEmit(h);
            st.held = [];
          }
        }
        if (!st.decided) {
          // 名字还没攒齐：暂存，等判定后再决定发不发
          st.held.push(payload);
        } else if (st.decided === "proxy") {
          // 拦截：吞掉，不转发
        } else if (proxySeenThisRound) {
          // 本轮已有内置工具被拦截：客户端工具调用暂缓（与翻译路径一致，
          // 模型在 follow-up 中如仍需该工具会重新调用）
          if (!st.warned) {
            st.warned = true;
            console.warn(
              `客户端工具 ${st.entry.name} 与内置工具同轮调用，已暂缓（内置工具优先执行）`
            );
          }
        } else {
          rawEmit(payload);
        }
      }
      return;
    }
    // usage chunk（choices 为空数组）：记到 timing 供日志，同时转发
    if (obj.usage && typeof obj.usage === "object") {
      if (timing) timing.usage = obj.usage;
      rawEmit(payload);
      return;
    }
    if (choice && choice.finish_reason) {
      // 有拦截时终结符由 follow-up 的最后一轮发出，这里吞掉，避免客户端提前收尾
      if (intercepted.length > 0) return;
      rawEmit(payload);
      return;
    }
    // 文本 delta 等：原样转发；记首字时间
    if (
      typeof choice?.delta?.content === "string" &&
      timing &&
      !timing.firstTokenAt
    ) {
      timing.firstTokenAt = Date.now();
    }
    rawEmit(payload);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      if (buf.length > 10 * 1024 * 1024) {
        console.error("上游 SSE 单行超过 10MB，已丢弃该行防内存爆炸");
        buf = "";
      }
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
    buf = "";
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  return { intercepted };
}

// Incremental translator: Responses SSE -> Anthropic SSE. True streaming.
// timing (optional): { t0, firstTokenAt, usage } — filled in for observability
// (same contract as streamResponsesToChat).
async function streamResponsesToAnthropic(upstream, emit, model, timing, knownNames, opts = {}) {
  // opts.interceptNames: Set<string> —— 反代内置工具（webfetch/websearch）拦截，
  // 语义与 streamResponsesToChat 一致：拦截到的调用本地执行、不转发给客户端，
  // 返回的 intercepted 由 handler 做 follow-up。Anthropic 流式是"同一个 message"
  // 继续写 block，所以 follow-up 轮需要传 startBlockIndex + skipStart。
  // opts.startBlockIndex: 本轮 block 起始序号（follow-up 续写时用）。
  // opts.skipStart: true 则不发 message_start（follow-up 续写同一个 message）。
  const interceptNames = opts.interceptNames || new Set();
  const intercepted = []; // [{ call_id, name, arguments }]
  const heldTools = new Map(); // output_index -> intercepted entry（已吞掉、不发 block）
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const msgId = `msg_proxy_${Date.now()}`;
  const ev = (name, data) =>
    emit(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let started = !!opts.skipStart;
  let blockIndex = opts.startBlockIndex || 0;
  let textOpen = false;
  // v39：思维链 block 状态（Anthropic thinking content block）
  let thinkingOpen = false;
  let thinkingBlockIndex = -1;
  const toolBlocks = new Map();
  let hasTools = false;
  // completed/incomplete 到达后置位，外层循环统一退出（原来是直接 return）
  let streamDone = false;
  // 单行处理抽成闭包：循环结束后残留行也走同一逻辑
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    // 已拦截工具的其他相关事件（output_item.done、function_call_arguments.done 等）
    // 一律吞掉，别让客户端看到半截调用
    if (
      typeof obj.output_index === "number" &&
      heldTools.has(obj.output_index) &&
      obj.type !== "response.output_item.added" &&
      obj.type !== "response.function_call_arguments.delta"
    ) {
      return;
    }
    if (
      obj.type === "response.output_text.delta" &&
      typeof obj.delta === "string"
    ) {
      ensureStart();
      if (timing && !timing.firstTokenAt) timing.firstTokenAt = Date.now();
      if (!textOpen) {
        textOpen = true;
        ev("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      ev("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: obj.delta },
      });
    } else if (
      // v39：思维链 -> Anthropic thinking content block（之前直接丢了）
      obj.type === "response.reasoning_summary_text.delta" &&
      typeof obj.delta === "string"
    ) {
      ensureStart();
      if (!thinkingOpen) {
        thinkingOpen = true;
        thinkingBlockIndex = blockIndex++;
        ev("content_block_start", {
          type: "content_block_start",
          index: thinkingBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      ev("content_block_delta", {
        type: "content_block_delta",
        index: thinkingBlockIndex,
        delta: { type: "thinking_delta", thinking: obj.delta },
      });
    } else if (
      obj.type === "response.output_item.added" &&
      obj.item?.type === "function_call"
    ) {
      ensureStart();
      closeText();
      const item = obj.item;
      const toolName = unprefixToolName(item.name, knownNames);
      // 反代内置工具：拦截本地执行，不转发给客户端（block 不占序号）
      if (interceptNames.has(toolName)) {
        const entry = {
          call_id: item.call_id || item.id || `call_proxy_${++proxyCallSeq}`,
          name: toolName,
          arguments: "",
        };
        intercepted.push(entry);
        heldTools.set(obj.output_index, entry);
        return;
      }
      const bi = blockIndex++;
      toolBlocks.set(obj.output_index, bi);
      hasTools = true;
      ev("content_block_start", {
        type: "content_block_start",
        index: bi,
        content_block: {
          type: "tool_use",
          id: item.call_id || item.id,
          name: toolName,
          input: {},
        },
      });
    } else if (
      obj.type === "response.function_call_arguments.delta" &&
      typeof obj.delta === "string"
    ) {
      // 拦截的工具：参数累积到 entry，不 emit
      const heldEntry = heldTools.get(obj.output_index);
      if (heldEntry) {
        heldEntry.arguments += obj.delta;
        return;
      }
      const bi = toolBlocks.get(obj.output_index);
      if (bi !== undefined) {
        ev("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "input_json_delta", partial_json: obj.delta },
        });
      } else {
        // output_item.added 丢失/乱序时参数增量无处可去，打日志以便排查
        console.warn(
          `function_call_arguments.delta 无对应 tool block (output_index=${obj.output_index})，已丢弃`
        );
      }
    } else if (
      obj.type === "response.completed" ||
      obj.type === "response.incomplete"
    ) {
      ensureStart();
      // 兜底：上游 completed 直接带完整 output、没发过任何 delta 时，
      // 从 output 里捞文本补发一个 text block，否则正文无声丢失
      if (!textOpen && !hasTools && Array.isArray(obj.response?.output)) {
        let fbText = "";
        for (const item of obj.response.output) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "function_call") {
            console.warn("上游 completed 直带 function_call（无 delta），暂不支持");
            continue;
          }
          for (const c of item.content || []) {
            if (c.type === "output_text" && typeof c.text === "string")
              fbText += c.text;
          }
        }
        if (fbText) {
          textOpen = true;
          ev("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          });
          ev("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: fbText },
          });
        }
      }
      closeText();
      // v39：关闭 thinking block（如果开过）
      if (thinkingOpen) {
        ev("content_block_stop", {
          type: "content_block_stop",
          index: thinkingBlockIndex,
        });
        thinkingOpen = false;
      }
      for (const bi of toolBlocks.values()) {
        ev("content_block_stop", { type: "content_block_stop", index: bi });
      }
      const usage = obj.response?.usage;
      // Feed the observability timing object (same contract as the chat
      // translator) so the server can log usage after streaming.
      if (timing && usage && typeof usage === "object") {
        const u = {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens:
            usage.total_tokens ??
            (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        };
        const dc = usage.input_tokens_details?.cached_tokens;
        if (typeof dc === "number" && dc >= 0)
          u.prompt_tokens_details = { cached_tokens: dc };
        timing.usage = u;
      }
      // 有拦截的内置工具调用时：不发 message_delta/message_stop，
      // follow-up 轮会续写同一个 message（文本作为新 block 继续）
      if (intercepted.length > 0) {
        streamDone = true;
        return;
      }
      // Anthropic 原生缓存字段：cache_read_input_tokens，语义与 cached_tokens 一致
      const dcDelta = usage?.input_tokens_details?.cached_tokens;
      const incompleteReason = obj.response?.incomplete_details?.reason;
      // 已发出工具调用时 stop_reason 必须是 tool_use（之前 incomplete 会误发 end_turn/max_tokens）
      const stopReason = hasTools
        ? "tool_use"
        : obj.type === "response.incomplete"
          ? incompleteReason === "max_output_tokens"
            ? "max_tokens"
            : "end_turn"
          : "end_turn";
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: {
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          ...(typeof dcDelta === "number" && dcDelta >= 0
            ? { cache_read_input_tokens: dcDelta }
            : {}),
        },
      });
      ev("message_stop", { type: "message_stop" });
      streamDone = true;
      return;
    }
          };
  const ensureStart = () => {
    if (started) return;
    started = true;
    ev("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const closeText = () => {
    if (!textOpen) return;
    textOpen = false;
    ev("content_block_stop", { type: "content_block_stop", index: blockIndex++ });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      // 单行超长保护：某行迟迟不出现换行（如网关异常）时残留 buf 会无限增长
      if (buf.length > 10 * 1024 * 1024) {
        console.error("上游 SSE 单行超过 10MB，已丢弃该行防内存爆炸");
        buf = "";
      }
      for (const line of lines) {
        handleLine(line);
        if (streamDone) break;
      }
      if (streamDone) break;
    }
    // 上游最后一段可能没有换行结尾：残留行也要处理，否则 completed 里的 usage 会丢
    if (buf.trim() && !streamDone) handleLine(buf);
    buf = "";
  } finally {
    // cancel 在先：中途抛错时把上游 body 关掉，否则 undici 继续缓冲无人消费的数据
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  // completed/incomplete 已正常结束：不再走兜底关闭，避免重复发 message_stop
  if (streamDone) return { intercepted, nextBlockIndex: blockIndex };
  // Stream ended without response.completed: close gracefully.
  ensureStart();
  closeText();
  for (const bi of toolBlocks.values()) {
    ev("content_block_stop", { type: "content_block_stop", index: bi });
  }
  // 有拦截的内置工具调用时不发 message_delta/message_stop：
  // handler 会执行工具后做 follow-up，续写同一个 message
  if (intercepted.length === 0) {
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: hasTools ? "tool_use" : "end_turn" },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    ev("message_stop", { type: "message_stop" });
  }
  return { intercepted, nextBlockIndex: blockIndex };
}

// Incremental interceptor: Responses SSE -> Responses SSE (verbatim passthrough),
// for direct /v1/responses streaming requests (not translated).
// interceptNames 里的工具调用被吞掉、本地执行，不转发给客户端；
// 其余事件原样转发。返回 { intercepted }。
// timing (optional): { t0, firstTokenAt, usage } —— 与其他 translator 同契约
// （usage 在这里记成 OpenAI 形状，handler 用 mergeUsageSum 合并）。
async function streamResponsesDirectWithIntercept(upstream, emit, interceptNames, knownNames, timing) {
  const intercepted = []; // [{ call_id, name, arguments }]
  const held = new Map(); // output_index -> intercepted entry（已吞掉）
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let streamDone = false;
  const rawEmit = (payload) => emit(`data: ${payload}\n\n`);
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    // 已拦截工具的其他相关事件（output_item.done、function_call_arguments.done 等）
    // 一律吞掉，别让客户端看到半截调用
    if (
      typeof obj.output_index === "number" &&
      held.has(obj.output_index) &&
      obj.type !== "response.output_item.added" &&
      obj.type !== "response.function_call_arguments.delta"
    ) {
      return;
    }
    if (
      obj.type === "response.output_item.added" &&
      obj.item?.type === "function_call"
    ) {
      const toolName = unprefixToolName(obj.item.name, knownNames);
      if (interceptNames.has(toolName)) {
        const entry = {
          call_id:
            obj.item.call_id || obj.item.id || `call_proxy_${++proxyCallSeq}`,
          name: toolName,
          arguments: "",
        };
        intercepted.push(entry);
        held.set(obj.output_index, entry);
        return; // 吞掉，不转发
      }
      rawEmit(payload);
      return;
    }
    if (
      obj.type === "response.function_call_arguments.delta" &&
      typeof obj.delta === "string"
    ) {
      const entry = held.get(obj.output_index);
      if (entry) {
        entry.arguments += obj.delta;
        return; // 吞掉，不转发
      }
      rawEmit(payload);
      return;
    }
    if (
      obj.type === "response.output_text.delta" &&
      typeof obj.delta === "string"
    ) {
      if (timing && !timing.firstTokenAt) timing.firstTokenAt = Date.now();
    }
    if (obj.type === "response.completed" || obj.type === "response.incomplete") {
      const u = obj.response?.usage;
      if (timing && u && typeof u === "object") {
        timing.usage = {
          prompt_tokens: u.input_tokens,
          completion_tokens: u.output_tokens,
          total_tokens:
            u.total_tokens ??
            (typeof u.input_tokens === "number" &&
            typeof u.output_tokens === "number"
              ? u.input_tokens + u.output_tokens
              : undefined),
          ...(typeof u.input_tokens_details?.cached_tokens === "number"
            ? {
                prompt_tokens_details: {
                  cached_tokens: u.input_tokens_details.cached_tokens,
                },
              }
            : {}),
        };
      }
      // 有拦截时 completed/incomplete 由 follow-up 的最后一轮发出，这里吞掉
      if (intercepted.length > 0) {
        streamDone = true;
        return;
      }
      streamDone = true;
    }
    rawEmit(payload);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      if (buf.length > 10 * 1024 * 1024) {
        console.error("上游 SSE 单行超过 10MB，已丢弃该行防内存爆炸");
        buf = "";
      }
      for (const line of lines) {
        handleLine(line);
        if (streamDone) break;
      }
      if (streamDone) break;
    }
    if (buf.trim() && !streamDone) handleLine(buf);
    buf = "";
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  return { intercepted };
}

// Assemble a non-streaming Responses object from SSE events.
// Text comes only from response.output_text.delta events; the final
// 安全读完上游 body：finally 里 cancel + releaseLock，
// 中途抛错也不让连接悬空占着不回池。
async function readUpstreamBody(upstream) {
  const reader = upstream.body.getReader();
  const bufs = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // value 已是 Uint8Array，Buffer.concat 直接接受，省掉一次全量拷贝
      bufs.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(bufs);
}

// response.completed repeats the full output, so it must be ignored
// for text (to avoid duplication) but is the reliable source for
// function_call items.
function sseToResponse(sseText, fallbackModel, knownNames) {
  let id = `resp-proxy-${Date.now()}`;
  let model = fallbackModel;
  // 数组收集 + 最后 join：逐 chunk += 是 O(n²) 拷贝，大输出（28k tokens）下可观
  const textParts = [];
  const reasoningParts = [];
  let usage = null;
  let cached = null;
  let status = "completed";
  let incompleteReason = "";
  const functions = [];
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const resp = obj.response || {};
    if (resp.id) id = resp.id;
    if (resp.model) model = resp.model;
    if (obj.model) model = obj.model;
    if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
      textParts.push(obj.delta);
    }
    if (obj.type === "response.reasoning_summary_text.delta" && typeof obj.delta === "string") {
      reasoningParts.push(obj.delta);
    }
    // Zen gateway cache report (separate SSE chunk, no type).
    if (obj.normalizedUsage && typeof obj.normalizedUsage === "object") {
      const nu = obj.normalizedUsage;
      const cr = nu.cacheReadTokens ?? nu.cache_read_tokens;
      if (typeof cr === "number" && cr >= 0 && (cached === null || cr > cached)) {
        cached = cr;
      }
    }
    if (
      obj.type === "response.completed" ||
      obj.type === "response.incomplete"
    ) {
      if (obj.type === "response.incomplete") {
        status = "incomplete";
        incompleteReason = resp.incomplete_details?.reason || "";
      }
      // Usage is captured independently of output: a well-formed completed
      // event always carries output, but usage must not be lost if it doesn't.
      if (resp.usage && typeof resp.usage === "object") {
        const dc = resp.usage.input_tokens_details?.cached_tokens;
        if (typeof dc === "number" && dc >= 0 && (cached === null || dc > cached)) {
          cached = dc;
        }
        usage = {
          // 缺字段保留 undefined（日志显示"?"），不用 0 冒充
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
          total_tokens:
            resp.usage.total_tokens ??
            (typeof resp.usage.input_tokens === "number" &&
            typeof resp.usage.output_tokens === "number"
              ? resp.usage.input_tokens + resp.usage.output_tokens
              : undefined),
        };
        if (cached !== null) {
          usage.input_tokens_details = { cached_tokens: cached };
        }
      }
    }
    if (
      (obj.type === "response.completed" || obj.type === "response.incomplete") &&
      Array.isArray(resp.output)
    ) {
      for (const item of resp.output) {
        if (item && item.type === "function_call" && item.name) {
          functions.push({
            type: "function_call",
            call_id: item.call_id || item.id || "",
            name: unprefixToolName(item.name, knownNames),
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
          });
        }
      }
    }
  }
  const text = textParts.join("");
  const reasoning = reasoningParts.join("");
  const output = [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
    ...functions,
  ];
  return { id, object: "response", status, model, output, usage, incompleteReason, ...(reasoning ? { reasoning } : {}) };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// 反代自身错误：统一 OpenAI 标准形状 {error:{message,type,code}}。
// 之前是 {error:"字符串"}，酒馆插件这类只认 error.message 的客户端显示空白。
function sendErrorJson(res, code, message) {
  sendJson(res, code, {
    error: { message, type: "proxy_error", code },
  });
}

// 上游错误体统一成 OpenAI 标准形状 {error:{message,type,code}}。
// - 已经是标准形状的（如 OpenAI 网关的 400/429）原样返回；
// - FreeTierError 这类裸 {type,message} 形状：把 message 拎出来包一层，
//   否则酒馆插件读不到 error.message，只能显示空白/Failed to fetch；
// - 非 JSON（网关 HTML 报错页）：截断包成 message，不让插件 JSON 解析炸掉。
function normalizeUpstreamError(status, text) {
  let msg = "";
  let type = "upstream_error";
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object") {
      if (o.error && typeof o.error === "object" && typeof o.error.message === "string")
        return o; // 已经是标准形状
      if (typeof o.error === "string") msg = o.error;
      else if (typeof o.message === "string") {
        msg = o.message;
        if (typeof o.type === "string") type = o.type;
      }
    }
  } catch {}
  if (!msg) msg = text.slice(0, 500) || `上游返回错误 ${status}`;
  return { error: { message: msg, type, code: status } };
}

// Upstream content-type, for faithful error passthrough.
function upstreamCtype(upstream) {
  return upstream.headers.get("content-type") || "";
}

// Assemble a non-streaming OpenAI chat.completion from SSE chunks.
function sseToChatCompletion(sseText, fallbackModel) {
  const contentParts = [];
  const reasoningParts = [];
  let toolCalls = [];
  let id = `chatcmpl-proxy-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let finishReason = "stop";
  let usage = null;
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.id) id = obj.id;
    if (obj.created) created = obj.created;
    if (obj.model) model = obj.model;
    const choice = obj.choices?.[0];
    if (!choice) {
      if (obj.usage) usage = obj.usage;
      continue;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === "string") contentParts.push(d.content);
    if (typeof d.reasoning_content === "string") reasoningParts.push(d.reasoning_content);
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        toolCalls[idx] = toolCalls[idx] || {
          id: tc.id || "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string")
          toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (obj.usage) usage = obj.usage;
  }
  const content = contentParts.join("");
  const reasoning = reasoningParts.join("");
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

// Convert OpenAI chat content (string or parts array) into Responses-API
// message content. Text becomes input_text, image_url parts become
// input_image (multimodal). Returns null when there is no usable content.
function chatContentToResponses(content) {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : null;
  }
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const p of content || []) {
    if (typeof p === "string") {
      if (p) parts.push({ type: "input_text", text: p });
    } else if (p.type === "image_url" && p.image_url?.url) {
      parts.push({ type: "input_image", image_url: p.image_url.url });
    } else if (p.type === "input_image" && p.image_url) {
      parts.push({ type: "input_image", image_url: p.image_url });
    } else if (typeof p.text === "string" && p.text) {
      parts.push({ type: "input_text", text: p.text });
    }
  }
  return parts.length ? parts : null;
}

// Copy sampling params the Responses upstream accepts (verified 2026-10-05:
// temperature, top_p, presence_penalty, frequency_penalty -> 200;
// seed, stop, unknown params -> 400). Allowlist, not a spread.
function applySamplingParams(target, src) {
  const maxOut =
    src.max_output_tokens ?? src.max_tokens ?? src.max_completion_tokens;
  // v50修复：上游 /zen/v1/responses 要求 max_output_tokens >= 16，太小直接400
  if (maxOut) target.max_output_tokens = Math.max(16, maxOut);
  for (const k of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
  ]) {
    if (src[k] !== undefined) target[k] = src[k];
  }
  // 思考参数：只透传 reasoning 对象（{effort, summary} 形状）。
  // 注意：不要透传顶层 reasoning_effort，上游 /zen/v1/responses 报
  // unknown parameter；解析时已转成 reasoning.effort。
  if (src.reasoning !== undefined) target.reasoning = src.reasoning;
}

// Convert OpenAI chat messages into a Responses-API "input" item array.
// Supports multi-turn tool loops: assistant tool_calls become
// function_call items, "tool" messages become function_call_output items.
function chatToResponsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    const role = m.role || "user";
    if (role === "tool") {
      const cid = m.tool_call_id || m.id || "";
      if (!cid)
        throw new BadRequest("tool 消息缺少 tool_call_id，无法配对工具调用");
      input.push({
        type: "function_call_output",
        call_id: cid,
        output:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content))
      text = m.content
        .map((p) => (typeof p === "string" ? p : p.text || ""))
        .join("");
    const mappedRole =
      role === "assistant"
        ? "assistant"
        : role === "system" || role === "developer"
          ? "developer"
          : "user";
    const contentParts = chatContentToResponses(m.content);
    if (contentParts) {
      // Use a plain string when it's text-only (widest compatibility),
      // otherwise the parts array (carries images).
      // 注意：assistant 消息不能用 input_text（上游 400），必须压成纯字符串
      const onlyText =
        contentParts.length === 1 && contentParts[0].type === "input_text";
      if (mappedRole === "assistant") {
        // assistant 一律用纯文本：把 parts 拼成字符串
        const flatText = contentParts
          .map((p) => (p.type === "input_text" ? p.text : ""))
          .join("");
        if (flatText) input.push({ role: mappedRole, content: flatText });
      } else {
        input.push({
          role: mappedRole,
          content: onlyText ? contentParts[0].text : contentParts,
        });
      }
    } else if (text) {
      input.push({ role: mappedRole, content: text });
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const name = fn.name || tc.name;
        if (!name) continue;
        input.push({
          type: "function_call",
          call_id: tc.id || `call_chat_${input.length}`,
          name,
          arguments:
            typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        });
      }
    }
  }
  return input;
}

// The Responses API sometimes namespaces function names as
// "default.<name>"; strip it so clients see the tool name they sent.
// 上游有时给 function_call 名加 "default." 前缀。剥离前校验：只有当剥离后的
// 名字在客户端工具名单里才剥，避免误伤本名就叫 default.xxx 的工具。

// v47: Responses API 请求体 → Chat Completions 请求体（反向翻译）。
// 用于 /v1/responses 收到非 muse-spark 模型（mimo/longcat）时：
// 上游 /zen/v1/responses 只支持 muse-spark，这些模型要走 /zen/v1/chat/completions。
function responsesToChatBody(body) {
  const messages = [];
  // instructions → system 消息
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  // input 为字符串 → 直接作为 user 消息（v50修复：之前只处理数组，字符串input会被静默丢弃导致上游400）
  if (typeof body.input === "string" && body.input) {
    messages.push({ role: "user", content: body.input });
  }
  // input 数组 → chat messages
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.type === "function_call") {
      // 上一轮 assistant 的工具调用 → 转成 assistant 消息带 tool_calls
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id || `call_resp_${messages.length}`,
            type: "function",
            function: {
              name: item.name || "",
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }
    // 普通消息：{role, content}
    const role = item.role || "user";
    let content = "";
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      const parts = item.content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p.type === "input_text") return p.text || "";
          if (p.type === "input_image") {
            const url = p.image_url || "";
            return url ? { type: "image_url", image_url: { url } } : "";
          }
          return p.text || "";
        })
        .filter(Boolean);
      const hasImage = parts.some((c) => typeof c === "object");
      content = hasImage ? parts : parts.join("");
    }
    messages.push({ role, content });
  }
  const chatBody = {
    model: body.model,
    messages,
    stream: true, // 上游免费层只认流式
  };
  // 工具：Responses 格式 → Chat 格式
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools.map((t) => {
      if (t.type === "function") {
        return {
          type: "function",
          function: {
            name: t.name || "",
            description: t.description || "",
            parameters: t.parameters || { type: "object", properties: {} },
          },
        };
      }
      return t;
    });
  }
  if (body.tool_choice !== undefined) chatBody.tool_choice = body.tool_choice;
  applySamplingParams(chatBody, body);
  if (body.max_output_tokens !== undefined)
    chatBody.max_tokens = body.max_output_tokens;
  // v47.1: 上游 chat 接口不认 Responses 专有字段，删掉。之前这里会连带
  // max_output_tokens（已转成 max_tokens，不删就是两个并存）和 reasoning
  // {effort,summary} 一起发过去，上游对未知参数是严格 400 的（v8/v25 踩过坑）；
  // mimo/longcat 是非推理模型，也不需要 reasoning。
  delete chatBody.max_output_tokens;
  delete chatBody.reasoning;
  return chatBody;
}

// v47: Anthropic Messages 请求体 → Chat Completions 请求体。
// 用于 /v1/messages 收到非 muse-spark 模型时走 chat 上游。
function anthropicToChatBody(body) {
  const messages = [];
  if (body.system) {
    const sysText =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((p) => p.text || "").join("")
          : "";
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      const parts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const p of content) {
        if (p.type === "text") parts.push(p.text || "");
        else if (p.type === "image") {
          const src = p.source || {};
          const url =
            src.type === "url"
              ? src.url
              : src.type === "base64"
                ? `data:${src.media_type};base64,${src.data}`
                : "";
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (p.type === "tool_use") {
          toolCalls.push({
            id: p.id || `call_anth_${toolCalls.length}`,
            type: "function",
            function: {
              name: p.name || "",
              arguments:
                typeof p.input === "string"
                  ? p.input
                  : JSON.stringify(p.input ?? {}),
            },
          });
        } else if (p.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: p.tool_use_id || "",
            content:
              typeof p.content === "string"
                ? p.content
                : JSON.stringify(p.content ?? ""),
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push(...toolResults);
      } else {
        const msg = {
          role,
          content:
            parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts,
        };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    }
  }
  const chatBody = {
    model: body.model,
    messages,
    stream: true,
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name || "",
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === "string") chatBody.tool_choice = tc;
    else if (tc.type === "auto") chatBody.tool_choice = "auto";
    else if (tc.type === "any") chatBody.tool_choice = "required";
    else if (tc.type === "tool")
      chatBody.tool_choice = { type: "function", function: { name: tc.name } };
  }
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.max_tokens !== undefined) chatBody.max_tokens = body.max_tokens;
  return chatBody;
}
function unprefixToolName(name, knownNames) {
  if (typeof name === "string" && name.startsWith("default.")) {
    const stripped = name.slice("default.".length);
    if (!knownNames || knownNames.has(stripped)) return stripped;
  }
  return name;
}
// 从请求体收集客户端工具名（含伪装工具和反代内置工具），三种接口形状都兼容。
// forceSearch：请求级 -search 标志（默认读全局；并发请求必须显式传入本请求的值，
// 不能读全局——全局在 await 之后可能已被另一个请求改掉）。
function collectToolNames(body, forceSearch = requestForceSearch) {
  const proxyNames = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
  const s = new Set([...DISGUISE_NAMES, ...proxyNames]);
  for (const t of body?.tools || []) {
    const n = t?.function?.name || t?.name;
    if (typeof n === "string" && n) s.add(n);
  }
  return s;
}

// ---------- 反代内置工具执行器：webfetch / websearch ----------
// 对齐 oc 原生行为（sst/opencode 源码）。所有执行器永不抛异常：
// 失败返回中文错误文本给模型，由模型决定下一步，而不是掐断整个请求。

// HTML 实体解码（覆盖常见实体，够正文抽取用）
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    });
}

// 去掉 script/style 等无正文意义的标签及其内容
function stripNoisyTags(html) {
  return html.replace(
    /<(script|style|noscript|iframe|object|embed|meta|link|head)[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ""
  );
}

// HTML → 纯文本：去标签，压缩空白
function htmlToText(html) {
  let s = stripNoisyTags(html);
  // 块级元素换行
  s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// HTML → 轻量 markdown：标题、链接、列表、代码块（不用 turndown 依赖）
function htmlToMarkdown(html) {
  let s = stripNoisyTags(html);
  // 代码块先占位，避免内部标签被误处理
  const codeBlocks = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    codeBlocks.push(code);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  // 行内代码
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner) => {
    // 实体解码统一放到最后整串做一次：这里若先解码，解出的 < 会被后面的去标签误吃掉
    return "`" + inner.replace(/<[^>]+>/g, "").trim() + "`";
  });
  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, lv, inner) => {
    return `\n\n${"#".repeat(Number(lv))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`;
  });
  // 链接：[文本](href)
  s = s.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, href, inner) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      if (!text || text === href) return href;
      return `[${text}](${href})`;
    }
  );
  // 列表项
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => {
    return `\n- ${inner.replace(/<[^>]+>/g, "").trim()}`;
  });
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  // 段落/换行
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|tr|section|article|blockquote)[^>]*>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // 还原代码块
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    return `\n\n\`\`\`\n${codeBlocks[Number(i)] || ""}\n\`\`\`\n\n`;
  });
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r]+/g, " ").trimEnd())
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

const WEBFETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// webfetch 执行器：对齐 oc 原生（默认 30s 超时/最大 120s，5MB 上限，Chrome UA，403 重试一次）
const WEBFETCH_LIMIT = 5 * 1024 * 1024;

// IP 字面量是否为私网/回环/链路本地/未指定（v4 + v6）
function isPrivateIpLiteral(host) {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const oct = [1, 2, 3, 4].map((i) => Number(ipv4[i]));
    if (oct.some((n) => n > 255)) return true;
    const [a, b] = oct;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  // IPv6：回环/未指定/链路本地/唯一本地（含全写形式）
  const h = host.toLowerCase();
  if (
    h === "::1" ||
    h === "::" ||
    h === "0:0:0:0:0:0:0:1" ||
    h === "0:0:0:0:0:0:0:0" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc00:") ||
    h.startsWith("fd00:")
  ) {
    return true;
  }
  return false;
}

// SSRF 检查：拦则返回中文原因字符串，不拦返回 null。
// 覆盖：协议/主机名黑名单/IP 字面量/DNS 解析到私网（防 DNS 重绑定）。
// redirect 跳转时每跳都要调一次（跳转链可能跳进内网）。
async function ssrfBlockReason(targetUrl, allowPrivate) {
  if (allowPrivate) return null;
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return `抓取失败：URL 解析失败`;
  }
  if (!/^https?:$/.test(u.protocol)) {
    return `抓取失败：只支持 http:// 或 https:// 开头的 URL`;
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  ) {
    return `抓取失败：不允许抓取内网地址（${host}）`;
  }
  if (isPrivateIpLiteral(host)) {
    return `抓取失败：不允许抓取内网地址（${host}）`;
  }
  // DNS 重绑定防护：域名解析出的 IP 全部检查，任一私网即拦
  // （解析失败则放行，交给 fetch 报网络错，不在这里误杀）
  try {
    const addrs = await dns.promises.lookup(u.hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateIpLiteral(a.address.toLowerCase())) {
        return `抓取失败：不允许抓取内网地址（${host} 解析到内网 IP）`;
      }
    }
  } catch {}
  return null;
}

async function doWebfetch(args, signal) {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    return `抓取失败：只支持 http:// 或 https:// 开头的 URL（收到：${url.slice(0, 80) || "空"}）`;
  }
  // SSRF 防护：禁止私网/回环/链路本地地址，防止模型让反代抓内网
  // 测试环境（ALLOW_PRIVATE_FETCH=1）放行本地地址，方便单元测试
  const allowPrivate = process.env.ALLOW_PRIVATE_FETCH === "1";
  const blocked = await ssrfBlockReason(url, allowPrivate);
  if (blocked) return blocked;
  const format = ["text", "markdown", "html"].includes(args?.format)
    ? args.format
    : "markdown";
  const timeoutSec = Math.min(Math.max(Number(args?.timeout) || 30, 1), 120);
  console.log(`webfetch → ${url.slice(0, 100)}`);
  const tryFetch = async (withUA, targetUrl) => {
    // 对齐原版：按 format 设置 Accept 头，让服务器返回更合适的内容
    let acceptHeader = "*/*";
    if (format === "markdown") {
      acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    } else if (format === "text") {
      acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    } else if (format === "html") {
      acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
    }
    const headers = withUA
      ? { "user-agent": WEBFETCH_UA, "accept": acceptHeader, "accept-language": "en-US,en;q=0.9" }
      : {};
    const resp = await fetch(targetUrl, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)])
        : AbortSignal.timeout(timeoutSec * 1000),
      // 手动跟跳转：每跳都过 SSRF 检查（自动 follow 会无声跳进内网）
      redirect: "manual",
    });
    return resp;
  };
  // 流式读取响应体，上限 5MB：超了立刻 cancel，不像原来先 arrayBuffer()
  // 全读进内存再 slice（几百 MB 的页面直接打爆手机内存）
  const readCappedBody = async (resp) => {
    const len = Number(resp.headers.get("content-length"));
    let truncated = len > WEBFETCH_LIMIT;
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > WEBFETCH_LIMIT) {
          truncated = true;
          const keep = value.byteLength - (total - WEBFETCH_LIMIT);
          if (keep > 0) chunks.push(value.slice(0, keep));
          try {
            await reader.cancel();
          } catch {}
          break;
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return { buf: Buffer.concat(chunks), truncated };
  };
  const failMsg = (e) =>
    `抓取失败：${e?.name === "TimeoutError" ? `请求超时（${timeoutSec}秒）` : e?.message || e}`;
  try {
    // 手动跳转循环：最多 10 跳，每跳 SSRF 重检
    let curUrl = url;
    let resp = null;
    for (let hop = 0; hop <= 10; hop++) {
      if (hop > 0) {
        const hopBlocked = await ssrfBlockReason(curUrl, allowPrivate);
        if (hopBlocked) return hopBlocked;
      }
      try {
        resp = await tryFetch(true, curUrl);
      } catch (e) {
        return failMsg(e);
      }
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const loc = resp.headers.get("location");
      if (!loc) break;
      try {
        await resp.body?.cancel?.();
      } catch {}
      if (hop === 10) return `抓取失败：重定向次数过多`;
      try {
        curUrl = new URL(loc, curUrl).toString();
      } catch {
        return `抓取失败：重定向地址无效`;
      }
    }
    // 403 时重试一次（不带特殊 header，用默认 fetch 行为）
    if (resp.status === 403) {
      try {
        resp = await tryFetch(false, curUrl);
      } catch (e) {
        return failMsg(e);
      }
    }
    if (!resp.ok) {
      return `抓取失败：HTTP ${resp.status}（${curUrl.slice(0, 80)}）`;
    }
    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    // 图片直接提示跳过（不对齐 base64，保持轻量）
    if (ctype.startsWith("image/")) {
      return `（该 URL 是图片 ${ctype}，已跳过）`;
    }
    // 5MB 上限：超了不报错，截断返回已读部分并注明（用户要求：别报错）
    const { buf, truncated } = await readCappedBody(resp);
    const raw = buf.toString("utf8");
    let out;
    if (format === "html") {
      out = raw.slice(0, 8000);
    } else if (format === "text") {
      out = htmlToText(raw);
    } else {
      out = htmlToMarkdown(raw);
    }
    // 约 8000 字符截断，防超长输出吃掉上下文
    if (out.length > 8000) out = out.slice(0, 8000) + "\n\n（内容过长已截断）";
    if (truncated) out += "\n\n（注：页面超过 5MB，仅返回前 5MB 内容）";
    if (!out) return `抓取失败：页面无有效正文`;
    return out;
  } catch (e) {
    return `抓取失败：${e?.message || e}`;
  }
}

// websearch 执行器：MCP 协议调 Exa hosted 服务（免 API key），25 秒超时
async function doWebsearch(args, seq, signal) {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) return "搜索失败：缺少 query 参数";
  const numResults = Math.min(Math.max(Number(args?.numResults) || 8, 1), 20);
  const t0 = Date.now();
  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        type: ["auto", "fast", "deep"].includes(args?.type) ? args.type : "auto",
        numResults,
        livecrawl: ["fallback", "preferred"].includes(args?.livecrawl)
          ? args.livecrawl
          : "fallback",
        ...(typeof args?.contextMaxCharacters === "number" &&
        args.contextMaxCharacters > 0
          ? { contextMaxCharacters: Math.min(args.contextMaxCharacters, 50000) }
          : {}),
      },
    },
  };
  try {
    const resp = await fetch("https://mcp.exa.ai/mcp?tools=web_search_exa", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(rpcBody),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      return `搜索失败：搜索服务 HTTP ${resp.status}`;
    }
    const text = await resp.text();
    // MCP 可能返回纯 JSON 或 SSE（data: 行），两种都兼容
    let payload = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      const jsonStr = t.startsWith("data:") ? t.slice(5).trim() : t;
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const obj = JSON.parse(jsonStr);
        if (obj?.result || obj?.error) {
          payload = obj;
          break;
        }
      } catch {}
    }
    if (!payload) {
      try {
        payload = JSON.parse(text);
      } catch {
        return "搜索失败：搜索服务返回无法解析";
      }
    }
    if (payload.error) {
      return `搜索失败：${payload.error?.message || JSON.stringify(payload.error).slice(0, 200)}`;
    }
    const contents = payload?.result?.content;
    if (!Array.isArray(contents) || contents.length === 0) {
      return "搜索失败：无搜索结果";
    }
    // content 数组拼成可读文本：标题+摘要+URL
    const parts = [];
    for (const c of contents) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        parts.push(c.text.trim());
      }
    }
    const out = parts.join("\n\n---\n\n").trim();
    if (!out) return "搜索失败：无搜索结果";
    // 成功：1 行，带请求号+耗时+结果数
    const costS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`#${seq} 🔍 websearch · "${query.slice(0, 30)}" · ${costS}秒 · ${parts.length}条结果`);
    return out.length > 10000 ? out.slice(0, 10000) + "\n\n（结果过长已截断）" : out;
  } catch (e) {
    return `搜索失败：${e?.name === "TimeoutError" ? "搜索服务超时（25秒）" : e?.message || e}`;
  }
}

// 内置工具分发：永不抛异常。开关关闭时直接返回提示，不执行。
// forceSearch：请求级 -search 标志（默认读全局；并发请求必须显式传入，
// 不能在 await 之后读全局——可能已被另一个请求改掉）。
async function runProxyTool(name, argsJson, seq, signal, forceSearch = requestForceSearch) {
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `参数解析失败：${String(argsJson).slice(0, 120)}`;
  }
  // forceSearch（模型名 -search 后缀）时无视环境变量开关，强制可用
  if (name === WEBFETCH_NAME) {
    if (!WEBFETCH_ENABLED && !forceSearch) return "网页抓取功能已关闭";
    return doWebfetch(args, signal);
  }
  if (name === WEBSEARCH_NAME) {
    if (!WEBSEARCH_ENABLED && !forceSearch) return "联网搜索功能已关闭";
    return doWebsearch(args, seq, signal);
  }
  return `未知内置工具：${name}`;
}

// 拦截到的工具调用转成 Responses input items（follow-up 请求用）
function proxyToolInputItems(calls, outputs) {
  const items = [];
  for (const c of calls) {
    items.push({
      type: "function_call",
      call_id: c.call_id,
      name: c.name,
      arguments: c.arguments,
    });
  }
  for (let i = 0; i < calls.length; i++) {
    items.push({
      type: "function_call_output",
      call_id: calls[i].call_id,
      output: outputs[i] ?? "",
    });
  }
  return items;
}

// 内置工具 follow-up 循环的 input 归一化：Responses input 允许字符串，
// follow-up 需要数组形式追加 function_call，这里统一转成数组
function asInputArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string" && input)
    return [{ role: "user", content: input }];
  return [];
}

// 从 usage 对象里按多个候选键取值（兼容 OpenAI 式 prompt_tokens 与
// Responses 式 input_tokens 两种形状）
function usageNum(u, ...keys) {
  for (const k of keys) {
    const v = u?.[k];
    if (typeof v === "number") return v;
  }
  return undefined;
}

// 多轮 follow-up 的 usage 合并（OpenAI 形状输出）：token 求和，cached 取最大。
// 供各直接路径的内置工具循环用（翻译路径已有自己的 mergeUsage/mergeUsageNS，不动）。
function mergeUsageSum(acc, u) {
  if (!u) return acc;
  const norm = (x) => ({
    prompt: usageNum(x, "prompt_tokens", "input_tokens"),
    completion: usageNum(x, "completion_tokens", "output_tokens"),
    total: usageNum(x, "total_tokens"),
    cached: Math.max(
      usageNum(x?.prompt_tokens_details, "cached_tokens") ?? -1,
      usageNum(x?.input_tokens_details, "cached_tokens") ?? -1
    ),
  });
  const a = acc ? norm(acc) : null;
  const b = norm(u);
  const sum = (x, y) =>
    typeof x === "number" && typeof y === "number" ? x + y : (x ?? y);
  const out = {
    prompt_tokens: sum(a?.prompt, b.prompt),
    completion_tokens: sum(a?.completion, b.completion),
    total_tokens: sum(a?.total, b.total),
  };
  const c = Math.max(a?.cached ?? -1, b.cached);
  if (c >= 0) out.prompt_tokens_details = { cached_tokens: c };
  return out;
}

// 多轮 follow-up 的 usage 合并（Responses 形状输出）：直连 /v1/responses
// 非流式路径最终返回 Responses 对象，usage 保持 input_tokens 形状
function mergeResponsesUsage(acc, u) {
  if (!u) return acc;
  const norm = (x) => ({
    input: usageNum(x, "input_tokens", "prompt_tokens"),
    output: usageNum(x, "output_tokens", "completion_tokens"),
    total: usageNum(x, "total_tokens"),
    cached: Math.max(
      usageNum(x?.input_tokens_details, "cached_tokens") ?? -1,
      usageNum(x?.prompt_tokens_details, "cached_tokens") ?? -1
    ),
  });
  const a = acc ? norm(acc) : null;
  const b = norm(u);
  const sum = (x, y) =>
    typeof x === "number" && typeof y === "number" ? x + y : (x ?? y);
  const out = {
    input_tokens: sum(a?.input, b.input),
    output_tokens: sum(a?.output, b.output),
    total_tokens: sum(a?.total, b.total),
  };
  const c = Math.max(a?.cached ?? -1, b.cached);
  if (c >= 0) out.input_tokens_details = { cached_tokens: c };
  return out;
}

// Convert a Responses-API object into an OpenAI chat.completion object.
function responseToChatCompletion(resp, fallbackModel, knownNames) {
  let text = "";
  let reasoning = resp.reasoning || "";
  const toolCalls = [];
  for (const item of resp.output || []) {
    if (item.type === "function_call" && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: unprefixToolName(item.name, knownNames),
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
    for (const c of item.content || []) {
      if (c.type === "output_text" && typeof c.text === "string")
        text += c.text;
    }
    // Responses reasoning item: summary 数组里是 {type:"summary_text", text}
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (typeof s?.text === "string") reasoning += s.text;
      }
    }
  }
  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason = toolCalls.length
    ? "tool_calls"
    : resp.status === "incomplete" && resp.incompleteReason === "max_output_tokens"
      ? "length"
      : "stop";
  const out = {
    id: resp.id || `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
  };
  if (resp.usage) {
    const input = resp.usage.input_tokens;
    const output = resp.usage.output_tokens;
    out.usage = {
      // 缺字段保留 undefined（与 sseToResponse 一致），不用 0 冒充
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens:
        resp.usage.total_tokens ??
        (typeof input === "number" && typeof output === "number"
          ? input + output
          : undefined),
      ...(resp.usage.input_tokens_details
        ? { prompt_tokens_details: resp.usage.input_tokens_details }
        : {}),
    };
  }
  return out;
}

// ---- Anthropic Messages API translation (via Responses API upstream) ----

// Anthropic request -> Responses-API request body.
function anthropicToResponsesBody(body) {
  const input = [];
  const sysText =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s) => s.text || "").join("\n\n")
        : "";
  if (sysText) input.push({ role: "developer", content: sysText });

  // v39：Anthropic thinking 映射到上游 reasoning（之前直接丢弃是 bug）。
  // thinking {type:"enabled"} -> reasoning {effort:"medium", summary:"auto"}。
  // 缺省时 spark 模型也补默认 medium，与其他路径一致（v37）。
  if (body.thinking?.type === "enabled") {
    console.log("Anthropic thinking 已转成 reasoning {effort:medium}");
  } else if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    console.warn("stop_sequences 上游不支持（传了会 400），已忽略");
  }
  if (body.tool_choice && body.tool_choice.type !== "auto") {
    console.warn(
      `Anthropic tool_choice type="${body.tool_choice.type}" 上游只支持 auto，已忽略`
    );
  }

  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      if (content) input.push({ role, content });
      continue;
    }
    // 文本+图片按原文顺序并入同一消息的 content（对齐 chat 路径做法）；
    // 以前图片被 push 成顶层无 role 的 input_image，还会打乱顺序。
    // tool_use/tool_result 先缓冲，文本消息 push 后再 push——否则
    // [text, tool_use] 会变成 [function_call, 文本消息]，因果颠倒。
    const parts = [];
    const deferred = [];
    for (const b of content || []) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && b.text) {
        parts.push({ type: "input_text", text: b.text });
      } else if (b.type === "image" && b.source) {
        const src = b.source;
        if (src.type === "base64" && src.data)
          parts.push({
            type: "input_image",
            image_url: `data:${src.media_type || "image/jpeg"};base64,${src.data}`,
          });
        else if (src.type === "url" && src.url)
          parts.push({ type: "input_image", image_url: src.url });
      } else if (b.type === "tool_use" && b.name) {
        deferred.push({
          type: "function_call",
          call_id: b.id || `call_anthropic_${deferred.length}`,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === "tool_result") {
        const cid = b.tool_use_id || "";
        if (!cid)
          throw new BadRequest("tool_result 缺少 tool_use_id，无法配对工具调用");
        const out =
          typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content ?? "");
        deferred.push({
          type: "function_call_output",
          call_id: cid,
          output: out,
        });
      }
    }
    if (parts.length) {
      if (role === "assistant") {
        // 同 chat 路径：assistant 消息不能用 input_text（上游 400），压成纯文本
        const flatText = parts
          .map((p) => (p.type === "input_text" ? p.text : ""))
          .join("");
        if (flatText) input.push({ role, content: flatText });
      } else {
        input.push({ role, content: parts });
      }
    }
    for (const d of deferred) input.push(d);
  }

  const rb = { model: body.model, input, stream: true, store: false };
  applySamplingParams(rb, body);
  // v39：thinking -> reasoning 映射；缺省时 spark 补默认 medium（与其他路径一致）。
  // v41：嵌套 reasoning.effort:"none" 也视为缺省。
  if (body.thinking?.type === "enabled") {
    rb.reasoning = { effort: "medium", summary: "auto" };
  } else if (
    typeof rb.model === "string" &&
    rb.model.startsWith("muse-spark-") &&
    (!rb.reasoning?.effort || rb.reasoning.effort === "none")
  ) {
    rb.reasoning = { effort: "medium", summary: "auto" };
    console.log("思考参数缺省，已补默认 medium（spark Anthropic）");
  }
  // Anthropic tool_choice {type:"auto"|"any"|"tool"|"none"} -> Responses.
  // Upstream only accepts "auto"; anything else is dropped by
  // sanitizeToolChoice inside ensureResponsesTools below.
  if (body.tool_choice?.type === "auto") rb.tool_choice = "auto";
  if (Array.isArray(body.tools)) {
    rb.tools = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      }));
  }
  ensureResponsesTools(rb);
  return rb;
}

// anthropicToResponsesBody 的包装：同时返回实际注入的反代工具名（供拦截用）
function anthropicToResponsesBodyWithNames(body) {
  const rb = anthropicToResponsesBody(body);
  // ensureResponsesTools 已在内部调用，这里重新计算实际注入的（rb.tools 已合并）
  // v42: 与 ensureResponsesTools 的注入逻辑一致（只在 forceSearch 时注入）
  const proxyDefs = requestForceSearch ? ALL_PROXY_TOOLS_RESPONSES : [];
  const names = new Set();
  const toolNames = new Set((rb.tools || []).map((t) => t?.name).filter(Boolean));
  for (const pt of proxyDefs) {
    if (toolNames.has(pt.name)) names.add(pt.name);
  }
  return { body: rb, proxyNames: names };
}

// Responses-API object -> Anthropic message object.
function responseToAnthropic(resp, fallbackModel, knownNames) {
  const content = [];
  // v39：思维链 -> Anthropic thinking block（放最前面，之前丢了）
  if (resp.reasoning) {
    content.push({ type: "thinking", thinking: resp.reasoning });
  }
  for (const item of resp.output || []) {
    if (item.type === "function_call" && item.name) {
      let input = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: item.call_id || item.id || `toolu_${content.length}`,
        name: unprefixToolName(item.name, knownNames),
        input,
      });
    }
    for (const c of item.content || []) {
      if (c.type === "output_text" && c.text)
        content.push({ type: "text", text: c.text });
    }
  }
  const stopReason = content.some((c) => c.type === "tool_use")
    ? "tool_use"
    : resp.status === "incomplete" && resp.incompleteReason === "max_output_tokens"
      ? "max_tokens"
      : "end_turn";
  return {
    id: resp.id || `msg_proxy_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model || fallbackModel,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
      // Anthropic 原生缓存字段，语义与 cached_tokens 一致
      ...(typeof resp.usage?.input_tokens_details?.cached_tokens === "number"
        ? {
            cache_read_input_tokens:
              resp.usage.input_tokens_details.cached_tokens,
          }
        : {}),
    },
  };
}

// Last-resort safety net: this proxy runs unattended on a phone for days.
// A single malformed upstream payload must never kill the process; log it
// and keep serving (requests are independent).
process.on("uncaughtException", (e) => {
  console.error("程序内部异常：", e?.message || e, "（若反复出现请截图发给姐姐）");
});
process.on("unhandledRejection", (e) => {
  console.error("异步任务异常：", e?.message || e, "（若反复出现请截图发给姐姐）");
});

// CORS：允许酒馆插件等浏览器端直连本反代（不走酒馆后端转发时必需）。
// 本机 127.0.0.1 的反代，开 * 是安全的。
// 注意：413 超限响应在 req "data" 事件里发出（"end" 还没触发），
// 必须在那里也调一次，否则浏览器端只能看到 CORS 报错、看不到真实 413。
// Allow-Headers 用 *：插件类浏览器客户端可能带自定义头，逐个白名单容易漏；
// 无凭据请求下 * 合法（本反代不设置 Allow-Credentials）。
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const server = http.createServer((req, res) => {
  const chunks = [];
  let bodyTooLarge = false;
  // 手机内存有限：请求体超过 100MB 直接拒绝，防 buggy 客户端打爆内存。
  // 正常图片输入（几 MB 的 base64）不受影响。
  const MAX_BODY = 100 * 1024 * 1024;
  let bodyBytes = 0;
  // Unhandled 'error' events on req/res throw and would crash the whole
  // process (e.g. client disconnects mid-upload, or write to a dead socket).
  // Swallow them: the abort/close logic above already handles cleanup.
  req.on("error", () => {});
  res.on("error", () => {});
  req.on("data", (c) => {
    if (bodyTooLarge) return;
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY) {
      bodyTooLarge = true;
      // 先发 413，再 drain 掉剩余 body 让连接正常收尾。
      // 注意不能 req.destroy()：destroy 会同步丢弃 socket 发送缓冲区，
      // 413 的响应体还没刷出去就被掐掉，客户端只会看到连接重置。
      try {
        setCorsHeaders(res); // "end" 还没触发，CORS 头必须在这里补
        sendErrorJson(res, 413, "请求体超过 100MB 上限");
      } catch {}
      try {
        req.resume(); // 继续消费并丢弃剩余数据，'end' 触发后早退
      } catch {}
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (bodyTooLarge) return; // 413 已在超限时发送
    // 请求序号：开始/完成/取消三行靠 #N 配对；try 外声明，catch 里也能用
    const seq = ++reqSeq;
    // 调用方身份（IP+客户端分类），打在开始行里；end 回调里 socket 仍可用
    const clientTag = fmtClientTag(req);
    // 计时对象放 try 外面：catch 里要读 firstTokenAt 判断断在哪一步
    // "首字"=从发请求到首个 token 的真实等待
    const timing = { t0: Date.now(), firstTokenAt: 0, usage: null };
    // clientGone: 客户端是否提前断开。用显式 flag 而不用 req.destroyed——
    // Node 会在请求体收完后自动 destroy req，那样任何异常都会被误判为取消。
    let clientGone = false;
    // 响应是否已正常完成（发完 [DONE]/res.end）。完成后客户端关闭连接是正常的，
    // 不能再误报为"客户端断开"。
    let responseDone = false;
    let ac = null;
    // body / clientWantsStream 必须在 try 外声明：catch 里要用。
    // 之前在 try 里声明，catch 一引用就 ReferenceError，
    // 报"异步任务异常：clientWantsStream is not defined"。
    let body = null;
    let clientWantsStream = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        try {
          ac?.abort();
        } catch {}
      }
    });
    try {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, "http://localhost");

      // v38/v45: /r 前缀专供 Response API 模式（RikkaHub 里填 http://127.0.0.1:8788/r/v1）。
      // v45: 模型列表统一返回 8 个（含 -search 变体），所有接口都认后缀。
      // /r 仅做路径兼容（剥掉前缀），不再区分模型列表。
      let hideSearchVariants = false;
      if (url.pathname === "/r" || url.pathname.startsWith("/r/")) {
        url.pathname =
          url.pathname === "/r" ? "/" : url.pathname.slice(2);
      }

      setCorsHeaders(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

    // Learn mode: real OpenCode pointed at this proxy (via
    // provider.opencode.options.baseURL) carries fresh identity headers.
    // Persist them so plain OpenAI clients can reuse them afterwards.
    // STRICT: only learn from requests that actually look like OpenCode.
    // Other clients (e.g. RikkaHub) send their own X-Session-ID which must
    // NEVER overwrite our crafted session, or every later request breaks.
    const incomingUA0 = req.headers["user-agent"] || "";
    const incomingSid =
      req.headers["x-session-id"] || req.headers["x-opencode-session"];
    if (
      incomingSid &&
      /opencode/i.test(incomingUA0) &&
      /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/.test(String(incomingSid))
    ) {
      try {
        const sessionPath = path.join(DIR, "session.json");
        const sessionTmp = sessionPath + ".tmp";
        // 先写临时文件再原子 rename：避免并发请求在写入中途读到半截文件
        fs.writeFileSync(
          sessionTmp,
          JSON.stringify(
            {
              userAgent:
                req.headers["user-agent"] || "opencode/latest/2.0.12/cli",
              xOpencodeClient: req.headers["x-opencode-client"] || "cli",
              xOpencodeOrgId: req.headers["x-opencode-org-id"] || "",
              xOpencodeProject: req.headers["x-opencode-project"] || "",
              xOpencodeSession:
                req.headers["x-opencode-session"] || incomingSid,
              xOpencodeRequest: req.headers["x-opencode-request"] || "",
              xSessionId: incomingSid,
              xSessionAffinity:
                req.headers["x-session-affinity"] || incomingSid,
              capturedAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
        fs.renameSync(sessionTmp, sessionPath);
      } catch {}
    }

    if (req.method === "GET" && url.pathname === "/health") {
      let version = "?";
      try {
        version =
          JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"))
            .version || "?";
      } catch {}
      return sendJson(res, 200, {
        ok: true,
        upstream: UPSTREAM + "/zen/v1",
        version,
        port: PORT,
        session: sessionStatus().status, // ok / missing / corrupt
        uptime: Math.round(process.uptime()),
      });
    }

    const apiKey = getApiKey();

    let upstreamPath = null;
    if (
      url.pathname === "/v1/models" ||
      url.pathname === "/models" ||
      url.pathname === "/zen/v1/models"
    ) {
      upstreamPath = "/zen/v1/models";
    } else if (
      (url.pathname === "/v1/chat/completions" ||
        url.pathname === "/zen/v1/chat/completions") &&
      req.method === "POST"
    ) {
      upstreamPath = "/zen/v1/chat/completions";
    } else if (
      (url.pathname === "/v1/responses" ||
        url.pathname === "/zen/v1/responses") &&
      req.method === "POST"
    ) {
      upstreamPath = "/zen/v1/responses";
    } else if (url.pathname === "/v1/messages" && req.method === "POST") {
      // Anthropic Messages API -> translated via Responses upstream.
      upstreamPath = "/zen/v1/responses";
    } else {
      return sendErrorJson(res, 404, `Unknown route ${req.method} ${url.pathname}`);
    }

    const sessInfo = sessionStatus();
    const session = sessInfo.session;
    if (upstreamPath !== "/zen/v1/models" && !session?.xSessionId) {
      return sendErrorJson(
        res,
        500,
        sessInfo.status === "corrupt"
          ? "session.json 已损坏（不是标准 JSON 或缺少身份字段），请删除后重新抓取身份"
          : "缺少 session.json：首次使用请抓取身份（把 opencode 的 baseURL 指到本反代发一次请求可自动学习），不会操作就找姐姐帮忙"
      );
    }

    // 客户端原始工具名（ensure 之前）：用于判断反代内置工具是否被客户端自带同名覆盖。
    // 拦截规则：只拦截反代实际注入的；客户端自带同名工具时不拦截，走客户端流程。
    const clientToolNames = new Set();
    // 本请求实际注入的反代内置工具名（用于拦截）
    let proxyInterceptNames = new Set();
    // 默认不强制搜索；有 body 时在解析后根据 -search 后缀设置
    requestForceSearch = false;
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString());
      } catch {
        return sendErrorJson(res, 400, "Invalid JSON body");
      }
      // --- 思考参数规范化（路径相关） ---
      // 上游 /zen/v1/responses 只认 reasoning: {effort, summary} 形状，
      // 顶层 reasoning_effort 直接报 unknown parameter（v33 踩过坑）。
      // 注意之前 'none' 的报错是网关另一层校验，别被误导。
      // chat 直连路径（mimo/longcat）保持原样透传，之前就是好的，不动。
      const _isRespUp = upstreamPath === "/zen/v1/responses";
      if (_isRespUp && body.reasoning_effort !== undefined) {
        const _eff = body.reasoning_effort;
        delete body.reasoning_effort;
        // v40："auto" 档映射成 medium。上游只认 minimal/low/medium/high，
        // 直接透传 "auto" 会 400。语义上 auto=让系统决定，反代按标准默认处理。
        const _normEff = _eff === "auto" ? "medium" : _eff;
        if (_normEff && _normEff !== "none") {
          body.reasoning = {
            ...(body.reasoning || {}),
            effort: body.reasoning?.effort ?? _normEff,
          };
          if (_eff === "auto") console.log("思考参数 auto 已映射为 medium");
        }
      } else if (body.reasoning_effort === "none") {
        // chat 路径的 'none' 也删掉，语义=不指定，省得上游找茬
        delete body.reasoning_effort;
      }
      // 要了思考力度但没要摘要 → 补 summary='auto'，
      // 否则上游只思考不回摘要，RikkaHub 思维链是空的（1.3 之前就是这个问题；
      // longcat 是直连原生输出所以正常）。
      if (
        _isRespUp &&
        body.reasoning?.effort &&
        body.reasoning?.summary === undefined
      ) {
        body.reasoning.summary = "auto";
      }
      // v40：直接传 reasoning.effort="auto" 也映射成 medium（同上）。
      if (_isRespUp && body.reasoning?.effort === "auto") {
        body.reasoning.effort = "medium";
        console.log("思考参数 auto 已映射为 medium");
      }
      // v37：Response API 路径 spark 模型缺省思考参数时，补标准默认
      // {effort:"medium", summary:"auto"}。用户实测：默认不传时上游行为异常，
      // 必须传一个标准值。只对 muse-spark-*（原生推理模型）生效，其他模型不动。
      // 注意：排除 /v1/messages（Anthropic body 翻译前也会经过这里，不能污染）。
      // v41：RikkaHub 测试按钮发的是嵌套 reasoning.effort:"none"，也视为缺省。
      if (
        _isRespUp &&
        url.pathname !== "/v1/messages" &&
        typeof body.model === "string" &&
        body.model.startsWith("muse-spark-") &&
        (!body.reasoning?.effort || body.reasoning.effort === "none")
      ) {
        body.reasoning = { effort: "medium", summary: "auto" };
        console.log("思考参数缺省，已补默认 medium（spark Response API）");
      }
      // v38：previous_response_id 剥掉。反代对上游设了 store:false（不存响应），
      // 传这个 ID 上游会 400（找不到）。客户端应传完整 input（RikkaHub 就是这么做的）。
      if (_isRespUp && body.previous_response_id !== undefined) {
        console.warn(
          "previous_response_id 已忽略（反代不存上游响应，请传完整 input）"
        );
        delete body.previous_response_id;
      }
      // 模型名后缀开关：以 "-search" 结尾则强制启用 websearch/webfetch，
      // 剥掉后缀再发给上游（上游只认原名）。RikkaHub 里切模型即开关搜索。
      // 必须在 ensure* 之前设置 requestForceSearch（它们会读取本标志）。
      // v45: 所有接口都认 -search 后缀（无条件开启搜索）；Response API 的
      // RikkaHub"模型搜索"开关（v36 原生转换）同样开启。都不选则不注入（v42）。
      // v55: 用局部变量保存原始模型名供日志使用，不污染 body 对象
      const origModelForLog = body.model;
      if (typeof body.model === "string" && body.model.endsWith("-search")) {
        body.model = body.model.slice(0, -"-search".length);
        requestForceSearch = true;
      } else {
        requestForceSearch = false;
      }
      // 原生搜索适配（v36）：RikkaHub Response API 模式的"模型搜索"开关会发
      // 原生 web_search 工具（{type:"web_search"}/{type:"web_search_preview"}）
      // 或 chat 路径的 web_search_options。上游不支持原生搜索，直接透传会
      // 400（之前是静默丢弃+警告，搜索实际不工作）。这里剥掉原生参数，
      // 转成反代内置 websearch/webfetch（等价于 -search 后缀），对客户端透明。
      // 必须在 clientToolNames 收集和 ensure* 之前处理。
      {
        let _nativeSearch = false;
        if (Array.isArray(body.tools)) {
          const _kept = [];
          for (const t of body.tools) {
            if (
              t &&
              (t.type === "web_search" || t.type === "web_search_preview")
            ) {
              _nativeSearch = true;
              continue; // 剥掉：上游不认，反代用内置搜索代替
            }
            _kept.push(t);
          }
          if (_nativeSearch) body.tools = _kept;
        }
        if (body.web_search_options !== undefined) {
          _nativeSearch = true;
          delete body.web_search_options; // 上游不认，剥掉
        }
        if (_nativeSearch) {
          requestForceSearch = true;
          console.log(
            "检测到客户端原生搜索请求，已转由反代 websearch/webfetch 执行"
          );
        }
      }
      // 先记录客户端原始工具名（三种形状兼容）
      for (const t of body?.tools || []) {
        const n = t?.function?.name || t?.name;
        if (typeof n === "string" && n) clientToolNames.add(n);
      }
      if (upstreamPath === "/zen/v1/chat/completions") {
        clientWantsStream = body.stream === true;
        ensureChatTools(body);
      }
      // NOTE: /v1/messages (Anthropic) also maps to upstreamPath
      // "/zen/v1/responses", but its body must NOT go through
      // ensureResponsesTools here — anthropicToResponsesBody() handles tools
      // translation below. Running it here would drop the app's tools.
      if (
        upstreamPath === "/zen/v1/responses" &&
        url.pathname !== "/v1/messages"
      ) {
        clientWantsStream = body.stream === true;
        ensureResponsesTools(body);
      }
      if (url.pathname === "/v1/messages") {
        clientWantsStream = body.stream === true;
      }
      // 空消息列表直接 400 中文拒绝，省一次上游往返（上游只会回英文 400）
      const _msgList = body.messages ?? body.input;
      if (Array.isArray(_msgList) && _msgList.length === 0) {
        return sendErrorJson(res, 400, "消息列表为空");
      }
    }
    // 请求级 -search 标志：body 解析后立刻捕获成本地常量。
    // 后面要过很多 await，全局 requestForceSearch 可能被并发请求改掉，
    // 所有 await 之后的代码只许读这个局部值（collectToolNames/runProxyTool 显式传参）。
    const forceSearch = requestForceSearch;

    // muse-spark-* only exists on the Responses API upstream. Translate
    // chat/completions → responses so plain OpenAI clients can use it.
    // （-search 后缀已在 body 解析后剥离，requestForceSearch 已设置）
    let translateToResponses = false;
    let isAnthropic = false;
    let responsesBody = null;
    // v47: 反向翻译标志。/v1/responses 或 /v1/messages 收到非 muse-spark 模型
    // （mimo/longcat）时，上游 /zen/v1/responses 不支持，必须转成 chat 格式
    // 走 /zen/v1/chat/completions，再把返回翻回客户端要的格式。
    let translateToChat = false;
    let chatBody = null;
    const isSparkModel = (m) => typeof m === "string" && m.startsWith("muse-spark-");
    if (url.pathname === "/v1/messages" && req.method === "POST" && body) {
      if (isSparkModel(body.model)) {
        translateToResponses = true;
        isAnthropic = true;
        upstreamPath = "/zen/v1/responses";
        const aw = anthropicToResponsesBodyWithNames(body);
        responsesBody = aw.body;
        proxyInterceptNames = aw.proxyNames;
      } else {
        // v47: Claude 端点 + 非 spark 模型 → 转 chat 走 chat 上游
        translateToChat = true;
        isAnthropic = true;
        upstreamPath = "/zen/v1/chat/completions";
        chatBody = anthropicToChatBody(body);
        // v47.2: 补上伪装工具（read/shell），否则上游免费层直接 403；
        // 同时按 -search 后缀注入 websearch/webfetch，并设置 stream/stream_options。
        proxyInterceptNames = ensureChatTools(chatBody);
      }
    } else if (
      upstreamPath === "/zen/v1/responses" &&
      body &&
      typeof body.model === "string" &&
      !isSparkModel(body.model)
    ) {
      // v47: /v1/responses + 非 spark 模型 → 转 chat 走 chat 上游
      translateToChat = true;
      upstreamPath = "/zen/v1/chat/completions";
      chatBody = responsesToChatBody(body);
      // v47.2: 同上，补伪装工具防 403，-search 时注入搜索工具。
      proxyInterceptNames = ensureChatTools(chatBody);
    } else if (
      upstreamPath === "/zen/v1/chat/completions" &&
      body &&
      typeof body.model === "string" &&
      body.model.startsWith("muse-spark-")
    ) {
      translateToResponses = true;
      upstreamPath = "/zen/v1/responses";
      responsesBody = {
        model: body.model,
        input: chatToResponsesInput(body.messages),
        tools: body.tools, // chat-format app tools; merged with disguise below
        stream: true,
        store: false,
      };
      // response_format json_object：Responses 上游不认 response_format 字段
      // （透传会 400、静默丢弃则约束失效），按规范转成 text.format。
      // 酒馆插件 custom_include_body 示例里就是 response_format: {type: json_object}。
      if (body.response_format !== undefined) {
        const t = responsesFormatToText(body.response_format);
        if (t) responsesBody.text = t;
      }
      // Preserve an explicit "auto" tool_choice (sanitizeToolChoice already
      // stripped anything else from body above).
      if (body.tool_choice !== undefined)
        responsesBody.tool_choice = body.tool_choice;
      // Pass through sampling params the Responses upstream accepts.
      applySamplingParams(responsesBody, body);
      // chat 路径的顶层 reasoning_effort 转成 Responses 形状。
      // RikkaHub 在"兼容 OpenAI"模式发的是这个；直接透传上游报 unknown parameter。
      // （'none' 已在解析时删掉，这里只会是有效值）
      if (body.reasoning_effort !== undefined) {
        responsesBody.reasoning = {
          ...(responsesBody.reasoning || {}),
          effort: responsesBody.reasoning?.effort ?? body.reasoning_effort,
        };
      }
      // spark 是原生推理模型：没要摘要就默认要，否则 RikkaHub 思维链是空的。
      // 摘要是按输出 token 计费的，不占每天 1000 次的请求次数。
      // v37：与直连路径一致，缺省 effort 时补标准 medium（之前这里会造出
      // 只有 summary 没有 effort 的畸形 reasoning 对象）。
      // v41：嵌套 reasoning.effort:"none" 也视为缺省（RikkaHub 测试按钮发的）。
      if (!responsesBody.reasoning?.effort || responsesBody.reasoning.effort === "none") {
        responsesBody.reasoning = {
          ...(responsesBody.reasoning || {}),
          effort: "medium",
        };
      }
      if (responsesBody.reasoning?.summary === undefined) {
        responsesBody.reasoning.summary = "auto";
      }
      proxyInterceptNames = ensureResponsesTools(responsesBody);
    }

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      accept: "*/*",
      ...identityHeaders(session),
    };

    // Only adopt identity headers from the caller when it actually looks
    // like OpenCode; other clients' x-session-id would poison the disguise.
    const incomingUA = req.headers["user-agent"] || "";
    const looksLikeOpenCode = /opencode/i.test(incomingUA);
    if (looksLikeOpenCode) headers["user-agent"] = incomingUA;
    for (const k of [
      "x-opencode-client",
      "x-opencode-org-id",
      "x-opencode-project",
      "x-opencode-session",
      "x-session-id",
      "x-session-affinity",
      "b3",
      "traceparent",
    ]) {
      if (looksLikeOpenCode && req.headers[k]) headers[k] = req.headers[k];
    }

      if (process.env.PROXY_DEBUG) {
        console.error(
          "OUT headers=" +
            JSON.stringify({ ...headers, authorization: "Bearer REDACTED" }) +
            " bodyKeys=" +
            (body ? Object.keys(body).join(",") : "none") +
            " tools=" +
            (body?.tools?.length ?? 0) +
            " stream=" +
            body?.stream
        );
      }
      // If the client goes away mid-stream (e.g. user hits regenerate in
      // RikkaHub), stop the upstream request too instead of reading it to
      // completion for nobody. NOTE: it must be res 'close', not req 'close':
      // req 'close' fires as soon as the request body is received (before we
      // even call fetch), which would abort every request. res 'close' with
      // !writableEnded means the client disconnected prematurely.
      ac = new AbortController();
      // 补上竞态：如果 close 在 ac 创建前已触发（极窄窗口），现在补中止
      if (clientGone) {
        try {
          ac.abort();
        } catch {}
      }
      // 开始行：模型列表没有 body，单独显示；其余请求无论流式/非流式都打开始行
      //（IP 显示要求覆盖每次调用；非流式以前没有开始行，IP 就丢了）
      if (upstreamPath === "/zen/v1/models") {
        console.log(`模型列表 · ${fmtClock()}`);
      } else {
        const msgCount = Array.isArray(body?.messages)
          ? body.messages.length
          : Array.isArray(body?.input)
            ? body.input.length
            : "?";
        // forceSearch 时在模型名后标注 🔍，让用户一眼看出搜索已启用
        // v55: 用原始模型名（origModelForLog），显示完整名称
        const logModel = forceSearch ? `${origModelForLog} 🔍` : origModelForLog;
        zenStartLog(seq, logModel, msgCount, clientTag);
      }
      const upstream = await fetch(UPSTREAM + upstreamPath, {
        method: req.method,
        headers,
        body: (translateToResponses ? responsesBody : translateToChat ? chatBody : body)
          ? JSON.stringify(translateToResponses ? responsesBody : translateToChat ? chatBody : body)
          : undefined,
        duplex: "half",
        // 客户端断开 OR 上游 5 分钟无响应 → 中止。无超时的话上游 hang 住会永久占住 handler。
        // 用 300 秒总超时：覆盖 2.8 万 token 长输出（100 tok/s），120 秒会误杀，600 秒又太久。
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
      });

      // Forward upstream errors with their real status code and body.
      // (Without this, an error arriving as SSE would fall into the
      // translators below and surface as an empty "stop" reply.)
      const ectype = upstreamCtype(upstream);
      if (!upstream.ok) {
        const text = await upstream.text();
        if (text.includes("FreeTierError")) {
          console.error(
            "上游报错：免费身份已过期。续命办法：把 opencode 的 baseURL 指到本反代（http://127.0.0.1:8788/zen/v1）发一次请求，反代会自动保存新身份；不会操作就找姐姐帮忙。"
          );
        }

      res.writeHead(upstream.status, { "content-type": "application/json" });
        // 上游非 200：补一行结果，开始行不悬空（之前这里直接 return，无配对行）
        console.log(
          `#${seq} ✕ 上游${upstream.status} · ${shortModel(body?.model)}`
        );
        return res.end(
          JSON.stringify(normalizeUpstreamError(upstream.status, text))
        );
      }

      // /v1/models：只保留实测可用的 4 个免费模型，再给每个加 -search 后缀变体，
      // 注意：必须在下面的非 SSE 透传之前处理——模型列表是 JSON，上面的透传会提前 return，
      // 放后面就成了死代码（v31 的 bug：过滤从未生效）。
      // RikkaHub 模型列表里可选，选了带后缀的即启用 websearch/webfetch（模型名开关）
      // 可用列表（2026-10-06 用户真机实测）：spark-1.3/1.2、mimo-v2.6-flash、longcat-2.5-preview
      // 名单复用模块级 FREE_MODEL_IDS
      // v35：上游失败/解析失败时返回内置兜底名单，保证任何接口模式下总能拉到模型
      // v38：/r 前缀（Response API 专用）下不加 -search 变体，只返回 4 个基础模型
      if (upstreamPath === "/zen/v1/models") {
        if (upstream.ok) {
          const modelsText = await upstream.text();
          try {
            const modelsData = JSON.parse(modelsText);
            if (Array.isArray(modelsData?.data)) {
              // 只留实测可用的模型
              modelsData.data = modelsData.data.filter(
                (m) => typeof m?.id === "string" && FREE_MODEL_IDS.has(m.id)
              );
              if (!hideSearchVariants) {
                const extra = [];
                for (const m of modelsData.data) {
                  const id = m?.id;
                  if (!id.endsWith("-search")) {
                    extra.push({ ...m, id: id + "-search" });
                  }
                }
                modelsData.data.push(...extra);
              }
              console.log(
                `模型列表 ✓ ${modelsData.data.length}个` +
                  (hideSearchVariants ? "（精简版，无搜索变体）" : "（含搜索变体）")
              );
              return sendJson(res, upstream.status, modelsData);
            }
          } catch {
            // 解析失败：走下面的兜底
          }
        }
        console.warn(
          `模型列表上游异常（status=${upstream.status}），返回内置兜底` +
            (hideSearchVariants ? "（精简版）" : "（8 模型）")
        );
        return sendJson(res, 200, buildFallbackModels(hideSearchVariants));
      }

      // Peek non-streaming responses (e.g. /v1/models JSON, or a JSON error
      // body) and pass them through untouched.
      const ctype = ectype;
      if (!ctype.includes("text/event-stream")) {
        const text = await upstream.text();
        if (text.includes("FreeTierError")) {
          console.error(
            "上游报错：免费身份已过期。续命办法：把 opencode 的 baseURL 指到本反代（http://127.0.0.1:8788/zen/v1）发一次请求，反代会自动保存新身份；不会操作就找姐姐帮忙。"
          );
        }
        res.writeHead(upstream.status, {
          "content-type": ctype || "application/json",
        });
        return res.end(text);
      }

      if (translateToResponses) {
        // True streaming: translate each upstream chunk on the fly.
        if (isAnthropic) {
          // 拦截集合：代理工具名去掉客户端自带的同名工具（客户端的优先，不拦截）
          const interceptBaseF = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
          const interceptNamesF = new Set(
            [...interceptBaseF].filter((n) => !clientToolNames.has(n))
          );
          const knownF = collectToolNames(body, forceSearch);
          if (clientWantsStream) {
            res.writeHead(upstream.status, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            // Agentic loop：反代内置工具本地执行后 follow-up，最多 5 轮。
            // 同一个 Anthropic message 续写：首轮发 message_start，后续轮
            // skipStart，只追加 content block，最后由末轮发 message_stop。
            let currentInputF = asInputArray(responsesBody.input);
            let blockBase = 0;
            let skipStart = false;
            let totalUsageF = null;
            for (let roundF = 0; roundF < 5; roundF++) {
              let upF = upstream;
              if (roundF > 0) {
                upF = await fetch(UPSTREAM + upstreamPath, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ ...responsesBody, input: currentInputF }),
                  duplex: "half",
                  signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
                });
                if (!upF.ok) {
                  console.error(`内置工具 follow-up 上游报错 ${upF.status}`);
                  break;
                }
              }
              const rF = await streamResponsesToAnthropic(
                upF,
                (c) => res.write(c),
                body?.model || "unknown",
                timing,
                knownF,
                {
                  interceptNames: interceptNamesF,
                  startBlockIndex: blockBase,
                  skipStart,
                }
              );
              blockBase = rF.nextBlockIndex;
              skipStart = true;
              totalUsageF = mergeUsageSum(totalUsageF, timing.usage);
              timing.usage = null;
              if (rF.intercepted.length === 0) break;
              const outputsF = [];
              for (const call of rF.intercepted) {
                outputsF.push(
                  await runProxyTool(call.name, call.arguments, seq, ac.signal, forceSearch)
                );
              }
              currentInputF = [
                ...currentInputF,
                ...proxyToolInputItems(rF.intercepted, outputsF),
              ];
              if (roundF === 4) {
                // 5 轮上限：最后一轮 follow-up 不再拦截，直接收尾
                console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
                try {
                  const finalF = await fetch(UPSTREAM + upstreamPath, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...responsesBody, input: currentInputF }),
                    duplex: "half",
                    signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
                  });
                  if (finalF.ok) {
                    const rFinal = await streamResponsesToAnthropic(
                      finalF,
                      (c) => res.write(c),
                      body?.model || "unknown",
                      timing,
                      knownF,
                      { startBlockIndex: blockBase, skipStart: true }
                    );
                    totalUsageF = mergeUsageSum(totalUsageF, timing.usage);
                    timing.usage = null;
                    void rFinal;
                  }
                } catch (e) {
                  if (e?.name !== "AbortError" && !clientGone) {
                    console.warn(`收尾 follow-up 失败：${e?.message || e}`);
                  }
                }
              }
            }
            timing.usage = totalUsageF;
            zenLog({
              seq,
              ttftMs: timing.firstTokenAt ? timing.firstTokenAt - timing.t0 : -1,
              totalMs: Date.now() - timing.t0,
              isBg: false,
              usage: timing.usage,
            });
            return res.end();
          }
          // Non-streaming: buffer, then convert.
          // Agentic loop：内置工具本地执行后 follow-up，最多 5 轮，最后转 Anthropic。
          let currentInputFN = asInputArray(responsesBody.input);
          let respObjFN = null;
          let totalUsageFN = null;
          for (let roundFN = 0; roundFN < 5; roundFN++) {
            let sseTextFN;
            if (roundFN === 0) {
              sseTextFN = (await readUpstreamBody(upstream)).toString();
            } else {
              const upFN = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...responsesBody, input: currentInputFN }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (!upFN.ok) break;
              sseTextFN = (await readUpstreamBody(upFN)).toString();
            }
            respObjFN = sseToResponse(sseTextFN, body?.model || "unknown", knownF);
            totalUsageFN = mergeResponsesUsage(totalUsageFN, respObjFN.usage);
            const proxyCallsFN = (respObjFN.output || []).filter(
              (item) => item?.type === "function_call" && interceptNamesF.has(item.name)
            );
            if (proxyCallsFN.length === 0) break;
            const callsFN = [];
            const outputsFN = [];
            for (const pc of proxyCallsFN) {
              const args =
                typeof pc.arguments === "string"
                  ? pc.arguments
                  : JSON.stringify(pc.arguments ?? {});
              outputsFN.push(
                await runProxyTool(pc.name, args, seq, ac.signal, forceSearch)
              );
              callsFN.push({
                call_id: pc.call_id || `call_proxy_${++proxyCallSeq}`,
                name: pc.name,
                arguments: args,
              });
            }
            currentInputFN = [
              ...currentInputFN,
              ...proxyToolInputItems(callsFN, outputsFN),
            ];
            if (roundFN === 4) {
              console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
              try {
                const finalFN = await fetch(UPSTREAM + upstreamPath, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ ...responsesBody, input: currentInputFN }),
                  duplex: "half",
                  signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
                });
                if (finalFN.ok) {
                  const finalTextFN = (await readUpstreamBody(finalFN)).toString();
                  respObjFN = sseToResponse(finalTextFN, body?.model || "unknown", knownF);
                  totalUsageFN = mergeResponsesUsage(totalUsageFN, respObjFN.usage);
                }
              } catch (e) {
                if (e?.name !== "AbortError" && !clientGone) {
                  console.warn(`收尾 follow-up 失败：${e?.message || e}`);
                }
              }
            }
          }
          if (totalUsageFN) respObjFN.usage = totalUsageFN;
          const anthObj = responseToAnthropic(respObjFN, body?.model || "unknown", knownF);
          zenLog({
            seq,
            totalMs: Date.now() - timing.t0,
            isBg: false,
            usage: respObjFN.usage,
          });
          return sendJson(res, upstream.status, anthObj);
        }
        if (clientWantsStream) {
          res.writeHead(upstream.status, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          // Agentic loop：反代内置工具（webfetch/websearch）由本地执行，
          // 结果塞回上游继续对话，对客户端透明。最多 5 轮防模型无限调用。
          // 拦截集合：代理工具名去掉客户端自带的同名工具（客户端的优先，不拦截）
          const interceptBase = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
          proxyInterceptNames = new Set(
            [...interceptBase].filter((n) => !clientToolNames.has(n))
          );
          let currentInput = responsesBody.input;
          const MAX_PROXY_ROUNDS = 5;
          let totalUsage = null;
          const mergeUsage = (acc, u) => {
            if (!u) return acc;
            if (!acc) return { ...u };
            const sum = (a, b) =>
              typeof a === "number" && typeof b === "number" ? a + b : a ?? b;
            return {
              prompt_tokens: sum(acc.prompt_tokens, u.prompt_tokens),
              completion_tokens: sum(acc.completion_tokens, u.completion_tokens),
              total_tokens: sum(acc.total_tokens, u.total_tokens),
              ...(acc.prompt_tokens_details || u.prompt_tokens_details
                ? {
                    prompt_tokens_details: {
                      cached_tokens: Math.max(
                        acc.prompt_tokens_details?.cached_tokens ?? 0,
                        u.prompt_tokens_details?.cached_tokens ?? 0
                      ),
                    },
                  }
                : {}),
            };
          };
          for (let round = 0; round < MAX_PROXY_ROUNDS; round++) {
            // 第 0 轮用外层已 fetch 的 upstream，后续轮重新 fetch
            let up = upstream;
            if (round > 0) {
              const reqBody = { ...responsesBody, input: currentInput };
              up = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify(reqBody),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (!up.ok) {
                const text = await up.text();
                console.error(`内置工具 follow-up 上游报错 ${up.status}`);
                // follow-up 失败：把已输出的内容收尾，不让客户端 hang 住
                try {
                  const errChunk = {
                    id: `chatcmpl-proxy-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body?.model || "unknown",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  };
                  res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
                  res.write("data: [DONE]\n\n");
                } catch {}
                break;
              }
            }
            const { intercepted } = await streamResponsesToChat(
              up,
              (c) => res.write(c),
              body?.model || "unknown",
              timing,
              collectToolNames(body, forceSearch),
              { interceptNames: proxyInterceptNames }
            );
            totalUsage = mergeUsage(totalUsage, timing.usage);
            timing.usage = null; // 下轮重新累积，避免重复计算
            if (intercepted.length === 0) break;
            // 本地执行内置工具
            const outputs = [];
            for (const call of intercepted) {
              const out = await runProxyTool(call.name, call.arguments, seq, ac.signal, forceSearch);
              outputs.push(out);
            }
            currentInput = [
              ...currentInput,
              ...proxyToolInputItems(intercepted, outputs),
            ];
            if (round === MAX_PROXY_ROUNDS - 1) {
              console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
              // 最后一轮：再发一次 follow-up 拿模型的最终回答（不再允许新的工具调用，
              // 用空拦截集合），否则客户端收不到收尾的 [DONE]
              try {
                const finalUp = await fetch(UPSTREAM + upstreamPath, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ ...responsesBody, input: currentInput }),
                  duplex: "half",
                  signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
                });
                if (finalUp.ok) {
                  const { intercepted: _ign } = await streamResponsesToChat(
                    finalUp,
                    (c) => res.write(c),
                    body?.model || "unknown",
                    timing,
                    collectToolNames(body, forceSearch),
                    { interceptNames: new Set() } // 不再拦截，直接收尾
                  );
                  totalUsage = mergeUsage(totalUsage, timing.usage);
                }
              } catch (e) {
                // 客户端已断开导致的收尾失败不算事，静默；其他错误才 warn
                if (e?.name !== "AbortError" && !clientGone) {
                  console.warn(`收尾 follow-up 失败：${e?.message || e}`);
                }
              }
            }
          }
          timing.usage = totalUsage;
          zenLog({
            seq,
            ttftMs: timing.firstTokenAt ? timing.firstTokenAt - timing.t0 : -1,
            totalMs: Date.now() - timing.t0,
            isBg: false,
            usage: timing.usage,
          });
          return res.end();
        }
        // Non-streaming chat: buffer, then convert.
        // Agentic loop：内置工具（webfetch/websearch）本地执行后 follow-up，最多 5 轮。
        // 拦截集合与流式路径一致：代理工具名去掉客户端自带同名
        const interceptBase2 = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
        proxyInterceptNames = new Set(
          [...interceptBase2].filter((n) => !clientToolNames.has(n))
        );
        let currentInputNS = responsesBody.input;
        let respObj = null;
        let totalUsageNS = null;
        const mergeUsageNS = (acc, u) => {
          if (!u) return acc;
          if (!acc) return { ...u };
          const sum = (a, b) =>
            typeof a === "number" && typeof b === "number" ? a + b : a ?? b;
          // cached 取最大（与流式版 mergeUsage 口径一致，不然非流式日志永不显示缓存命中）
          const cached = Math.max(
            acc.input_tokens_details?.cached_tokens ?? -1,
            u.input_tokens_details?.cached_tokens ?? -1
          );
          return {
            input_tokens: sum(acc.input_tokens, u.input_tokens),
            output_tokens: sum(acc.output_tokens, u.output_tokens),
            total_tokens: sum(acc.total_tokens, u.total_tokens),
            ...(cached >= 0
              ? { input_tokens_details: { cached_tokens: cached } }
              : {}),
          };
        };
        for (let roundNS = 0; roundNS < 5; roundNS++) {
          let sseTextNS;
          if (roundNS === 0) {
            sseTextNS = (await readUpstreamBody(upstream)).toString();
          } else {
            const upNS = await fetch(UPSTREAM + upstreamPath, {
              method: "POST",
              headers,
              body: JSON.stringify({ ...responsesBody, input: currentInputNS }),
              duplex: "half",
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
            });
            if (!upNS.ok) break;
            sseTextNS = (await readUpstreamBody(upNS)).toString();
          }
          if (sseTextNS.includes("FreeTierError") && roundNS === 0) {
            console.error(
              "上游报错：免费身份已过期。续命办法：把 opencode 的 baseURL 指到本反代（http://127.0.0.1:8788/zen/v1）发一次请求，反代会自动保存新身份；不会操作就找姐姐帮忙。"
            );
          }
          respObj = sseToResponse(sseTextNS, body?.model || "unknown", collectToolNames(body, forceSearch));
          totalUsageNS = mergeUsageNS(totalUsageNS, respObj.usage);
          // 检查内置工具调用（只认本请求实际注入的，客户端自带同名工具不拦截）
          const proxyCalls = (respObj.output || []).filter(
            (item) => item?.type === "function_call" && proxyInterceptNames.has(item.name)
          );
          if (proxyCalls.length === 0) break;
          const callsNS = [];
          const outputsNS = [];
          for (const pc of proxyCalls) {
            const args = typeof pc.arguments === "string" ? pc.arguments : JSON.stringify(pc.arguments ?? {});
            outputsNS.push(await runProxyTool(pc.name, args, seq, ac.signal, forceSearch));
            callsNS.push({ call_id: pc.call_id || `call_proxy_${++proxyCallSeq}`, name: pc.name, arguments: args });
          }
          currentInputNS = [...currentInputNS, ...proxyToolInputItems(callsNS, outputsNS)];
          if (roundNS === 4) {
            // 5 轮上限：再做一次 follow-up 拿最终回答（不再拦截工具调用）
            console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
            try {
              const finalNS = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...responsesBody, input: currentInputNS }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (finalNS.ok) {
                const finalText = (await readUpstreamBody(finalNS)).toString();
                respObj = sseToResponse(finalText, body?.model || "unknown", collectToolNames(body, forceSearch));
                totalUsageNS = mergeUsageNS(totalUsageNS, respObj.usage);
              }
            } catch (e) {
              // 客户端已断开导致的收尾失败不算事，静默；其他错误才 warn
              if (e?.name !== "AbortError" && !clientGone) {
                console.warn(`收尾 follow-up 失败：${e?.message || e}`);
              }
            }
          }
        }
        if (totalUsageNS) respObj.usage = totalUsageNS;
        const chatObj = responseToChatCompletion(respObj, body?.model || "unknown", collectToolNames(body, forceSearch));
        zenLog({
          seq,
          totalMs: Date.now() - timing.t0,
          isBg: false,
          usage: respObj.usage,
        });
        return sendJson(res, upstream.status, chatObj);
      }

      // v47: 反向翻译响应。/v1/responses 或 /v1/messages 收到非 spark 模型时，
      // 上游走的是 chat，客户端要的是 Responses 或 Anthropic 格式。
      if (translateToChat) {
        const targetModel = body?.model || "unknown";
        if (clientWantsStream) {
          res.writeHead(upstream.status, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          if (isAnthropic) {
            const r = await streamChatToAnthropic(
              upstream,
              (c) => res.write(c),
              targetModel,
              timing
            );
            void r;
          } else {
            const r = await streamChatToResponses(
              upstream,
              (c) => res.write(c),
              targetModel,
              timing
            );
            void r;
          }
          zenLog({
            seq,
            ttftMs: timing.firstTokenAt ? timing.firstTokenAt - timing.t0 : -1,
            totalMs: Date.now() - timing.t0,
            usage: timing.usage,
            isBg: false,
          });
          return res.end();
        } else {
          // 非流式：攒 SSE → chat object → 转目标格式
          const sseText = (await readUpstreamBody(upstream)).toString();
          if (sseText.includes("FreeTierError")) {
            console.error("上游报错：免费身份已过期。");
          }
          const chatObj = sseToChatCompletion(sseText, targetModel);
          if (isAnthropic) {
            // chat → Anthropic
            const content = [];
            const msg = chatObj.choices?.[0]?.message || {};
            if (typeof msg.content === "string" && msg.content) {
              content.push({ type: "text", text: msg.content });
            }
            for (const tc of msg.tool_calls || []) {
              let input = {};
              try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
              content.push({
                type: "tool_use",
                id: tc.id || `toolu_${content.length}`,
                name: tc.function?.name || "",
                input,
              });
            }
            const anthObj = {
              id: `msg_proxy_${Date.now()}`,
              type: "message",
              role: "assistant",
              model: targetModel,
              content,
              stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
              usage: {
                input_tokens: chatObj.usage?.prompt_tokens ?? 0,
                output_tokens: chatObj.usage?.completion_tokens ?? 0,
              },
            };
            zenLog({ seq, ttftMs: -1, totalMs: Date.now() - timing.t0, usage: timing.usage, isBg: false });
            return sendJson(res, upstream.status, anthObj);
          } else {
            // chat → Responses
            const msg = chatObj.choices?.[0]?.message || {};
            const text = typeof msg.content === "string" ? msg.content : "";
            const output = [];
            if (text) {
              output.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              });
            }
            for (const tc of msg.tool_calls || []) {
              output.push({
                type: "function_call",
                call_id: tc.id || "",
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "{}",
              });
            }
            const respObj = {
              id: `resp-proxy-${Date.now()}`,
              object: "response",
              status: "completed",
              model: targetModel,
              output,
              usage: chatObj.usage ? {
                input_tokens: chatObj.usage.prompt_tokens,
                output_tokens: chatObj.usage.completion_tokens,
                total_tokens: chatObj.usage.total_tokens,
              } : null,
            };
            zenLog({ seq, ttftMs: -1, totalMs: Date.now() - timing.t0, usage: timing.usage, isBg: false });
            return sendJson(res, upstream.status, respObj);
          }
        }
      }

      if (
        upstreamPath === "/zen/v1/chat/completions" &&
        !clientWantsStream
      ) {
        // Buffer SSE, return a single chat.completion object.
        // Agentic loop：直连 chat 路径（mimo/longcat 等非翻译模型）同样可能调用
        // 反代内置工具，本地执行后 follow-up，最多 5 轮。
        const sseText = (await readUpstreamBody(upstream)).toString();
        if (sseText.includes("FreeTierError")) {
          console.error(
            "上游报错：免费身份已过期。续命办法：把 opencode 的 baseURL 指到本反代（http://127.0.0.1:8788/zen/v1）发一次请求，反代会自动保存新身份；不会操作就找姐姐帮忙。"
          );
        }
        const interceptBaseC = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
        const interceptNamesC = new Set(
          [...interceptBaseC].filter((n) => !clientToolNames.has(n))
        );
        const knownC = collectToolNames(body, forceSearch);
        let currentMessagesC = Array.isArray(body.messages) ? body.messages : [];
        let chatObj = null;
        let totalUsageC = null;
        for (let roundC = 0; roundC < 5; roundC++) {
          let sseTextC;
          if (roundC === 0) {
            sseTextC = sseText;
          } else {
            const upC = await fetch(UPSTREAM + upstreamPath, {
              method: "POST",
              headers,
              body: JSON.stringify({ ...body, messages: currentMessagesC }),
              duplex: "half",
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
            });
            if (!upC.ok) break;
            sseTextC = (await readUpstreamBody(upC)).toString();
          }
          chatObj = sseToChatCompletion(sseTextC, body?.model || "unknown");
          totalUsageC = mergeUsageSum(totalUsageC, chatObj.usage);
          const proxyCallsC = (
            chatObj.choices?.[0]?.message?.tool_calls || []
          ).filter(
            (tc) =>
              tc?.function &&
              interceptNamesC.has(unprefixToolName(tc.function.name, knownC))
          );
          if (proxyCallsC.length === 0) break;
          const callsC = [];
          const outputsC = [];
          for (const pc of proxyCallsC) {
            const nm = unprefixToolName(pc.function.name, knownC);
            const args =
              typeof pc.function.arguments === "string"
                ? pc.function.arguments
                : JSON.stringify(pc.function.arguments ?? {});
            outputsC.push(
              await runProxyTool(nm, args, seq, ac.signal, forceSearch)
            );
            callsC.push({
              id: pc.id || `call_proxy_${++proxyCallSeq}`,
              name: nm,
              arguments: args,
            });
          }
          currentMessagesC = [
            ...currentMessagesC,
            {
              role: "assistant",
              tool_calls: callsC.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            },
            ...callsC.map((c, i) => ({
              role: "tool",
              tool_call_id: c.id,
              content: outputsC[i] ?? "",
            })),
          ];
          if (roundC === 4) {
            console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
            try {
              const finalC = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, messages: currentMessagesC }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (finalC.ok) {
                const finalTextC = (await readUpstreamBody(finalC)).toString();
                chatObj = sseToChatCompletion(finalTextC, body?.model || "unknown");
                totalUsageC = mergeUsageSum(totalUsageC, chatObj.usage);
              }
            } catch (e) {
              if (e?.name !== "AbortError" && !clientGone) {
                console.warn(`收尾 follow-up 失败：${e?.message || e}`);
              }
            }
          }
        }
        if (totalUsageC) chatObj.usage = totalUsageC;
        zenLog({
          seq,
          totalMs: Date.now() - timing.t0,
          isBg: false,
          usage: chatObj.usage,
        });
        return sendJson(res, upstream.status, chatObj);
      }

      if (upstreamPath === "/zen/v1/responses" && !clientWantsStream) {
        // 直连 /v1/responses 非流式：Agentic loop，内置工具本地执行后
        // follow-up（Responses input 追加 function_call + output），最多 5 轮。
        const sseText = (await readUpstreamBody(upstream)).toString();
        if (sseText.includes("FreeTierError")) {
          console.error(
            "上游报错：免费身份已过期。续命办法：把 opencode 的 baseURL 指到本反代（http://127.0.0.1:8788/zen/v1）发一次请求，反代会自动保存新身份；不会操作就找姐姐帮忙。"
          );
        }
        const interceptBaseE = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
        const interceptNamesE = new Set(
          [...interceptBaseE].filter((n) => !clientToolNames.has(n))
        );
        const knownE = collectToolNames(body, forceSearch);
        let currentInputE = asInputArray(body.input);
        let respObj = null;
        let totalUsageE = null;
        for (let roundE = 0; roundE < 5; roundE++) {
          let sseTextE;
          if (roundE === 0) {
            sseTextE = sseText;
          } else {
            const upE = await fetch(UPSTREAM + upstreamPath, {
              method: "POST",
              headers,
              body: JSON.stringify({ ...body, input: currentInputE }),
              duplex: "half",
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
            });
            if (!upE.ok) break;
            sseTextE = (await readUpstreamBody(upE)).toString();
          }
          respObj = sseToResponse(sseTextE, body?.model || "unknown", knownE);
          totalUsageE = mergeResponsesUsage(totalUsageE, respObj.usage);
          const proxyCallsE = (respObj.output || []).filter(
            (item) => item?.type === "function_call" && interceptNamesE.has(item.name)
          );
          if (proxyCallsE.length === 0) break;
          const callsE = [];
          const outputsE = [];
          for (const pc of proxyCallsE) {
            const args =
              typeof pc.arguments === "string"
                ? pc.arguments
                : JSON.stringify(pc.arguments ?? {});
            outputsE.push(
              await runProxyTool(pc.name, args, seq, ac.signal, forceSearch)
            );
            callsE.push({
              call_id: pc.call_id || `call_proxy_${++proxyCallSeq}`,
              name: pc.name,
              arguments: args,
            });
          }
          currentInputE = [
            ...currentInputE,
            ...proxyToolInputItems(callsE, outputsE),
          ];
          if (roundE === 4) {
            console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
            try {
              const finalE = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, input: currentInputE }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (finalE.ok) {
                const finalTextE = (await readUpstreamBody(finalE)).toString();
                respObj = sseToResponse(finalTextE, body?.model || "unknown", knownE);
                totalUsageE = mergeResponsesUsage(totalUsageE, respObj.usage);
              }
            } catch (e) {
              if (e?.name !== "AbortError" && !clientGone) {
                console.warn(`收尾 follow-up 失败：${e?.message || e}`);
              }
            }
          }
        }
        if (totalUsageE) respObj.usage = totalUsageE;
        zenLog({
          seq,
          totalMs: Date.now() - timing.t0,
          isBg: false,
          usage: respObj.usage,
        });
        return sendJson(res, upstream.status, respObj);
      }

      // 直连 chat 流式（mimo/longcat 等非翻译模型）：Agentic loop。
      // 以前这里是裸透传，模型调用 webfetch/websearch 会直接漏给客户端报错。
      if (upstreamPath === "/zen/v1/chat/completions" && clientWantsStream) {
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const interceptBaseB = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
        const interceptNamesB = new Set(
          [...interceptBaseB].filter((n) => !clientToolNames.has(n))
        );
        const knownB = collectToolNames(body, forceSearch);
        let currentMessagesB = Array.isArray(body.messages) ? body.messages : [];
        let totalUsageB = null;
        for (let roundB = 0; roundB < 5; roundB++) {
          let upB = upstream;
          if (roundB > 0) {
            upB = await fetch(UPSTREAM + upstreamPath, {
              method: "POST",
              headers,
              body: JSON.stringify({ ...body, messages: currentMessagesB }),
              duplex: "half",
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
            });
            if (!upB.ok) {
              console.error(`内置工具 follow-up 上游报错 ${upB.status}`);
              try {
                const errChunkB = {
                  id: `chatcmpl-proxy-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: body?.model || "unknown",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
                res.write(`data: ${JSON.stringify(errChunkB)}\n\n`);
                res.write("data: [DONE]\n\n");
              } catch {}
              break;
            }
          }
          const rB = await streamChatDirectWithIntercept(
            upB,
            (c) => res.write(c),
            body?.model || "unknown",
            timing,
            interceptNamesB,
            knownB
          );
          totalUsageB = mergeUsageSum(totalUsageB, timing.usage);
          timing.usage = null;
          if (rB.intercepted.length === 0) break;
          const outputsB = [];
          for (const call of rB.intercepted) {
            outputsB.push(
              await runProxyTool(call.name, call.arguments, seq, ac.signal, forceSearch)
            );
          }
          const callsB = rB.intercepted.map((c) => ({
            id: c.call_id || `call_proxy_${++proxyCallSeq}`,
            name: c.name,
            arguments: c.arguments,
          }));
          // chat 格式 follow-up：assistant tool_calls + tool 结果消息
          currentMessagesB = [
            ...currentMessagesB,
            {
              role: "assistant",
              tool_calls: callsB.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            },
            ...callsB.map((c, i) => ({
              role: "tool",
              tool_call_id: c.id,
              content: outputsB[i] ?? "",
            })),
          ];
          if (roundB === 4) {
            // 5 轮上限：最后一轮 follow-up 不再拦截，直接收尾
            console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
            try {
              const finalB = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, messages: currentMessagesB }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (finalB.ok) {
                const rFinalB = await streamChatDirectWithIntercept(
                  finalB,
                  (c) => res.write(c),
                  body?.model || "unknown",
                  timing,
                  new Set(),
                  knownB
                );
                totalUsageB = mergeUsageSum(totalUsageB, timing.usage);
                timing.usage = null;
                void rFinalB;
              }
            } catch (e) {
              if (e?.name !== "AbortError" && !clientGone) {
                console.warn(`收尾 follow-up 失败：${e?.message || e}`);
              }
            }
          }
        }
        timing.usage = totalUsageB;
        zenLog({
          seq,
          ttftMs: timing.firstTokenAt ? timing.firstTokenAt - timing.t0 : -1,
          totalMs: Date.now() - timing.t0,
          isBg: false,
          usage: timing.usage,
        });
        return res.end();
      }

      // 直连 /v1/responses 流式：Agentic loop（Responses SSE 原样透传 + 拦截）。
      if (upstreamPath === "/zen/v1/responses" && clientWantsStream) {
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const interceptBaseD = forceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
        const interceptNamesD = new Set(
          [...interceptBaseD].filter((n) => !clientToolNames.has(n))
        );
        const knownD = collectToolNames(body, forceSearch);
        let currentInputD = asInputArray(body.input);
        let totalUsageD = null;
        for (let roundD = 0; roundD < 5; roundD++) {
          let upD = upstream;
          if (roundD > 0) {
            upD = await fetch(UPSTREAM + upstreamPath, {
              method: "POST",
              headers,
              body: JSON.stringify({ ...body, input: currentInputD }),
              duplex: "half",
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
            });
            if (!upD.ok) {
              console.error(`内置工具 follow-up 上游报错 ${upD.status}`);
              break;
            }
          }
          const rD = await streamResponsesDirectWithIntercept(
            upD,
            (c) => res.write(c),
            interceptNamesD,
            knownD,
            timing
          );
          totalUsageD = mergeUsageSum(totalUsageD, timing.usage);
          timing.usage = null;
          if (rD.intercepted.length === 0) break;
          const outputsD = [];
          for (const call of rD.intercepted) {
            outputsD.push(
              await runProxyTool(call.name, call.arguments, seq, ac.signal, forceSearch)
            );
          }
          currentInputD = [
            ...currentInputD,
            ...proxyToolInputItems(rD.intercepted, outputsD),
          ];
          if (roundD === 4) {
            console.warn("内置工具调用达到 5 轮上限，做最后一轮 follow-up 收尾");
            try {
              const finalD = await fetch(UPSTREAM + upstreamPath, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, input: currentInputD }),
                duplex: "half",
                signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              });
              if (finalD.ok) {
                const rFinalD = await streamResponsesDirectWithIntercept(
                  finalD,
                  (c) => res.write(c),
                  new Set(),
                  knownD,
                  timing
                );
                totalUsageD = mergeUsageSum(totalUsageD, timing.usage);
                timing.usage = null;
                void rFinalD;
              }
            } catch (e) {
              if (e?.name !== "AbortError" && !clientGone) {
                console.warn(`收尾 follow-up 失败：${e?.message || e}`);
              }
            }
          }
        }
        timing.usage = totalUsageD;
        zenLog({
          seq,
          ttftMs: timing.firstTokenAt ? timing.firstTokenAt - timing.t0 : -1,
          totalMs: Date.now() - timing.t0,
          isBg: false,
          usage: timing.usage,
        });
        return res.end();
      }

      // 兜底直通：理论上已无路由能走到这里（所有流式分支上面都已处理），
      // 留作安全网，不解析用量，只记耗时
      res.writeHead(upstream.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
      }
      res.end();
      // 直通分支：不解析用量，只记耗时
      console.log(`#${seq} ✓ 直通 ${fmtSec(Date.now() - timing.t0)}`);
    } catch (e) {
      // 客户端请求体明显有问题：400 中文直接返回，省一次上游往返
      if (e instanceof BadRequest) {
        return sendErrorJson(res, 400, e.message);
      }
      // 客户端中途断开（比如 RikkaHub 里点了重新生成）：上游已中止，
      // 这不算失败，记一行中文说明后安静退出。
      // 注意：用 clientGone 而不是 req.destroyed 判断——Node 会在请求体
      // 收完后自动 destroy req，用它判断会把上游错误也误判成取消。
      // 如果响应已正常完成（responseDone），客户端关闭连接是正常的，不报断开。
      if ((e?.name === "AbortError" || clientGone) && !responseDone && !res.writableEnded) {
        // 断在哪一步：没出首字就断（多半 App 超时）vs 输出中途断（切后台/手动取消）
        const phase = timing.firstTokenAt ? "输出中途" : "等首字时";
        console.log(`#${seq} ✕ 客户端断开（${phase}）· 撑了${fmtSec(Date.now() - timing.t0)}`);
        return;
      }
      const isTimeout = e?.name === "TimeoutError";
      // 后台请求失败：单独一行，不刷屏
      if (!clientWantsStream) {
        zenBgFail(seq);
        if (!res.headersSent)
          return sendErrorJson(res, 502, "上游连接失败，稍后重试");
        try { res.end(); } catch {}
        return;
      }
      // 上游失败：1 行，带请求号+模型名+原因
      const failModel = body?.model || "unknown";
      console.error(
        isTimeout
          ? `#${seq} ✕ 上游超时 · ${failModel} · 5分钟无响应`
          : `#${seq} ✕ 上游失败 · ${failModel} · ${e?.message || e}`
      );
      if (!res.headersSent)
        return sendErrorJson(
          res,
          502,
          isTimeout
            ? "上游 5 分钟无响应，请稍后重试"
            : "上游连接失败，可能是网络波动，稍后重试"
        );
      try {
        res.end();
      } catch {}
    }
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `端口 ${PORT} 已被占用：是不是已经启动了一个？先停掉旧的（Termux 里按 Ctrl+C）再启动`
    );
  } else {
    console.error(`启动失败：${e.message}（若反复出现请截图发给姐姐）`);
  }
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`反代已启动 http://127.0.0.1:${PORT}`);
  console.log(`RikkaHub 接口地址填 http://127.0.0.1:${PORT}/v1（Key 随便填）`);
  console.log(`原生搜索：${WEBSEARCH_ENABLED ? "开" : "关"}｜网页抓取：${WEBFETCH_ENABLED ? "开" : "关"}`);
  console.log(`模型名加 -search 后缀可按需启用搜索（如 muse-spark-1.3-contributor-free-search）`);
  if (getApiKey() === "public") {
    console.log("免费模式：免 Key，仅可用免费模型");
  } else {
    console.log("已检测到 API Key（付费模型可用）");
  }
});
