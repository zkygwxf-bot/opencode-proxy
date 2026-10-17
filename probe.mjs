// probe.mjs — OpenCode Zen 免费层黑盒探针
// 用途：每天打一次上游免费层，确认我们的 session 格式/鉴权仍被放行，
//      并逐个验证白名单模型的可用性（上游会悄悄下线模型，如 2026-10-17
//      muse-spark-1.3-contributor-free 被 410 下线）。
// 逻辑：
//   1) 用 freshSessionId 同款算法生成全新 session id，带官方风格请求头
//      GET https://opencode.ai/zen/v1/models（匿名可访问，只验连通性）。
//   2) 对 FREE_MODEL_IDS（从 proxy.mjs 解析）逐个发最小流式 chat 请求，
//      用 session.json 捕获的 1.18.x 指纹（UA/project/request）+ Bearer public。
//      注意：免费层只接受 stream:true，非流式会被 403 FreeTierError 拒掉。
// 退出码：全过 → 0；任一失败 → 1（供 cron/告警脚本判断）。
// 注意：只做 1 次请求/模型，不重试、不绕过限流；429/403 原样上报。

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DIR = dirname(fileURLToPath(import.meta.url));

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function randB62(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += B62[(Math.random() * 62) | 0];
  return s;
}

let _counter = 0;
// 与 proxy.mjs mintedTimePrefix() 同款：~(unix_ms*0x1000+counter) 取低 48 位
function freshSessionId() {
  const counter = (++_counter) & 0xfff;
  const current = BigInt(Date.now()) * 0x1000n + BigInt(counter);
  const inverted = (~current) & 0xffffffffffffn;
  return "ses_" + inverted.toString(16).padStart(12, "0") + randB62(14);
}

// 从 proxy.mjs 解析 FREE_MODEL_IDS，避免两处名单漂移
function loadModelIds() {
  const src = readFileSync(join(DIR, "proxy.mjs"), "utf8");
  const m = src.match(/const FREE_MODEL_IDS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error("FREE_MODEL_IDS 解析失败");
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

// session.json 里的 1.18.x 指纹（capture.mjs 从真客户端抓的，不含密钥只有 UA/project/request 形状）
function loadFingerprint() {
  const s = JSON.parse(readFileSync(join(DIR, "session.json"), "utf8"));
  return {
    userAgent: s.userAgent || "opencode/latest/2.0.28/cli",
    client: s.xOpencodeClient || "cli",
    project: s.xOpencodeProject || "public",
    request: s.xOpencodeRequest || "",
  };
}

// 最小伪装工具：免费门控要求 read/shell 名字在场（与 proxy.mjs DISGUISE_NAMES 一致）
function disguiseTools() {
  try {
    const tools = JSON.parse(readFileSync(join(DIR, "tools-chat.json"), "utf8"));
    return tools.filter(t => ["read", "shell"].includes(t.function?.name));
  } catch {
    return ["read", "shell"].map(name => ({
      type: "function",
      function: { name, description: "probe", parameters: { type: "object", properties: {} } },
    }));
  }
}
// Responses API 格式的伪装工具（spark 模型走 /zen/v1/responses，也要带工具名）
function disguiseToolsResponses() {
  try {
    const tools = JSON.parse(readFileSync(join(DIR, "tools-responses.json"), "utf8"));
    return tools.filter(t => ["read", "shell"].includes(t.name));
  } catch {
    return [];
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;

async function checkModelsList() {
  const sid = freshSessionId();
  const headers = {
    "user-agent": "opencode/latest/2.0.28/cli",
    "x-opencode-client": "cli",
    "x-opencode-session-id": sid,
    "x-opencode-session": sid,
    "x-session-affinity": sid,
    "X-Session-Id": sid,
  };
  const t0 = Date.now();
  try {
    const res = await fetch("https://opencode.ai/zen/v1/models", { headers });
    console.log(`[probe] models status=${res.status} elapsed=${Date.now() - t0}ms`);
    if (res.status !== 200) { failed++; }
  } catch (e) {
    console.log(`[probe] models ERROR: ${e.message}`);
    failed++;
  }
}

async function checkModel(m, fp, tools, toolsResp) {
  // muse-spark-* 只存在于 Responses API，走 /zen/v1/responses
  if (m.startsWith("muse-spark-")) return checkModelResponses(m, fp, toolsResp);
  const sid = freshSessionId();
  const headers = {
    "content-type": "application/json",
    "user-agent": fp.userAgent,
    "x-opencode-client": fp.client,
    "x-opencode-session-id": sid,
    "x-opencode-session": sid,
    "x-session-affinity": sid,
    "X-Session-Id": sid,
    "x-opencode-project": fp.project,
    "authorization": "Bearer public",
  };
  if (fp.request) headers["x-opencode-request"] = fp.request;
  const t0 = Date.now();
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: m,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 5,
        stream: true, // 免费层只认流式，非流式直接 403
        tools,
      }),
    });
    // 读完整段小流：有些已下线模型返回 HTTP 200 但流里是 error（如 ultra），
    // 必须看内容，不能只看状态码
    let bodyText = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (let i = 0; i < 50; i++) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        bodyText += decoder.decode(value, { stream: true });
        if (bodyText.length > 4000) break;
      }
      reader.cancel().catch(() => {});
    }
    // 通过条件：200、无 "type":"error"、有 finish_reason（真完成了一轮）
    // 注：用 "type":"error" 而非 "error"，spark 正常流里有 "error":null 字段
    const ok = res.status === 200 && !bodyText.includes('"type":"error"') && bodyText.includes("finish_reason");
    console.log(`[probe] ${m} => ${res.status}${ok ? "" : " FAIL"} (${Date.now() - t0}ms)`);
    if (!ok) {
      if (res.status !== 200 || bodyText.includes('"type":"error"')) {
        console.log(`[probe]   body 头 200 字符: ${bodyText.slice(0, 200).replace(/\n/g, "\\n")}`);
      }
      failed++;
    }
  } catch (e) {
    console.log(`[probe] ${m} => ERROR: ${e.message}`);
    failed++;
  }
}

// spark 模型经 Responses API 探测
async function checkModelResponses(m, fp, toolsResp) {
  const sid = freshSessionId();
  const headers = {
    "content-type": "application/json",
    "user-agent": fp.userAgent,
    "x-opencode-client": fp.client,
    "x-opencode-session-id": sid,
    "x-opencode-session": sid,
    "x-session-affinity": sid,
    "X-Session-Id": sid,
    "x-opencode-project": fp.project,
    "authorization": "Bearer public",
  };
  if (fp.request) headers["x-opencode-request"] = fp.request;
  const t0 = Date.now();
  try {
    const res = await fetch("https://opencode.ai/zen/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: m,
        input: "Reply with exactly: OK",
        max_output_tokens: 20,
        stream: true,
        tools: toolsResp,
        reasoning: { effort: "medium", summary: "auto" },
      }),
    });
    let bodyText = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // spark 带 reasoning 时流较长（约 12KB），读到 response.completed 或流结束
      for (let i = 0; i < 300; i++) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        bodyText += decoder.decode(value, { stream: true });
        if (bodyText.includes("response.completed")) break;
        if (bodyText.length > 30000) break;
      }
      reader.cancel().catch(() => {});
    }
    const ok = res.status === 200 && !bodyText.includes('"type":"error"') && bodyText.includes("response.completed");
    console.log(`[probe] ${m} => ${res.status}${ok ? "" : " FAIL"} (${Date.now() - t0}ms)`);
    if (!ok) {
      console.log(`[probe]   body 头 200 字符: ${bodyText.slice(0, 200).replace(/\n/g, "\\n")}`);
      failed++;
    }
  } catch (e) {
    console.log(`[probe] ${m} => ERROR: ${e.message}`);
    failed++;
  }
}

const fp = loadFingerprint();
const models = loadModelIds();
const tools = disguiseTools();
const toolsResp = disguiseToolsResponses();
console.log(`[probe] ${new Date().toISOString()} 开始：models 列表 + ${models.length} 个模型`);
await checkModelsList();
for (const m of models) {
  await checkModel(m, fp, tools, toolsResp);
  await sleep(12000); // 免费层限流严，模型之间留间隔
}
if (failed === 0) {
  console.log("[probe] OK: 全部通过");
  process.exit(0);
} else {
  console.log(`[probe] ALERT: ${failed} 项失败`);
  process.exit(1);
}
