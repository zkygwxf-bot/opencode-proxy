// Cloudflare Workers version of the opencode-zen-proxy.
// Deploy: paste into workers.dev dashboard (Workers & Pages -> Create Worker).
// No build step, no env vars needed. Free tier: 100k requests/day.
//
// What it does (same as proxy.mjs):
//   - Adds OpenCode client identity headers (User-Agent + x-opencode-*)
//   - Injects "read" + "shell" tool definitions the free-tier gate requires
//   - Translates: chat/completions <-> Responses API, Anthropic /v1/messages
//
// RikkaHub: URL https://<your-worker>.workers.dev/v1 , Key: anything,
// Model: muse-spark-1.3-contributor-free
//
// NOTE: the free tier is rate-limited per egress IP, and Workers egress IPs
// are shared. If you hit FreeTierError/429 here, the phone (Termux) build
// with your own mobile IP remains the more reliable option.

// ---- identity (freshly generated, correct ses_/prj_ format) ----
const SESSION_ID = "ses_725a73d1d54bfHY4taelbXKbrm";
const PROJECT_ID = "prj_1b0c6d540446rLlZI4sD48Tho5";
const USER_AGENT = "opencode/1.18.34 (linux x64)";
const UPSTREAM = "https://opencode.ai";

// ---- 反代内置工具：webfetch / websearch（对齐 oc 原生实现） ----
// Workers 版：环境变量开关硬编码为开（Workers 无 process.env）。
// 模型名 -search 后缀可强制启用（见 fetch handler）。
const WEBFETCH_NAME = "webfetch";
const WEBSEARCH_NAME = "websearch";
const WEBSEARCH_ENABLED = true;
const WEBFETCH_ENABLED = true;
// 本请求是否强制启用搜索（模型名 -search 后缀）。fetch handler 入口设置。
let requestForceSearch = false;
const ALL_PROXY_TOOL_NAMES = new Set([WEBSEARCH_NAME, WEBFETCH_NAME]);
const PROXY_TOOL_NAMES = new Set(
  [
    WEBSEARCH_ENABLED ? WEBSEARCH_NAME : null,
    WEBFETCH_ENABLED ? WEBFETCH_NAME : null,
  ].filter(Boolean)
);

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
const PROXY_TOOLS_RESPONSES = ALL_PROXY_TOOLS_RESPONSES.filter(
  (t) =>
    (t.name === WEBFETCH_NAME && WEBFETCH_ENABLED) ||
    (t.name === WEBSEARCH_NAME && WEBSEARCH_ENABLED)
);
const PROXY_TOOLS_CHAT = PROXY_TOOLS_RESPONSES.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));
const ALL_PROXY_TOOLS_CHAT = ALL_PROXY_TOOLS_RESPONSES.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

// 可用模型白名单（2026-10-10 真机实测可用）
// exo-free 已下线；jev/ling/nemotron-3.5 实测 400/403，已剔除
const WORKING_FREE_MODELS = new Set([
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "mimo-v2.6-flash-free",
  "longcat-2.5-preview-free",
  "step-5-preview-free",
  "space-bunny-free",
  "nemotron-3-ultra-free",
]);

const WEBFETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
// agentic loop 全局调用序号（跨轮唯一 call_id）
let proxyCallSeq = 0;

// ---- disguise tools: the free-tier gate requires exactly these names ----
const DISGUISE_CHAT = [
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a file. Use this instead of cat. Prefer this tool over shell for reading files.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file to read." },
          offset: { type: "number", description: "Line offset to start reading from." },
          limit: { type: "number", description: "Number of lines to read." },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a shell command. Prefer the read tool for reading files.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run." },
          workdir: { type: "string", description: "Working directory." },
          timeout: { type: "number", description: "Timeout in seconds." },
        },
        required: ["command"],
      },
    },
  },
];

const DISGUISE_RESPONSES = [
  {
    type: "function",
    name: "read",
    description:
      "Read a file. Use this instead of cat. Prefer this tool over shell for reading files.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to read." },
        offset: { type: "number", description: "Line offset to start reading from." },
        limit: { type: "number", description: "Number of lines to read." },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "shell",
    description:
      "Run a shell command. Prefer the read tool for reading files.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run." },
        workdir: { type: "string", description: "Working directory." },
        timeout: { type: "number", description: "Timeout in seconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

// ---- helpers ----
const B62 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function randB62(n) {
  let s = "";
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  for (const v of a) s += B62[v % 62];
  return s;
}
function freshMsgId() {
  return "msg_" + Date.now().toString(16).padStart(12, "0").slice(-12) + randB62(14);
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function unprefixToolName(name) {
  return typeof name === "string" && name.startsWith("default.")
    ? name.slice("default.".length)
    : name;
}

// ---- webfetch/websearch 执行器（对齐 oc 原生） ----

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

function stripNoisyTags(html) {
  return html.replace(
    /<(script|style|noscript|iframe|object|embed|meta|link|head)[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ""
  );
}

function htmlToText(html) {
  let s = stripNoisyTags(html);
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

function htmlToMarkdown(html) {
  let s = stripNoisyTags(html);
  const codeBlocks = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    codeBlocks.push(code);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner) => {
    return "`" + decodeEntities(inner.replace(/<[^>]+>/g, "")).trim() + "`";
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, lv, inner) => {
    return `\n\n${"#".repeat(Number(lv))} ${decodeEntities(inner.replace(/<[^>]+>/g, "")).trim()}\n\n`;
  });
  s = s.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, href, inner) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
      if (!text || text === href) return href;
      return `[${text}](${href})`;
    }
  );
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => {
    return `\n- ${decodeEntities(inner.replace(/<[^>]+>/g, "")).trim()}`;
  });
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|tr|section|article|blockquote)[^>]*>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    return `\n\n\`\`\`\n${codeBlocks[Number(i)] || ""}\n\`\`\`\n\n`;
  });
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r]+/g, " ").trimEnd())
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

async function doWebfetch(args, signal) {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    return `抓取失败：只支持 http:// 或 https:// 开头的 URL`;
  }
  // SSRF 防护：禁止私网/回环地址
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "metadata.google.internal" ||
      host.endsWith(".internal")
    ) {
      return `抓取失败：不允许抓取内网地址`;
    }
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      const isPrivate =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a === 0;
      if (isPrivate) return `抓取失败：不允许抓取内网地址`;
    }
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc00:") || host.startsWith("fd00:")) {
      return `抓取失败：不允许抓取内网地址`;
    }
  } catch {
    return `抓取失败：URL 解析失败`;
  }
  const format = ["text", "markdown", "html"].includes(args?.format) ? args.format : "markdown";
  const timeoutSec = Math.min(Math.max(Number(args?.timeout) || 30, 1), 120);
  const tryFetch = async (withUA) => {
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
    return fetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)])
        : AbortSignal.timeout(timeoutSec * 1000),
      redirect: "follow",
    });
  };
  try {
    let resp;
    try {
      resp = await tryFetch(true);
    } catch (e) {
      return `抓取失败：${e?.name === "TimeoutError" ? `请求超时（${timeoutSec}秒）` : e?.message || e}`;
    }
    if (resp.status === 403) {
      try {
        resp = await tryFetch(false);
      } catch (e) {
        return `抓取失败：${e?.name === "TimeoutError" ? `请求超时（${timeoutSec}秒）` : e?.message || e}`;
      }
    }
    if (!resp.ok) {
      return `抓取失败：HTTP ${resp.status}`;
    }
    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (ctype.startsWith("image/")) {
      return `（该 URL 是图片 ${ctype}，已跳过）`;
    }
    // 5MB 上限：超了不报错，截断返回（Workers 无 Buffer，用字符串长度近似）
    const raw = await resp.text();
    const truncated = raw.length > 5 * 1024 * 1024;
    const sliced = truncated ? raw.slice(0, 5 * 1024 * 1024) : raw;
    let out;
    if (format === "html") {
      out = sliced.slice(0, 8000);
    } else if (format === "text") {
      out = htmlToText(sliced);
    } else {
      out = htmlToMarkdown(sliced);
    }
    if (out.length > 8000) out = out.slice(0, 8000) + "\n\n（内容过长已截断）";
    if (truncated) out += "\n\n（注：页面超过 5MB，仅返回前 5MB 内容）";
    if (!out) return `抓取失败：页面无有效正文`;
    return out;
  } catch (e) {
    return `抓取失败：${e?.message || e}`;
  }
}

async function doWebsearch(args, signal) {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) return "搜索失败：缺少 query 参数";
  const numResults = Math.min(Math.max(Number(args?.numResults) || 8, 1), 20);
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
        livecrawl: ["fallback", "preferred"].includes(args?.livecrawl) ? args.livecrawl : "fallback",
        ...(typeof args?.contextMaxCharacters === "number" && args.contextMaxCharacters > 0
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
      return `搜索失败：${payload.error?.message || "未知错误"}`;
    }
    const contents = payload?.result?.content;
    if (!Array.isArray(contents) || contents.length === 0) {
      return "搜索失败：无搜索结果";
    }
    const parts = [];
    for (const c of contents) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        parts.push(c.text.trim());
      }
    }
    const out = parts.join("\n\n---\n\n").trim();
    if (!out) return "搜索失败：无搜索结果";
    return out.length > 10000 ? out.slice(0, 10000) + "\n\n（结果过长已截断）" : out;
  } catch (e) {
    return `搜索失败：${e?.name === "TimeoutError" ? "搜索服务超时（25秒）" : e?.message || e}`;
  }
}

async function runProxyTool(name, argsJson, signal) {
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `参数解析失败`;
  }
  if (name === WEBFETCH_NAME) {
    if (!WEBFETCH_ENABLED && !requestForceSearch) return "网页抓取功能已关闭";
    return doWebfetch(args, signal);
  }
  if (name === WEBSEARCH_NAME) {
    if (!WEBSEARCH_ENABLED && !requestForceSearch) return "联网搜索功能已关闭";
    return doWebsearch(args, signal);
  }
  return `未知内置工具：${name}`;
}

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

function toResponsesTool(t) {
  if (!t || t.type !== "function") return null;
  if (typeof t.name === "string" && t.name) {
    return {
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || { type: "object", properties: {} },
    };
  }
  const fn = t.function;
  if (!fn || typeof fn.name !== "string" || !fn.name) return null;
  return {
    type: "function",
    name: fn.name,
    description: fn.description || "",
    parameters: fn.parameters || { type: "object", properties: {} },
  };
}

// Upstream Zen only accepts tool_choice "auto" (verified 2026-10-06:
// "none"/"required"/named choices -> 400). Strip anything else before the
// request goes out; omitting it is equivalent to "auto".
// (Mirrors sanitizeToolChoice in proxy.mjs — keep the two in sync.)
function sanitizeToolChoice(body) {
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    delete body.tool_choice;
  }
}

function ensureChatTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) {
    body.tools = DISGUISE_CHAT.slice();
  } else {
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
  }
  // 反代内置工具（webfetch/websearch）：forceSearch 时用全量，否则按开关
  {
    const names = new Set(
      body.tools.map((t) => t?.function?.name || t?.name).filter(Boolean)
    );
    // v42: 只有 -search 后缀或客户端原生搜索请求时才注入
    const proxyTools = requestForceSearch ? ALL_PROXY_TOOLS_CHAT : [];
    for (const pt of proxyTools) {
      const n = pt?.function?.name;
      if (n && !names.has(n)) {
        body.tools.push(pt);
        names.add(n);
      }
    }
  }
  body.stream = true;
  if (body.stream_options === undefined)
    body.stream_options = { include_usage: true };
  // Don't force tool_choice: the model must be free to call app tools.
  sanitizeToolChoice(body);
}

function ensureResponsesTools(body) {
  const appTools = (Array.isArray(body.tools) ? body.tools : [])
    .map(toResponsesTool)
    .filter(Boolean);
  const names = new Set(appTools.map((t) => t.name));
  const merged = [...appTools];
  for (const dt of DISGUISE_RESPONSES) {
    if (!names.has(dt.name)) {
      merged.push(dt);
      names.add(dt.name);
    }
  }
  // 反代内置工具（webfetch/websearch）：forceSearch 时用全量，否则按开关
  // v42: 只有 -search 后缀或客户端原生搜索请求时才注入
  const proxyTools = requestForceSearch ? ALL_PROXY_TOOLS_RESPONSES : [];
  for (const pt of proxyTools) {
    if (!names.has(pt.name)) {
      merged.push(pt);
      names.add(pt.name);
    }
  }
  body.tools = merged;
  body.stream = true;
  sanitizeToolChoice(body);
}

// Copy sampling params the Responses upstream accepts (verified 2026-10-05).
function applySamplingParams(target, src) {
  const maxOut =
    src.max_output_tokens ?? src.max_tokens ?? src.max_completion_tokens;
  // v50修复：上游要求 max_output_tokens >= 16
  if (maxOut) target.max_output_tokens = Math.max(16, maxOut);
  for (const k of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
  ]) {
    if (src[k] !== undefined) target[k] = src[k];
  }
}

// v34/v37/v40/v41: 思考参数标准化（对齐 proxy.mjs）。
// 只对 muse-spark-*（原生推理模型）生效：
// - 顶层 reasoning_effort 转成 reasoning.effort；'none' 删除；'auto' → 'medium'
// - 嵌套 reasoning.effort:"auto" → "medium"；"none" 视为缺省
// - 缺省时补 {effort:"medium", summary:"auto"}
function normalizeThinkingParams(body) {
  if (typeof body?.model !== "string" || !body.model.startsWith("muse-spark-")) {
    return body;
  }
  // v34: 顶层 reasoning_effort → reasoning
  if (body.reasoning_effort !== undefined) {
    const eff = body.reasoning_effort;
    delete body.reasoning_effort;
    const normEff = eff === "auto" ? "medium" : eff; // v40
    if (normEff && normEff !== "none") {
      body.reasoning = {
        effort: normEff,
        summary: "auto",
        ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
      };
    }
  }
  // v40: 嵌套 reasoning.effort:"auto" → "medium"
  if (
    body.reasoning &&
    typeof body.reasoning === "object" &&
    body.reasoning.effort === "auto"
  ) {
    body.reasoning.effort = "medium";
  }
  // v37/v41: 缺省或 "none" 时补 medium
  if (!body.reasoning?.effort || body.reasoning.effort === "none") {
    body.reasoning = { effort: "medium", summary: "auto" };
  } else if (body.reasoning.summary === undefined) {
    body.reasoning.summary = "auto";
  }
  return body;
}

// ---- chat -> responses translation ----
function chatContentToResponses(content) {
  if (typeof content === "string")
    return content ? [{ type: "input_text", text: content }] : null;
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

function chatToResponsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    const role = m.role || "user";
    if (role === "tool") {
      const out =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "",
        output: out,
      });
      continue;
    }
    const mappedRole =
      role === "assistant"
        ? "assistant"
        : role === "system" || role === "developer"
          ? "developer"
          : "user";
    if (
      role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length
    ) {
      if (typeof m.content === "string" && m.content)
        input.push({ role: "assistant", content: m.content });
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        input.push({
          type: "function_call",
          call_id: tc.id || "",
          name: fn.name || "",
          arguments:
            typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    const parts = chatContentToResponses(m.content);
    if (parts) {
      const onlyText = parts.length === 1 && parts[0].type === "input_text";
      input.push({
        role: mappedRole,
        content: onlyText ? parts[0].text : parts,
      });
    }
  }
  return input;
}

// v47: Responses API 请求体 → Chat Completions 请求体（反向翻译）。
// 用于 /v1/responses 收到非 muse-spark 模型（mimo/longcat）时：
// 上游 /zen/v1/responses 只支持 muse-spark，这些模型要走 /zen/v1/chat/completions。
function responsesToChatBody(body) {
  const messages = [];
  // instructions → system 消息
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  // input 为字符串 → 直接作为 user 消息（v50修复）
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
  // v47.1: 上游 chat 接口不认 Responses 专有字段，删掉。
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

// ---- responses SSE -> object ----
function sseToResponse(sseText, fallbackModel) {
  let id = `resp-proxy-${Date.now()}`;
  let model = fallbackModel;
  let text = "";
  let usage = null;
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
    const evt = obj.type || "";
    if (evt === "response.output_text.delta" && typeof obj.delta === "string")
      text += obj.delta;
    const resp = obj.response || obj;
    if (resp && typeof resp === "object") {
      if (resp.id) id = resp.id;
      if (resp.model) model = resp.model;
    }
    if ((obj.type === "response.completed" || obj.type === "response.incomplete") && Array.isArray(resp.output)) {
      if (resp.usage && typeof resp.usage === "object") {
        usage = {
          input_tokens: resp.usage.input_tokens ?? 0,
          output_tokens: resp.usage.output_tokens ?? 0,
          total_tokens:
            resp.usage.total_tokens ??
            (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
        };
      }
      for (const item of resp.output) {
        if (item && item.type === "function_call" && item.name) {
          functions.push({
            type: "function_call",
            call_id: item.call_id || item.id || "",
            name: unprefixToolName(item.name),
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
          });
        }
      }
    }
  }
  return {
    id,
    object: "response",
    status: "completed",
    model,
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      ...functions,
    ],
    usage,
  };
}

function responseToChatCompletion(resp, fallbackModel) {
  let text = "";
  const toolCalls = [];
  for (const item of resp.output || []) {
    if (item.type === "function_call" && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: unprefixToolName(item.name),
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
    for (const c of item.content || [])
      if (c.type === "output_text" && c.text) text += c.text;
  }
  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const out = {
    id: resp.id || `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
  };
  if (resp.usage) {
    out.usage = {
      prompt_tokens: resp.usage.input_tokens ?? 0,
      completion_tokens: resp.usage.output_tokens ?? 0,
      total_tokens: resp.usage.total_tokens ?? 0,
    };
  }
  return out;
}

// ---- anthropic ----
function anthropicToResponsesBody(body) {
  const input = [];
  const sysText =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s) => s.text || "").join("")
        : "";
  if (sysText) input.push({ role: "developer", content: sysText });
  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      if (content) input.push({ role, content });
      continue;
    }
    const textParts = [];
    for (const b of content || []) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && b.text) textParts.push(b.text);
      else if (b.type === "image" && b.source) {
        const src = b.source;
        if (src.type === "base64" && src.data)
          input.push({
            type: "input_image",
            image_url: `data:${src.media_type || "image/jpeg"};base64,${src.data}`,
          });
        else if (src.type === "url" && src.url)
          input.push({ type: "input_image", image_url: src.url });
      } else if (b.type === "tool_use" && b.name) {
        input.push({
          type: "function_call",
          call_id: b.id || "",
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === "tool_result") {
        const out =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        input.push({ type: "function_call_output", call_id: b.tool_use_id || "", output: out });
      }
    }
    if (textParts.length) input.push({ role, content: textParts.join("") });
  }
  const rb = { model: body.model, input, stream: true, store: false };
  applySamplingParams(rb, body);
  // v39/v41: thinking -> reasoning 映射；spark 缺省补 medium（与其他路径一致）
  if (body.thinking?.type === "enabled") {
    rb.reasoning = { effort: "medium", summary: "auto" };
  }
  normalizeThinkingParams(rb);
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

function responseToAnthropic(resp, fallbackModel) {
  const content = [];
  for (const item of resp.output || []) {
    if (item.type === "function_call" && item.name) {
      let input = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: item.call_id || item.id || `toolu_${content.length}`,
        name: unprefixToolName(item.name),
        input,
      });
    }
    for (const c of item.content || [])
      if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
  }
  return {
    id: resp.id || `msg_proxy_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model || fallbackModel,
    content,
    stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

// ---- upstream ----
function upstreamHeaders() {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer public",
    "user-agent": USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-project": PROJECT_ID,
    "x-opencode-session": SESSION_ID,
    "x-session-id": SESSION_ID,
    "x-session-affinity": SESSION_ID,
    "x-opencode-request": freshMsgId(),
  };
}

// Assemble a chat.completion object from an upstream chat SSE stream
// (used when the client asked for non-streaming but upstream was forced
// to stream by the free-tier gate).
function sseToChatCompletion(sseText, fallbackModel) {
  let content = "";
  let reasoning = "";
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
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
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

// Incremental translator: Responses SSE -> OpenAI chat SSE (true streaming).
async function streamResponsesToChat(upstream, emit, model, opts = {}) {
  const interceptNames = opts.interceptNames || new Set();
  const intercepted = [];
  const interceptedByIndex = new Map();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const base = {
    id: `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunk = (choices) => `data: ${JSON.stringify({ ...base, choices })}\n\n`;
  emit(chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]));
  const toolIndexes = new Map();
  let toolCount = 0;
  let hasTools = false;
  let doneEmitted = false;
  const finish = (reason) => {
    if (doneEmitted) return;
    doneEmitted = true;
    // 有拦截工具时抑制 finish，等待 follow-up 收尾
    if (intercepted.length > 0) return;
    emit(chunk([{ index: 0, delta: {}, finish_reason: reason }]));
    emit("data: [DONE]\n\n");
  };
  try {
    for (;;) {
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
        if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
          emit(chunk([{ index: 0, delta: { content: obj.delta }, finish_reason: null }]));
        } else if (obj.type === "response.reasoning_summary_text.delta" && typeof obj.delta === "string") {
          // 思维链透传
          emit(chunk([{ index: 0, delta: { reasoning_content: obj.delta }, finish_reason: null }]));
        } else if (obj.type === "response.output_item.added" && obj.item?.type === "function_call") {
          const item = obj.item;
          const toolName = unprefixToolName(item.name);
          // 反代内置工具：拦截本地执行
          if (interceptNames.has(toolName)) {
            const entry = {
              call_id: item.call_id || item.id || `call_proxy_${++proxyCallSeq}`,
              name: toolName,
              arguments: "",
            };
            intercepted.push(entry);
            interceptedByIndex.set(obj.output_index, entry);
            continue;
          }
          // 本轮已有拦截工具时，客户端工具暂缓（避免 hang）
          if (intercepted.length > 0) continue;
          const idx = toolCount++;
          toolIndexes.set(obj.output_index, idx);
          hasTools = true;
          emit(chunk([{ index: 0, delta: { tool_calls: [{ index: idx, id: item.call_id || item.id, type: "function", function: { name: toolName, arguments: "" } }] }, finish_reason: null }]));
        } else if (obj.type === "response.function_call_arguments.delta" && typeof obj.delta === "string") {
          const interceptedEntry = interceptedByIndex.get(obj.output_index);
          if (interceptedEntry) {
            interceptedEntry.arguments += obj.delta;
            continue;
          }
          const idx = toolIndexes.get(obj.output_index);
          if (idx !== undefined) {
            emit(chunk([{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: obj.delta } }] }, finish_reason: null }]));
          }
        } else if (obj.type === "response.completed") {
          finish(hasTools ? "tool_calls" : "stop");
        } else if (obj.type === "response.incomplete") {
          const reason = obj.response?.incomplete_details?.reason;
          finish(reason === "max_output_tokens" ? "length" : "stop");
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  finish(hasTools ? "tool_calls" : "stop");
  return { intercepted };
}

// Incremental translator: Responses SSE -> Anthropic SSE (true streaming).
async function streamResponsesToAnthropic(upstream, emit, model) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const msgId = `msg_proxy_${Date.now()}`;
  const ev = (name, data) => emit(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let started = false;
  let blockIndex = 0;
  let textOpen = false;
  const toolBlocks = new Map();
  let hasTools = false;
  const ensureStart = () => {
    if (started) return;
    started = true;
    ev("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
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
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
          ensureStart();
          if (!textOpen) {
            textOpen = true;
            ev("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
          }
          ev("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: obj.delta } });
        } else if (obj.type === "response.output_item.added" && obj.item?.type === "function_call") {
          ensureStart();
          closeText();
          const bi = blockIndex++;
          toolBlocks.set(obj.output_index, bi);
          hasTools = true;
          const item = obj.item;
          ev("content_block_start", { type: "content_block_start", index: bi, content_block: { type: "tool_use", id: item.call_id || item.id, name: unprefixToolName(item.name), input: {} } });
        } else if (obj.type === "response.function_call_arguments.delta" && typeof obj.delta === "string") {
          const bi = toolBlocks.get(obj.output_index);
          if (bi !== undefined) {
            ev("content_block_delta", { type: "content_block_delta", index: bi, delta: { type: "input_json_delta", partial_json: obj.delta } });
          }
        } else if (obj.type === "response.completed" || obj.type === "response.incomplete") {
          ensureStart();
          closeText();
          for (const bi of toolBlocks.values()) ev("content_block_stop", { type: "content_block_stop", index: bi });
          const usage = obj.response?.usage;
          const incompleteReason = obj.response?.incomplete_details?.reason;
          const stopReason = obj.type === "response.incomplete"
            ? (incompleteReason === "max_output_tokens" ? "max_tokens" : "end_turn")
            : (hasTools ? "tool_use" : "end_turn");
          ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: usage?.output_tokens ?? 0 } });
          ev("message_stop", { type: "message_stop" });
          return;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  ensureStart();
  closeText();
  for (const bi of toolBlocks.values()) ev("content_block_stop", { type: "content_block_stop", index: bi });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: hasTools ? "tool_use" : "end_turn" }, usage: { output_tokens: 0 } });
  ev("message_stop", { type: "message_stop" });
}

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
            entry = { id: tc.id || `toolu_${idx}`, name: tc.function?.name || "", args: "" };
            toolArgBuffers.set(idx, entry);
            emitEvent({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} } });
            entry.blockIndex = blockIndex++;
          }
          if (tc.function?.name) entry.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            entry.args += tc.function.arguments;
            emitEvent({ type: "content_block_delta", index: entry.blockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  emitEvent({ type: "content_block_stop", index: 0 });
  for (const [, entry] of toolArgBuffers) {
    if (!entry.name) continue;
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

// ---- main handler ----
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // v38/v45: /r 前缀做路径兼容（剥掉前缀）。v45 起模型列表统一返回 8 个，
    // 所有接口都认 -search 后缀。
    let path = url.pathname;
    if (path === "/r" || path.startsWith("/r/")) {
      path = path === "/r" ? "/" : path.slice(2);
    }

    if (request.method === "GET" && path === "/health")
      return jsonResponse({ ok: true, upstream: UPSTREAM + "/zen/v1" });

    if (request.method === "GET" && (path === "/v1/models" || path === "/zen/v1/models")) {
      const up = await fetch(UPSTREAM + "/zen/v1/models", { headers: upstreamHeaders() });
      if (up.ok) {
        try {
          const data = await up.json();
          if (Array.isArray(data?.data)) {
            // 只保留实测可用的模型
            data.data = data.data.filter(
              (m) => typeof m?.id === "string" && WORKING_FREE_MODELS.has(m.id)
            );
            // v45: 统一加 -search 变体（8 个模型）
            {
              const extra = [];
              for (const m of data.data) {
                if (!m.id.endsWith("-search")) {
                  extra.push({ ...m, id: m.id + "-search" });
                }
              }
              data.data.push(...extra);
            }
          }
          return jsonResponse(data, up.status);
        } catch {
          // 解析失败则直通
        }
      }
      return new Response(up.body, {
        status: up.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/zen/v1/chat/completions")) {
      const body = await request.json().catch(() => null);
      if (!body) return jsonResponse({ error: "invalid JSON" }, 400);
      // 模型名 -search 后缀：强制启用搜索，剥掉后缀再发上游
      // v43: /r 前缀下不认后缀，只认 RikkaHub 开关
      requestForceSearch = false;
      if (typeof body.model === "string" && body.model.endsWith("-search")) {
        body.model = body.model.slice(0, -"-search".length);
        // v45: 所有接口都认 -search 后缀（无条件开启）
        requestForceSearch = true;
      }
      const useResponses =
        typeof body.model === "string" && body.model.startsWith("muse-spark-");
      const clientWantsStream = body.stream === true;

      let upstreamPath, upstreamBody;
      let translateToResponses = false;
      if (useResponses) {
        translateToResponses = true;
        upstreamPath = "/zen/v1/responses";
        upstreamBody = {
          model: body.model,
          input: chatToResponsesInput(body.messages),
          tools: body.tools,
          stream: true,
          store: false,
        };
        applySamplingParams(upstreamBody, body);
        // v34/v37/v40/v41: chat 的顶层 reasoning_effort 转成 reasoning，缺省补 medium
        if (body.reasoning_effort !== undefined) {
          const eff = body.reasoning_effort;
          const normEff = eff === "auto" ? "medium" : eff;
          if (normEff && normEff !== "none") {
            upstreamBody.reasoning = { effort: normEff, summary: "auto" };
          }
        }
        normalizeThinkingParams(upstreamBody);
        ensureResponsesTools(upstreamBody);
      } else {
        upstreamPath = "/zen/v1/chat/completions";
        upstreamBody = body;
        ensureChatTools(upstreamBody);
      }

      // 拦截集合：代理工具名去掉客户端自带同名
      const clientToolNames = new Set(
        (upstreamBody.tools || []).map((t) => t?.name || t?.function?.name).filter(Boolean)
      );
      // v42: 拦截集合只在 forceSearch 时非空（与注入逻辑一致）
      const interceptBase = requestForceSearch ? ALL_PROXY_TOOL_NAMES : new Set();
      const proxyInterceptNames = new Set(
        [...interceptBase].filter((n) => !clientToolNames.has(n))
      );

      const doUpstreamFetch = (input) => {
        const reqBody = input ? { ...upstreamBody, input } : upstreamBody;
        return fetch(UPSTREAM + upstreamPath, {
          method: "POST",
          headers: upstreamHeaders(),
          body: JSON.stringify(reqBody),
        });
      };

      const up = await doUpstreamFetch();
      const ctype = up.headers.get("content-type") || "";
      if (translateToResponses && ctype.includes("text/event-stream")) {
        if (clientWantsStream) {
          // 流式 + agentic loop：拦截内置工具，本地执行后 follow-up，最多 5 轮
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const enc = new TextEncoder();
          const emit = (c) => writer.write(enc.encode(c));
          (async () => {
            try {
              const MAX_ROUNDS = 5;
              let currentInput = upstreamBody.input;
              let firstUp = up;
              for (let round = 0; round < MAX_ROUNDS; round++) {
                const cur = round === 0 ? firstUp : await doUpstreamFetch(currentInput);
                if (!cur.ok) {
                  try { writer.close(); } catch {}
                  return;
                }
                const { intercepted } = await streamResponsesToChat(
                  cur, emit, body.model || "unknown", { interceptNames: proxyInterceptNames }
                );
                if (intercepted.length === 0) break;
                // 本地执行
                const outputs = [];
                for (const call of intercepted) {
                  outputs.push(await runProxyTool(call.name, call.arguments));
                }
                currentInput = [...currentInput, ...proxyToolInputItems(intercepted, outputs)];
                if (round === MAX_ROUNDS - 1) {
                  // 最后一轮收尾：不再拦截
                  const finalUp = await doUpstreamFetch(currentInput);
                  if (finalUp.ok) {
                    await streamResponsesToChat(finalUp, emit, body.model || "unknown", { interceptNames: new Set() });
                  }
                }
              }
            } finally {
              try { writer.close(); } catch {}
            }
          })();
          return new Response(readable, {
            status: up.status,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        // 非流式：buffer 后做 agentic loop
        {
          const MAX_ROUNDS = 5;
          let currentInput = upstreamBody.input;
          let curUp = up;
          let finalRespObj = null;
          for (let round = 0; round < MAX_ROUNDS; round++) {
            const sseText = await curUp.text();
            // 用支持拦截的版本解析：这里简化，非流式直接检查 function_call
            const respObj = sseToResponse(sseText, body.model || "unknown");
            const proxyCalls = (respObj.output || []).filter(
              (item) => item?.type === "function_call" && proxyInterceptNames.has(unprefixToolName(item.name))
            );
            if (proxyCalls.length === 0) {
              finalRespObj = respObj;
              break;
            }
            const calls = proxyCalls.map((pc) => ({
              call_id: pc.call_id || `call_proxy_${++proxyCallSeq}`,
              name: unprefixToolName(pc.name),
              arguments: typeof pc.arguments === "string" ? pc.arguments : JSON.stringify(pc.arguments || {}),
            }));
            const outputs = [];
            for (const call of calls) {
              outputs.push(await runProxyTool(call.name, call.arguments));
            }
            currentInput = [...currentInput, ...proxyToolInputItems(calls, outputs)];
            if (round === MAX_ROUNDS - 1) {
              const finalUp = await doUpstreamFetch(currentInput);
              const finalText = await finalUp.text();
              finalRespObj = sseToResponse(finalText, body.model || "unknown");
              break;
            }
            curUp = await doUpstreamFetch(currentInput);
          }
          const chatObj = responseToChatCompletion(finalRespObj || sseToResponse(await up.text(), body.model || "unknown"), body.model || "unknown");
          return jsonResponse(chatObj, up.status);
        }
      }
      // Direct passthrough path (non-spark): upstream was forced to stream,
      // so de-stream when the client asked for a single JSON object.
      if (!clientWantsStream && ctype.includes("text/event-stream")) {
        const sseText = await up.text();
        const chatObj = sseToChatCompletion(sseText, body.model || "unknown");
        return jsonResponse(chatObj, up.status);
      }
      return new Response(up.body, {
        status: up.status,
        headers: { "content-type": ctype.includes("text/event-stream") ? "text/event-stream" : "application/json" },
      });
    }

    if (request.method === "POST" && (path === "/v1/responses" || path === "/zen/v1/responses")) {
      const body = await request.json().catch(() => null);
      if (!body) return jsonResponse({ error: "invalid JSON" }, 400);
      requestForceSearch = false;
      if (typeof body.model === "string" && body.model.endsWith("-search")) {
        body.model = body.model.slice(0, -"-search".length);
        // v45: 所有接口都认 -search 后缀（无条件开启）
        requestForceSearch = true;
      }
      // v34/v37/v40/v41: 思考参数标准化（spark 默认 medium）
      normalizeThinkingParams(body);
      const clientWantsStream = body.stream !== false;
      const isSpark = typeof body.model === "string" && body.model.startsWith("muse-spark-");
      // v47: 非 spark 模型（mimo/longcat）上游 /responses 不支持，转 chat
      if (!isSpark) {
        const chatBody = responsesToChatBody(body);
        ensureChatTools(chatBody);
        const up = await fetch(UPSTREAM + "/zen/v1/chat/completions", {
          method: "POST",
          headers: upstreamHeaders(),
          body: JSON.stringify(chatBody),
        });
        if (!clientWantsStream) {
          const sseText = await up.text();
          const chatObj = sseToChatCompletion(sseText, body.model || "unknown");
          // chat → Responses
          const msg = chatObj.choices?.[0]?.message || {};
          const text = typeof msg.content === "string" ? msg.content : "";
          const output = [];
          if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
          for (const tc of msg.tool_calls || []) {
            output.push({ type: "function_call", call_id: tc.id || "", id: tc.id || "", name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" });
          }
          return jsonResponse({ id: `resp-proxy-${Date.now()}`, object: "response", status: "completed", model: body.model, output,
            usage: chatObj.usage ? { input_tokens: chatObj.usage.prompt_tokens, output_tokens: chatObj.usage.completion_tokens, total_tokens: chatObj.usage.total_tokens } : null }, up.status);
        }
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        streamChatToResponses(up, (c) => writer.write(enc.encode(c)), body.model || "unknown", null)
          .then(() => writer.close()).catch(() => { try { writer.close(); } catch {} });
        return new Response(readable, { status: up.status, headers: { "content-type": "text/event-stream" } });
      }
      ensureResponsesTools(body);
      const up = await fetch(UPSTREAM + "/zen/v1/responses", {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify(body),
      });
      if (!clientWantsStream) {
        const sseText = await up.text();
        const respObj = sseToResponse(sseText, body.model || "unknown");
        return jsonResponse(respObj, up.status);
      }
      return new Response(up.body, {
        status: up.status,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (request.method === "POST" && path === "/v1/messages") {
      const body = await request.json().catch(() => null);
      if (!body) return jsonResponse({ error: "invalid JSON" }, 400);
      requestForceSearch = false;
      if (typeof body.model === "string" && body.model.endsWith("-search")) {
        body.model = body.model.slice(0, -"-search".length);
        // v45: 所有接口都认 -search 后缀（无条件开启）
        requestForceSearch = true;
      }
      const clientWantsStream = body.stream === true;
      const isSpark = typeof body.model === "string" && body.model.startsWith("muse-spark-");
      // v47: 非 spark 模型（mimo/longcat）转 chat 走 chat 上游
      if (!isSpark) {
        const chatBody = anthropicToChatBody(body);
        ensureChatTools(chatBody);
        const up = await fetch(UPSTREAM + "/zen/v1/chat/completions", {
          method: "POST",
          headers: upstreamHeaders(),
          body: JSON.stringify(chatBody),
        });
        if (clientWantsStream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const enc = new TextEncoder();
          streamChatToAnthropic(up, (c) => writer.write(enc.encode(c)), body.model || "unknown", null)
            .then(() => writer.close()).catch(() => { try { writer.close(); } catch {} });
          return new Response(readable, { status: up.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
        }
        const sseText = await up.text();
        const chatObj = sseToChatCompletion(sseText, body.model || "unknown");
        const msg = chatObj.choices?.[0]?.message || {};
        const content = [];
        if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls || []) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          content.push({ type: "tool_use", id: tc.id || "", name: tc.function?.name || "", input });
        }
        return jsonResponse({ id: `msg_proxy_${Date.now()}`, type: "message", role: "assistant", model: body.model,
          content, stop_reason: content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn",
          usage: { input_tokens: chatObj.usage?.prompt_tokens ?? 0, output_tokens: chatObj.usage?.completion_tokens ?? 0 } }, up.status);
      }
      const responsesBody = anthropicToResponsesBody(body);
      const up = await fetch(UPSTREAM + "/zen/v1/responses", {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify(responsesBody),
      });
      if (clientWantsStream) {
        // True streaming: translate chunks on the fly.
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        streamResponsesToAnthropic(up, (c) => writer.write(enc.encode(c)), body.model || "unknown")
          .then(() => writer.close())
          .catch(() => { try { writer.close(); } catch {} });
        return new Response(readable, {
          status: up.status,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }
      const sseText = await up.text();
      const respObj = sseToResponse(sseText, body.model || "unknown");
      const anthObj = responseToAnthropic(respObj, body.model || "unknown");
      return jsonResponse(anthObj, up.status);
    }

    return jsonResponse({ error: `Unknown route ${request.method} ${path}` }, 404);
  },
};
