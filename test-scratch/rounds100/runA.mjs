// Group A test runner: R01-R40 (regression B1-B14 + interface matrix).
// Proxy: http://127.0.0.1:18781 (PORT=18781), mock upstream on 127.0.0.1:443.
// Usage: node runA.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.dirname(DIR);
const PROXY = "http://127.0.0.1:18781";
const REQLOG = path.join(SCRATCH, "requests.jsonl");
const PROXYLOG = "/tmp/proxy-18781.log";
const OUT = path.join(DIR, "A-results.jsonl");

const SPARK = "muse-spark-1.3-contributor-free";
const MIMO = "mimo-v2.6-flash-free";
const SPARK_S = SPARK + "-search";
const MIMO_S = MIMO + "-search";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function rec(round, name, pass, detail) {
  results.push({ round, name, pass, detail });
  fs.appendFileSync(OUT, JSON.stringify({ round, name, pass, detail }) + "\n");
  console.log(`${pass ? "PASS" : "FAIL"} ${round} ${name}`);
  if (!pass) console.log(`     detail: ${detail}`);
}

async function post(p, body, timeoutMs = 60000) {
  // mock 重启期（约2-3秒）可能 ECONNREFUSED：网络层抛错才重试，最多3次；
  // HTTP 状态码（4xx/5xx）是正常响应，不重试。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${PROXY}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "groupA/1.0" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      return { status: r.status, ctype: r.headers.get("content-type") || "", text };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500);
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}
function sseJson(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try { out.push(JSON.parse(p)); } catch {}
  }
  return out;
}
// Anthropic SSE: "event: X\ndata: Y" blocks
function anthEvents(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    let ev = null, data = null;
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (t.startsWith("event:")) ev = t.slice(6).trim();
      else if (t.startsWith("data:")) { const p = t.slice(5).trim(); try { data = JSON.parse(p); } catch { data = p; } }
    }
    if (ev) out.push({ event: ev, data });
  }
  return out;
}
function reqLog() {
  try {
    return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const markEntries = (entries, mark) => entries.filter((e) => e.mark === mark);
function logOffset() { try { return fs.statSync(PROXYLOG).size; } catch { return 0; } }
function logSince(off) {
  try {
    const fd = fs.openSync(PROXYLOG, "r");
    const size = fs.statSync(PROXYLOG).size;
    const buf = Buffer.alloc(Math.max(0, size - off));
    fs.readSync(fd, buf, 0, buf.length, off);
    fs.closeSync(fd);
    return buf.toString();
  } catch { return ""; }
}
const GW_TOOL = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const RESP_TOOL = { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const MSG_TOOL = { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const SHELL_LIKE_TOOL = { type: "function", function: { name: "my.shell", description: "shell-like", parameters: { type: "object", properties: { command: { type: "string" } } } } };

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("proxy not up");
}

const R = {};
// ============ R01 (B1): streamResponsesDirectWithIntercept usage 回退 ============
R.R01 = async () => {
  const off = logOffset();
  const before = reqLog().length;
  const r = await post("/v1/responses", { model: SPARK, stream: true, input: "SCN:text MARK:R01" });
  await sleep(400);
  const newLog = logSince(off);
  const resLines = newLog.split("\n").filter((l) => /#\d+ ✓/.test(l));
  const last = resLines[resLines.length - 1] || "";
  // mock 上游回的是 prompt_tokens=11/completion_tokens=7（非标准命名），修复后日志应显示 入11/出7 而非 ?
  const ok = r.status === 200 && /入11/.test(last) && /出7/.test(last);
  rec("R01", "B1 streamResponsesDirectWithIntercept usage回退", ok,
    `status=${r.status} logLine=${JSON.stringify(last.slice(0, 120))}`);
};

// ============ R02 (B2): sseToResponse 非流式 usage 回退 ============
R.R02 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: false, input: "SCN:text MARK:R02" });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const u = j?.usage;
  const ok = r.status === 200 && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R02", "B2 sseToResponse非流式usage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R03 (B3): responseToChatCompletion usage 回退 ============
R.R03 = async () => {
  const r = await post("/v1/chat/completions", { model: SPARK, stream: false, messages: [{ role: "user", content: "SCN:text MARK:R03" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const u = j?.usage;
  const ok = r.status === 200 && u?.prompt_tokens === 11 && u?.completion_tokens === 7
    && typeof j?.choices?.[0]?.message?.content === "string" && j.choices[0].message.content.includes("MOCK-RESP-TEXT");
  rec("R03", "B3 responseToChatCompletion usage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R04 (B4): responseToAnthropic usage 回退 ============
R.R04 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R04" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const u = j?.usage;
  const ok = r.status === 200 && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R04", "B4 responseToAnthropic usage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R05 (B5): 非spark转chat Anthropic组装 usage回退 ============
R.R05 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R05" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const u = j?.usage;
  // mock chat上游usage是input_tokens=11命名；旧代码(prompt_tokens??0)会得0
  const ok = r.status === 200 && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R05", "B5 非spark转chat Anthropic组装usage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R06 (B6): anthropicToResponsesBodyWithNames forceSearch显式传参 ============
R.R06 = async () => {
  const before = reqLog().length;
  await post("/v1/messages", { model: SPARK_S, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R06a" }] });
  await post("/v1/messages", { model: SPARK, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R06b" }] });
  const after = reqLog().slice(before);
  const a = markEntries(after, "R06a")[0], b = markEntries(after, "R06b")[0];
  const ta = new Set(a?.toolNames || []), tb = new Set(b?.toolNames || []);
  const ok = a && b && ta.has("webfetch") && ta.has("websearch") && !tb.has("webfetch") && !tb.has("websearch");
  rec("R06", "B6 -search显式forceSearch注入搜索工具", ok,
    `search工具名=${JSON.stringify(a?.toolNames)} 无后缀=${JSON.stringify(b?.toolNames)}`);
};

// ============ R07 (B7): streamResponsesToAnthropic thinking/text严格按序 ============
R.R07 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, messages: [{ role: "user", content: "SCN:reasoning MARK:R07" }] });
  const evs = anthEvents(r.text);
  const seq = evs.map((e) => {
    if (e.event === "content_block_start") return `start:${e.data.index}:${e.data.content_block?.type}`;
    if (e.event === "content_block_stop") return `stop:${e.data.index}`;
    if (e.event === "content_block_delta") return `delta:${e.data.index}:${e.data.delta?.type}`;
    return e.event;
  });
  const iThinkStart = seq.findIndex((s) => s === "start:0:thinking");
  const iThinkStop = seq.findIndex((s) => s === "stop:0");
  const iTextStart = seq.findIndex((s) => s === "start:1:text");
  const iTextStop = seq.findIndex((s) => s === "stop:1");
  const iMsgStop = seq.findIndex((s) => s === "message_stop");
  const thinkDeltas = evs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "thinking_delta")
    .map((e) => e.data.delta.thinking).join("");
  const stopReason = evs.find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  const ok = r.status === 200 && iThinkStart >= 0 && iThinkStop > iThinkStart && iTextStart > iThinkStop
    && iTextStop > iTextStart && iMsgStop > iTextStop && thinkDeltas.includes("MOCK-REASONING") && stopReason === "end_turn";
  rec("R07", "B7 thinking/text block严格按序开闭", ok,
    `status=${r.status} seq=${JSON.stringify(seq.slice(0, 14))} stopReason=${stopReason}`);
};

// ============ R08 (B8): translateToChat skipProxyTools 不注入webfetch/websearch ============
R.R08 = async () => {
  const before = reqLog().length;
  const r = await post("/v1/responses", { model: MIMO_S, stream: false, input: "SCN:text MARK:R08" });
  const after = reqLog().slice(before);
  const e = markEntries(after, "R08")[0];
  const tn = new Set(e?.toolNames || []);
  // 伪装read/shell照常注入，webfetch/websearch必须不注入
  const ok = r.status === 200 && e?.path === "/zen/v1/chat/completions"
    && tn.has("read") && tn.has("shell") && !tn.has("webfetch") && !tn.has("websearch");
  rec("R08", "B8 translateToChat不注入搜索工具", ok,
    `status=${r.status} upstreamPath=${e?.path} 工具名=${JSON.stringify(e?.toolNames)}`);
};

// ============ R09 (B9): streamChatToResponses respUsage回退 ============
R.R09 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: true, input: "SCN:text MARK:R09" });
  const evs = sseJson(r.text);
  const done = evs.find((e) => e.type === "response.completed");
  const u = done?.response?.usage;
  // mock chat上游usage是input_tokens=11命名
  const ok = r.status === 200 && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R09", "B9 streamChatToResponses respUsage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R10 (B10): sseToChatCompletion 稀疏tool_calls filter(Boolean) ============
R.R10 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R10" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  let args = null; try { args = JSON.parse(tc?.function?.arguments || ""); } catch {}
  const ok = r.status === 200 && Array.isArray(j?.choices?.[0]?.message?.tool_calls)
    && j.choices[0].message.tool_calls.length === 1
    && tc?.function?.name === "get_weather" && args?.city === "Beijing"
    && j?.choices?.[0]?.finish_reason === "tool_calls";
  rec("R10", "B10 sseToChatCompletion tool_calls组装", ok,
    `status=${r.status} tool=${tc?.function?.name} args=${tc?.function?.arguments} finish=${j?.choices?.[0]?.finish_reason}（注：mock无法产生稀疏索引空洞，filter(Boolean)本身为代码级防御）`);
};

// ============ R11 (B11): shell参数清理仅限shell工具 ============
R.R11 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, tools: [SHELL_LIKE_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R11" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  // mock回参{"city":"Beijing"}无command字段，清理门进去了但无改动；关键是不断言、且非shell工具(R10)同样原样
  const ok = r.status === 200 && tc?.function?.name === "my.shell" && tc?.function?.arguments === '{"city":"Beijing"}';
  rec("R11", "B11 shell参数清理仅限shell工具", ok,
    `status=${r.status} args=${tc?.function?.arguments}（mock无法产生被转义坏的shell参数，门控逻辑为代码级确认：仅name==="shell"或以.shell结尾才清理）`);
};

// ============ R12 (B12): stop_reason length→max_tokens ============
R.R12 = async () => {
  let code = "";
  try { code = execSync(`grep -n '=== "length" ? "max_tokens"' ${path.join(SCRATCH, "..", "proxy.mjs")}`, { encoding: "utf8" }); } catch {}
  const lines = code.trim().split("\n").filter(Boolean);
  // 流式(streamChatToAnthropic)与非流式(translateToChat→Anthropic组装)两处都应有映射
  const r = await post("/v1/messages", { model: MIMO, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R12" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = lines.length >= 2 && r.status === 200 && j?.stop_reason === "end_turn";
  rec("R12", "B12 stop_reason length→max_tokens映射", ok,
    `映射代码行数=${lines.length}（${lines.map((l) => l.split(":")[0]).join(",")}） stop场景end_turn=${j?.stop_reason}（注：mock无length场景，length→max_tokens本身为代码级确认）`);
};

// ============ R13 (B13): 模型名恰为"-search"时400拒绝 ============
R.R13 = async () => {
  const r = await post("/v1/chat/completions", { model: "-search", stream: false, messages: [{ role: "user", content: "hello" }] });
  const ok = r.status === 400 && r.text.includes("模型名无效");
  rec("R13", "B13 模型名恰为-search时400", ok, `status=${r.status} body=${r.text.slice(0, 80)}`);
};

// ============ R14 (B14): /v1/responses+非spark非流式 usage回退 ============
R.R14 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: false, input: "SCN:text MARK:R14" });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const u = j?.usage;
  const ok = r.status === 200 && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R14", "B14 responses+非spark非流式usage回退", ok,
    `status=${r.status} usage=${JSON.stringify(u)}`);
};

// ============ R15-R22: chat 接口矩阵 ============
const chatTextOf = (evs) => evs.map((e) => e.choices?.[0]?.delta?.content || "").join("");
const chatFinishOf = (evs) => { const f = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean); return f[f.length - 1] || null; };
const chatUsageOf = (evs) => evs.map((e) => e.usage).find(Boolean) || null;

R.R15 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:text MARK:R15" }] });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs), u = chatUsageOf(evs);
  const ok = r.status === 200 && r.ctype.includes("text/event-stream") && txt.includes("MOCK-CHAT-TEXT") && txt.includes("R15")
    && fin === "stop" && r.text.includes("data: [DONE]") && u && (u.input_tokens === 11 || u.prompt_tokens === 11);
  rec("R15", "chat流式纯文本(direct/mimo)", ok, `status=${r.status} finish=${fin} usage=${JSON.stringify(u)}`);
};

R.R16 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, messages: [{ role: "user", content: "SCN:text MARK:R16" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const msg = j?.choices?.[0]?.message;
  const ok = r.status === 200 && j?.object === "chat.completion" && msg?.content?.includes("MOCK-CHAT-TEXT") && msg?.content?.includes("R16");
  rec("R16", "chat非流式纯文本(direct/mimo)", ok, `status=${r.status} object=${j?.object}`);
};

R.R17 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R17" }] });
  const evs = sseJson(r.text);
  const tcs = [];
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0; tcs[i] = tcs[i] || { id: "", name: "", args: "" };
    if (tc.id) tcs[i].id = tc.id; if (tc.function?.name) tcs[i].name += tc.function.name;
    if (typeof tc.function?.arguments === "string") tcs[i].args += tc.function.arguments;
  }
  const fin = chatFinishOf(evs);
  const ok = r.status === 200 && tcs.length === 1 && tcs[0].name === "get_weather" && tcs[0].args === '{"city":"Beijing"}' && fin === "tool_calls";
  rec("R17", "chat流式tool_call", ok, `status=${r.status} tool=${JSON.stringify(tcs[0])} finish=${fin}`);
};

R.R18 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R18" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  let args = null; try { args = JSON.parse(tc?.function?.arguments || ""); } catch {}
  const ok = r.status === 200 && tc?.function?.name === "get_weather" && args?.city === "Beijing" && j?.choices?.[0]?.finish_reason === "tool_calls";
  rec("R18", "chat非流式tool_call", ok, `status=${r.status} finish=${j?.choices?.[0]?.finish_reason}`);
};

R.R19 = async () => {
  const r1 = await post("/v1/chat/completions", { model: MIMO, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R19a" }] });
  let j1 = null; try { j1 = JSON.parse(r1.text); } catch {}
  const tc = j1?.choices?.[0]?.message?.tool_calls?.[0];
  const callId = tc?.id || "call_mock_1";
  const r = await post("/v1/chat/completions", {
    model: MIMO, stream: true, tools: [GW_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:R19b" },
      { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] },
      { role: "tool", tool_call_id: callId, content: "72F" },
    ],
  });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && fin === "stop";
  rec("R19", "chat工具结果回传(多轮)", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0, 40))} finish=${fin}`);
};

R.R20 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:reasoning MARK:R20" }] });
  const evs = sseJson(r.text);
  const reasoning = evs.map((e) => e.choices?.[0]?.delta?.reasoning_content || "").join("");
  const txt = chatTextOf(evs), fin = chatFinishOf(evs);
  const ok = r.status === 200 && reasoning.includes("MOCK-REASONING") && txt.includes("MOCK-REASON-DONE") && fin === "stop";
  rec("R20", "chat reasoning透传", ok, `status=${r.status} reasoning=${JSON.stringify(reasoning.slice(0, 40))} finish=${fin}`);
};

R.R21 = async () => {
  const before = reqLog().length;
  const r = await post("/v1/chat/completions", { model: SPARK, stream: true, messages: [{ role: "user", content: "SCN:text MARK:R21" }] });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs), u = chatUsageOf(evs);
  const up = reqLog().slice(before).filter((e) => e.mark === "R21");
  const ok = r.status === 200 && txt.includes("MOCK-RESP-TEXT") && txt.includes("R21") && fin === "stop"
    && up.length >= 1 && up[0].path === "/zen/v1/responses";
  rec("R21", "chat spark翻译路径(chat→responses)", ok,
    `status=${r.status} upstreamPath=${up[0]?.path} finish=${fin} usage=${JSON.stringify(u)}`);
};

R.R22 = async () => {
  const r1 = await post("/v1/chat/completions", { model: MIMO, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R22a" }] });
  const evs1 = sseJson(r1.text);
  let callId = "call_mock_1";
  for (const e of evs1) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) if (tc.id) callId = tc.id;
  const r = await post("/v1/chat/completions", {
    model: MIMO, stream: true, tools: [GW_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:R22b" },
      { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] },
      { role: "tool", tool_call_id: callId, content: "sunny" },
    ],
  });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && fin === "stop";
  rec("R22", "chat多轮tool往返(流式)", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0, 40))} finish=${fin}`);
};

// ============ R23-R30: responses 接口矩阵 ============
const respTextOf = (j) => {
  const out = [];
  for (const item of j?.output || []) {
    if (item.type === "message") for (const c of item.content || []) if (c.type === "output_text") out.push(c.text);
  }
  return out.join("");
};

R.R23 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SCN:text MARK:R23" }] }] });
  const evs = sseJson(r.text);
  const done = evs.find((e) => e.type === "response.completed");
  const txt = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const ok = r.status === 200 && txt.includes("MOCK-RESP-TEXT") && txt.includes("R23")
    && done?.response?.status === "completed" && r.text.includes("response.output_text.done");
  rec("R23", "responses流式纯文本(spark直连)", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0, 40))}`);
};

R.R24 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SCN:text MARK:R24" }] }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = respTextOf(j);
  const ok = r.status === 200 && j?.object === "response" && txt.includes("MOCK-RESP-TEXT") && txt.includes("R24")
    && j?.usage?.input_tokens === 11;
  rec("R24", "responses非流式纯文本(spark直连)", ok, `status=${r.status} usage=${JSON.stringify(j?.usage)}`);
};

R.R25 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: true, tools: [RESP_TOOL], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SCN:toolcall MARK:R25" }] }] });
  const evs = sseJson(r.text);
  const added = evs.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
  const args = evs.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => e.delta).join("");
  const ok = r.status === 200 && added?.item?.name === "get_weather" && args === '{"city":"Beijing"}';
  rec("R25", "responses流式function_call", ok, `status=${r.status} name=${added?.item?.name} args=${args}`);
};

R.R26 = async () => {
  const r1 = await post("/v1/responses", { model: SPARK, stream: true, tools: [RESP_TOOL], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SCN:toolcall MARK:R26a" }] }] });
  const evs1 = sseJson(r1.text);
  const added = evs1.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
  const cid = added?.item?.call_id || "call_mock_1";
  const r = await post("/v1/responses", {
    model: SPARK, stream: false, tools: [RESP_TOOL],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "SCN:text MARK:R26b" }] },
      { type: "function_call", call_id: cid, name: "get_weather", arguments: '{"city":"Beijing"}' },
      { type: "function_call_output", call_id: cid, output: "72F" },
    ],
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = respTextOf(j);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL");
  rec("R26", "responses function_call结果回传", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0, 40))}`);
};

R.R27 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SCN:reasoning MARK:R27" }] }] });
  const evs = sseJson(r.text);
  const rs = evs.filter((e) => e.type === "response.reasoning_summary_text.delta").map((e) => e.delta).join("");
  const txt = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const ok = r.status === 200 && rs.includes("MOCK-REASONING") && txt.includes("MOCK-REASON-DONE");
  rec("R27", "responses reasoning透传", ok, `status=${r.status} reasoning=${JSON.stringify(rs.slice(0, 40))}`);
};

R.R28 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: true, input: "SCN:text MARK:R28" });
  const evs = sseJson(r.text);
  const done = evs.find((e) => e.type === "response.completed");
  const u = done?.response?.usage;
  // 上游命名(prompt_tokens)直通给客户端保留，反代内部已归一化(见R01日志)
  const ok = r.status === 200 && u?.prompt_tokens === 11 && u?.completion_tokens === 7;
  rec("R28", "responses usage双命名(直通保留上游命名)", ok, `status=${r.status} usage=${JSON.stringify(u)}`);
};

R.R29 = async () => {
  const r = await post("/v1/responses", { model: SPARK, stream: false, input: [] });
  const ok = r.status === 400;
  rec("R29", "responses空input直接400", ok, `status=${r.status} body=${r.text.slice(0, 60)}`);
};

R.R30 = async () => {
  const big = "SCN:text MARK:R30 " + "x".repeat(100000);
  const r = await post("/v1/responses", { model: SPARK, stream: false, input: big });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && respTextOf(j).includes("MOCK-RESP-TEXT");
  rec("R30", "responses超大input(100KB)", ok, `status=${r.status} inputLen=${big.length}`);
};

// ============ R31-R40: messages 接口矩阵 ============
const msgTextOf = (j) => (j?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");

R.R31 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R31" }] });
  const evs = anthEvents(r.text);
  const txt = evs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
  const stopReason = evs.find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  const hasStart = evs.some((e) => e.event === "message_start"), hasStop = evs.some((e) => e.event === "message_stop");
  const ok = r.status === 200 && hasStart && hasStop && txt.includes("MOCK-RESP-TEXT") && txt.includes("R31") && stopReason === "end_turn";
  rec("R31", "messages流式纯文本(spark)", ok, `status=${r.status} stopReason=${stopReason}`);
};

R.R32 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R32" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && j?.type === "message" && msgTextOf(j).includes("MOCK-RESP-TEXT")
    && j?.stop_reason === "end_turn" && j?.usage?.input_tokens === 11;
  rec("R32", "messages非流式纯文本(spark)", ok, `status=${r.status} stop=${j?.stop_reason} usage=${JSON.stringify(j?.usage)}`);
};

R.R33 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R33" }] });
  const evs = anthEvents(r.text);
  const start = evs.find((e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use");
  const args = evs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  const stopReason = evs.find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  const ok = r.status === 200 && start?.data?.content_block?.name === "get_weather" && args === '{"city":"Beijing"}' && stopReason === "tool_use";
  rec("R33", "messages流式tool_use", ok, `status=${r.status} name=${start?.data?.content_block?.name} args=${args} stop=${stopReason}`);
};

R.R34 = async () => {
  const r = await post("/v1/messages", {
    model: SPARK, stream: false, max_tokens: 1024, tools: [MSG_TOOL],
    messages: [
      { role: "user", content: [{ type: "text", text: "SCN:text MARK:R34" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_mock_1", name: "get_weather", input: { city: "Beijing" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_mock_1", content: "72F" }] },
    ],
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && msgTextOf(j).includes("MOCK-FINAL");
  rec("R34", "messages tool_result回传", ok, `status=${r.status} text=${JSON.stringify(msgTextOf(j).slice(0, 40))}`);
};

R.R35 = async () => {
  const before = reqLog().length;
  const r = await post("/v1/messages", { model: MIMO, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R35" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const up = reqLog().slice(before).filter((e) => e.mark === "R35");
  const ok = r.status === 200 && up.length >= 1 && up[0].path === "/zen/v1/chat/completions"
    && msgTextOf(j).includes("MOCK-CHAT-TEXT") && j?.stop_reason === "end_turn";
  rec("R35", "messages mimo→chat翻译(非流式)", ok, `status=${r.status} upstreamPath=${up[0]?.path} stop=${j?.stop_reason}`);
};

R.R36 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:reasoning MARK:R36" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const c = j?.content || [];
  const ok = r.status === 200 && c[0]?.type === "thinking" && (c[0]?.thinking || "").includes("MOCK-REASONING")
    && c[1]?.type === "text" && (c[1]?.text || "").includes("MOCK-REASON-DONE");
  rec("R36", "messages非流式thinking在前", ok, `status=${r.status} blocks=${JSON.stringify(c.map((x) => x.type))}`);
};

R.R37 = async () => {
  const ra = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, messages: [{ role: "user", content: "SCN:text MARK:R37a" }] });
  const rb = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R37b" }] });
  const sa = anthEvents(ra.text).find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  const sb = anthEvents(rb.text).find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  const ok = ra.status === 200 && rb.status === 200 && sa === "end_turn" && sb === "tool_use";
  rec("R37", "messages stop_reason枚举(end_turn/tool_use)", ok, `text=${sa} tool=${sb}`);
};

R.R38 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: true, max_tokens: 5, messages: [{ role: "user", content: "SCN:text MARK:R38" }] });
  // translateToChat流式路径(streamChatToAnthropic)的SSE没有event:前缀，用裸data解析
  const evs = sseJson(r.text);
  const stopReason = evs.find((e) => e.type === "message_delta")?.delta?.stop_reason;
  const ok = r.status === 200 && stopReason === "end_turn";
  rec("R38", "messages max_tokens小值不误报截断", ok, `status=${r.status} stop=${stopReason}（注：mock无法强制上游截断，真实length→max_tokens映射见R12代码确认）`);
};

R.R39 = async () => {
  const before = reqLog().length;
  const T2 = { name: "get_time", description: "time", input_schema: { type: "object", properties: {} } };
  const r = await post("/v1/messages", { model: SPARK, stream: true, max_tokens: 1024, tools: [MSG_TOOL, T2], messages: [{ role: "user", content: "SCN:toolcall MARK:R39" }] });
  const up = reqLog().slice(before).filter((e) => e.mark === "R39");
  const tn = new Set(up[0]?.toolNames || []);
  const evs = anthEvents(r.text);
  const ok = r.status === 200 && tn.has("get_weather") && tn.has("get_time")
    && evs.some((e) => e.event === "message_stop");
  rec("R39", "messages多工具声明透传上游", ok, `status=${r.status} 上游工具=${JSON.stringify(up[0]?.toolNames)}（注：mock每轮只回一个tool_call，并行多调用不可触发）`);
};

R.R40 = async () => {
  const r = await post("/v1/messages", { model: SPARK, stream: false, max_tokens: 1024, system: "你是R40测试助手", messages: [{ role: "user", content: "SCN:text MARK:R40" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && msgTextOf(j).includes("MOCK-RESP-TEXT");
  rec("R40", "messages system提示词不破坏请求", ok, `status=${r.status}（注：上游请求体细节requests.jsonl未记录，system→instructions翻译为代码级确认）`);
};

// ============ main ============
await waitForProxy();
try { fs.unlinkSync(OUT); } catch {}
const order = ["R01","R02","R03","R04","R05","R06","R07","R08","R09","R10","R11","R12","R13","R14","R15","R16","R17","R18","R19","R20","R21","R22","R23","R24","R25","R26","R27","R28","R29","R30","R31","R32","R33","R34","R35","R36","R37","R38","R39","R40"];
for (const k of order) {
  try { await R[k](); }
  catch (e) { rec(k, "exception", false, String(e?.message || e)); }
}
const pass = results.filter((r) => r.pass).length;
console.log(`\n==== A组完成: ${pass}/${results.length} PASS ====`);
