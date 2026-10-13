// C组自查 R71-R100：协议合规 + 上游异常 + 安全 + 杂项
// proxy A (18783, ALLOW_PRIVATE_FETCH=1), proxy B (18784, 默认拒绝私网)
// mock upstream 已扩展新 SCN（纯加法）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(DIR, "..");
const PROXY_A = "http://127.0.0.1:18783";
const PROXY_B = "http://127.0.0.1:18785"; // 曾用 18784，04:33 被其他组占用，迁移至此（默认拒绝私网抓取）
const REQLOG = path.join(SCRATCH, "requests.jsonl");
const FULLLOG = path.join(SCRATCH, "requests-full.jsonl");
const OUTF = path.join(DIR, "C-results.jsonl");

const SPARK = "muse-spark-1.3-contributor-free";
const MIMO = "mimo-v2.6-flash-free";

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForProxy(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`proxy ${base} did not come up`);
}

// mock 共享重启（约 2-3 秒 ECONNREFUSED）期间：连接级失败自动重试最多 3 次，
// HTTP 状态码本身是断言对象，不重试。
async function post(base, p, body, timeoutMs = 60000, rawBody = null, retries = 3) {
  let lastErr = null;
  for (let a = 0; a <= retries; a++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "test-C/1.0" },
        body: rawBody !== null ? rawBody : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      return { status: r.status, ctype: r.headers.get("content-type") || "", text, headers: r.headers, retried: a };
    } catch (e) {
      lastErr = e;
      if (a < retries) await sleep(1500);
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

// 增量读 SSE（R90 用）：返回 {firstDataAt, chunks:[{t,line}], text}
async function postStreamTimed(base, p, body, timeoutMs = 30000, retries = 3) {
  let lastErr = null;
  for (let a = 0; a <= retries; a++) {
    try {
      return await postStreamTimedOnce(base, p, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (a < retries) await sleep(1500);
    }
  }
  throw lastErr;
}
async function postStreamTimedOnce(base, p, body, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "test-C/1.0" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", firstDataAt = -1;
    const lines = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      text += s;
      buf += s;
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const ln of parts) {
        const lt = ln.trim();
        if (lt.startsWith("data:") && firstDataAt < 0) firstDataAt = Date.now() - t0;
        if (lt) lines.push(lt);
      }
    }
    if (buf.trim()) lines.push(buf.trim());
    return { status: r.status, ctype: r.headers.get("content-type") || "", text, lines, firstDataAt, totalMs: Date.now() - t0 };
  } finally { clearTimeout(t); }
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
// Anthropic 风格 SSE：event: X\ndata: {...}
function anthEvents(text) {
  const out = [];
  const blocks = text.split(/\n\n/);
  for (const b of blocks) {
    const em = b.match(/^event:\s*(\S+)/m);
    const dm = b.match(/^data:\s*(\{[\s\S]*\})\s*$/m);
    if (em && dm) {
      try { out.push({ event: em[1], data: JSON.parse(dm[1]) }); } catch {}
    }
  }
  return out;
}
function reqLog() {
  try { return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function fullLog() {
  try { return fs.readFileSync(FULLLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
const myMarks = (entries) => entries.filter((e) => typeof e.mark === "string" && /^ZC/.test(e.mark));

function rec(round, name, pass, detail) {
  results.push({ round, name, pass: !!pass, detail: String(detail).slice(0, 900) });
  console.log(`${pass ? "PASS" : "FAIL"} ${round} ${name}`);
  if (!pass) console.log(`     detail: ${String(detail).slice(0, 500)}`);
}

const GW_TOOL = { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } };
const RESP_TOOL = { type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } };
const MSG_TOOL = { name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } };

// ================= 协议合规 R71-R80 =================
async function t_R71() {
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:thinktext MARK:ZC71" }] });
  const evs = anthEvents(r.text);
  const probs = [];
  const starts = new Map(); // index -> {type, pos}
  const stops = new Map();  // index -> count
  const order = [];
  evs.forEach((e, pos) => {
    const d = e.data;
    if (e.event === "content_block_start") {
      if (starts.has(d.index)) probs.push(`index ${d.index} 重复 start`);
      starts.set(d.index, { type: d.content_block?.type, pos });
      order.push(`start${d.index}:${d.content_block?.type}`);
    } else if (e.event === "content_block_stop") {
      if (!starts.has(d.index)) probs.push(`index ${d.index} 未 start 先 stop`);
      stops.set(d.index, (stops.get(d.index) || 0) + 1);
      order.push(`stop${d.index}`);
    } else if (e.event === "content_block_delta") {
      const st = starts.get(d.index);
      if (!st) probs.push(`index ${d.index} delta 无 start`);
      if (stops.has(d.index)) probs.push(`index ${d.index} stop 后还有 delta`);
    }
  });
  // 每个 start 恰好一个 stop
  for (const [i] of starts) if (stops.get(i) !== 1) probs.push(`index ${i} stop 次数=${stops.get(i) || 0}`);
  // 期望顺序：thinking(0) -> text(1) -> tool_use(2)
  const types = [...starts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.type);
  const expectTypes = ["thinking", "text", "tool_use"];
  if (JSON.stringify(types) !== JSON.stringify(expectTypes)) probs.push(`block 类型顺序=${JSON.stringify(types)} 期望=${JSON.stringify(expectTypes)}`);
  // 索引严格递增
  const idxs = [...starts.keys()];
  if (JSON.stringify(idxs) !== JSON.stringify([0, 1, 2])) probs.push(`block 索引=${JSON.stringify(idxs)}`);
  const md = evs.find((e) => e.event === "message_delta");
  const hasStop = evs.some((e) => e.event === "message_stop");
  if (md?.data?.delta?.stop_reason !== "tool_use") probs.push(`stop_reason=${md?.data?.delta?.stop_reason}`);
  if (!hasStop) probs.push("缺 message_stop");
  rec("R71", "Anthropic SSE thinking→text→tool_use 开闭顺序", r.status === 200 && probs.length === 0,
    `status=${r.status} order=[${order.join(" ")}] probs=[${probs.join(";") || "无"}]`);
}

async function t_R72() {
  // R71 同一响应已覆盖严格开闭；这里再测上游异常截断（空 body）时无悬挂 block
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:empty MARK:ZC72" }] });
  const evs = anthEvents(r.text);
  const starts = evs.filter((e) => e.event === "content_block_start").length;
  const stops = evs.filter((e) => e.event === "content_block_stop").length;
  const hasStart = evs.some((e) => e.event === "message_start");
  const hasStop = evs.some((e) => e.event === "message_stop");
  const ok = r.status === 200 && starts === stops && hasStart && hasStop;
  rec("R72", "流结束无未关闭 block（含上游空 body 兜底）", ok,
    `status=${r.status} starts=${starts} stops=${stops} message_start=${hasStart} message_stop=${hasStop} bodyLen=${r.text.length}`);
}

async function t_R73() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC73" }] });
  const probs = [];
  let n = 0, usageChunks = 0;
  for (const line of r.text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    n++;
    let o; try { o = JSON.parse(p); } catch { probs.push(`第${n}行 JSON 解析失败`); continue; }
    for (const f of ["id", "created", "model", "object"]) if (!(f in o)) probs.push(`第${n}行缺字段 ${f}`);
    if (o.object !== "chat.completion.chunk") probs.push(`第${n}行 object=${o.object}`);
    if (!Array.isArray(o.choices)) { probs.push(`第${n}行 choices 非数组`); continue; }
    if (o.choices.length > 0 && (typeof o.choices[0].delta !== "object" || o.choices[0].delta === null)) probs.push(`第${n}行 choices[0].delta 缺失`);
    if (o.usage) { usageChunks++; if (o.choices.length !== 0) probs.push(`usage chunk choices 非空（非标准）`); }
  }
  // OpenAI 原生 stream_options usage 块就是 choices:[]，属合规
  const ok = r.status === 200 && n > 0 && probs.length === 0;
  rec("R73", "chat chunk 格式：id/created/model/object 齐全", ok,
    `status=${r.status} chunks=${n} usageChunks=${usageChunks} probs=[${probs.join(";") || "无"}]（usage 块 choices:[] 为 OpenAI 原生约定）`);
}

async function t_R74() {
  const c = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC74a" }] });
  const rp = await post(PROXY_A, "/v1/responses", { model: SPARK, stream: true, input: [{ role: "user", content: "SCN:text MARK:ZC74b" }] });
  const m = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC74c" }] });
  const chatDone = c.text.trimEnd().endsWith("data: [DONE]");
  const rpevs = sseJson(rp.text);
  const respDone = rpevs.some((e) => e.type === "response.completed");
  const mevs = anthEvents(m.text);
  const msgDone = mevs.some((e) => e.event === "message_stop");
  // 各协议正确终结：chat=[DONE]；responses=response.completed（协议无[DONE]）；anthropic=message_stop
  const ok = c.status === 200 && chatDone && rp.status === 200 && respDone && m.status === 200 && msgDone;
  rec("R74", "三接口流式正确终结", ok,
    `chat[DONE]=${chatDone} responses[completed]=${respDone}（协议无[DONE]） anthropic[message_stop]=${msgDone}`);
}

async function t_R75() {
  const probs = [];
  // chat 翻译路径（spark）：usage 应只在最后 JSON 块出现一次
  const c = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC75a" }] });
  const cevs = sseJson(c.text);
  const cUsageIdx = cevs.map((e, i) => (e.usage ? i : -1)).filter((i) => i >= 0);
  const cFinIdx = cevs.map((e, i) => (e.choices?.[0]?.finish_reason ? i : -1)).filter((i) => i >= 0);
  if (cUsageIdx.length !== 1) probs.push(`chat usage 出现${cUsageIdx.length}次`);
  if (cUsageIdx.length === 1 && cUsageIdx[0] !== cevs.length - 1) probs.push(`chat usage 不在最后块(idx=${cUsageIdx[0]}/${cevs.length - 1})`);
  if (cUsageIdx.length === 1 && cFinIdx.length && cUsageIdx[0] < cFinIdx[cFinIdx.length - 1]) probs.push("chat usage 在 finish 之前");
  // responses 直连：usage 只在 response.completed
  const rp = await post(PROXY_A, "/v1/responses", { model: SPARK, stream: true, input: [{ role: "user", content: "SCN:text MARK:ZC75b" }] });
  const rpevs = sseJson(rp.text);
  const earlyUsage = rpevs.filter((e) => e.type !== "response.completed" && e.response?.usage);
  const compCount = rpevs.filter((e) => e.type === "response.completed").length;
  if (earlyUsage.length) probs.push(`responses 非终态 usage ${earlyUsage.length}处`);
  if (compCount !== 1) probs.push(`responses completed 出现${compCount}次`);
  // anthropic：usage 只在 message_delta
  const m = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC75c" }] });
  const mevs = anthEvents(m.text);
  const mUsage = mevs.filter((e) => e.event !== "message_delta" && e.data?.usage);
  const mdCount = mevs.filter((e) => e.event === "message_delta").length;
  if (mUsage.length) probs.push(`anthropic 非 message_delta usage ${mUsage.length}处`);
  if (mdCount !== 1) probs.push(`anthropic message_delta 出现${mdCount}次`);
  rec("R75", "usage 只在终态出现一次", probs.length === 0, probs.length ? probs.join(";") : "chat/responses/anthropic 各 1 次终态 usage");
}

async function t_R76() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: false, messages: [{ role: "user", content: "SCN:text MARK:ZC76" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const msg = j?.choices?.[0]?.message;
  const ok = r.status === 200 && j?.object === "chat.completion"
    && typeof msg?.content === "string" && msg.content.includes("MOCK-RESP-TEXT") && msg.content.includes("ZC76")
    && msg?.role === "assistant" && j?.usage && typeof j.usage.prompt_tokens === "number";
  rec("R76", "非流式 chat 含完整 message+usage", ok,
    `status=${r.status} object=${j?.object} role=${msg?.role} contentLen=${msg?.content?.length} usage=${JSON.stringify(j?.usage)}`);
}

async function t_R77() {
  const r = await post(PROXY_A, "/v1/responses", { model: SPARK, stream: false, input: [{ role: "user", content: "SCN:text MARK:ZC77" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = j?.output?.find((o) => o.type === "message")?.content?.[0]?.text || "";
  const ok = r.status === 200 && j?.object === "response" && Array.isArray(j?.output) && j.output.length > 0
    && txt.includes("MOCK-RESP-TEXT") && j?.usage && typeof j.usage.input_tokens === "number";
  rec("R77", "非流式 responses 含 output+usage", ok,
    `status=${r.status} object=${j?.object} outputLen=${j?.output?.length} usage=${JSON.stringify(j?.usage)}`);
}

async function t_R78() {
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: false, messages: [{ role: "user", content: "SCN:text MARK:ZC78" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = (j?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const ok = r.status === 200 && j?.type === "message" && Array.isArray(j?.content) && j.content.length > 0
    && txt.includes("MOCK-RESP-TEXT") && typeof j?.stop_reason === "string" && j?.usage?.input_tokens > 0;
  rec("R78", "非流式 anthropic 含 content+stop_reason+usage", ok,
    `status=${r.status} type=${j?.type} stop=${j?.stop_reason} usage=${JSON.stringify(j?.usage)}`);
}

async function t_R79() {
  const probs = [];
  // 直接路径（mimo chat）：上游 id 应原样到客户端；回传后上游 follow-up 体里 id 不变
  const r1 = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:ZC79a" }] });
  const evs = sseJson(r1.text);
  let cid = null;
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) if (tc.id) cid = tc.id;
  if (cid !== "call_mock_1") probs.push(`直接路径客户端收到 id=${cid}（期望 call_mock_1）`);
  const f0 = fullLog().length;
  await post(PROXY_A, "/v1/chat/completions", {
    model: MIMO, stream: true, tools: [GW_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:ZC79b" },
      { role: "assistant", tool_calls: [{ id: cid, type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] },
      { role: "tool", tool_call_id: cid, content: "sunny" },
    ],
  });
  const fu = fullLog().slice(f0).filter((e) => e.mark === "ZC79b" && e.followUp);
  const upId = fu[0]?.body?.messages?.[2]?.tool_call_id;
  if (upId !== "call_mock_1") probs.push(`直接路径上游 follow-up tool_call_id=${upId}`);
  // 翻译路径（spark chat -> responses 上游）：function_call call_id 链
  const r2 = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:ZC79c" }] });
  const evs2 = sseJson(r2.text);
  let cid2 = null;
  for (const e of evs2) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) if (tc.id) cid2 = tc.id;
  if (cid2 !== "call_mock_1") probs.push(`翻译路径客户端收到 id=${cid2}`);
  const f1 = fullLog().length;
  await post(PROXY_A, "/v1/chat/completions", {
    model: SPARK, stream: true, tools: [GW_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:ZC79d" },
      { role: "assistant", tool_calls: [{ id: cid2, type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] },
      { role: "tool", tool_call_id: cid2, content: "sunny" },
    ],
  });
  const fu2 = fullLog().slice(f1).filter((e) => e.mark === "ZC79d" && e.followUp);
  const out = (fu2[0]?.body?.input || []).find((m) => m.type === "function_call_output");
  if (out?.call_id !== "call_mock_1") probs.push(`翻译路径上游 function_call_output call_id=${out?.call_id}`);
  rec("R79", "tool_call id 请求→上游→客户端不断链", probs.length === 0, probs.length ? probs.join(";") : "直接/翻译两路径 id=call_mock_1 全链一致");
}

async function t_R80() {
  const probs = [];
  // responses 直连：reasoning_summary_text.delta 不丢
  const rp = await post(PROXY_A, "/v1/responses", { model: SPARK, stream: true, input: [{ role: "user", content: "SCN:reasoning MARK:ZC80a" }] });
  const rpevs = sseJson(rp.text);
  const rsum = rpevs.filter((e) => e.type === "response.reasoning_summary_text.delta").map((e) => e.delta).join("");
  const rtxt = rpevs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  if (rsum !== "MOCK-REASONING ") probs.push(`responses reasoning=${JSON.stringify(rsum)}`);
  if (!rtxt.includes("MOCK-REASON-DONE")) probs.push("responses 正文丢失");
  if (rsum.includes("MOCK-REASON-DONE") || rtxt.includes("MOCK-REASONING ")) probs.push("responses 推理/正文串了");
  // anthropic：thinking block 不丢不串
  const m = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:reasoning MARK:ZC80b" }] });
  const mevs = anthEvents(m.text);
  const think = mevs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "thinking_delta").map((e) => e.data.delta.thinking).join("");
  const mtxt = mevs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
  const thinkIdx = mevs.findIndex((e) => e.event === "content_block_start" && e.data?.content_block?.type === "thinking");
  const textIdx = mevs.findIndex((e) => e.event === "content_block_start" && e.data?.content_block?.type === "text");
  if (think !== "MOCK-REASONING ") probs.push(`anthropic thinking=${JSON.stringify(think)}`);
  if (!mtxt.includes("MOCK-REASON-DONE")) probs.push("anthropic 正文丢失");
  if (!(thinkIdx >= 0 && textIdx > thinkIdx)) probs.push("anthropic thinking/text 顺序错");
  // chat 翻译路径：reasoning_content 不丢
  const c = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: true, messages: [{ role: "user", content: "SCN:reasoning MARK:ZC80c" }] });
  const cevs = sseJson(c.text);
  const rc = cevs.map((e) => e.choices?.[0]?.delta?.reasoning_content || "").join("");
  const ctxt = cevs.map((e) => e.choices?.[0]?.delta?.content || "").join("");
  if (!rc.includes("MOCK-REASONING")) probs.push(`chat reasoning_content 丢失=${JSON.stringify(rc.slice(0, 40))}`);
  if (!ctxt.includes("MOCK-REASON-DONE")) probs.push("chat 正文丢失");
  rec("R80", "reasoning 内容不丢不串（三接口）", probs.length === 0, probs.length ? probs.join(";") : "reasoning 与正文各自完整、未串扰");
}

// ================= 上游异常 R81-R92 =================
async function t_errRound(round, name, scn, endpoint, model, stream, wantStatus) {
  const body = stream === "sse-body"
    ? { model, stream: true, messages: [{ role: "user", content: `SCN:${scn} MARK:${round}` }] }
    : null;
  let r;
  if (endpoint === "chat") r = await post(PROXY_A, "/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: `SCN:${scn} MARK:${round}` }] });
  else if (endpoint === "responses") r = await post(PROXY_A, "/v1/responses", { model, stream: false, input: [{ role: "user", content: `SCN:${scn} MARK:${round}` }] });
  else r = await post(PROXY_A, "/v1/messages", { model, max_tokens: 64, stream: true, messages: [{ role: "user", content: `SCN:${scn} MARK:${round}` }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const okShape = j && typeof j.error === "object" && typeof j.error.message === "string";
  const noLeak = !/\.mjs:|at\s+\S+\s*\(|node_modules|\/home\/hatch|stack/.test(r.text);
  const ok = r.status === wantStatus && okShape && noLeak && j.error.message.includes("mock");
  rec(round, name, ok,
    `status=${r.status}(期望${wantStatus}) msg=${JSON.stringify(j?.error?.message)} type=${j?.error?.type} 无堆栈泄露=${noLeak}`);
  void body;
}

async function t_R87() {
  // 30s 慢上游：proxy 总超时 300s，不应提前掐断、不应挂起
  const t0 = Date.now();
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:slow30 MARK:ZC87" }] }, 60000);
  const dt = Date.now() - t0;
  const txt = sseJson(r.text).map((e) => e.choices?.[0]?.delta?.content || "").join("");
  const okSlow = r.status === 200 && dt >= 25000 && dt < 60000 && txt.includes("MOCK-CHAT-TEXT") && r.text.includes("data: [DONE]");
  // 客户端中途断开：proxy 不应崩，后续请求正常
  const ctl = new AbortController();
  const p = fetch(`${PROXY_A}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:slow30 MARK:ZC87b" }] }),
    signal: ctl.signal,
  });
  setTimeout(() => ctl.abort(), 2000);
  let aborted = false;
  try { const rr = await p; await rr.text(); } catch (e) { aborted = e?.name === "AbortError"; }
  await sleep(500);
  let alive = false;
  try { const h = await fetch(`${PROXY_A}/health`); alive = h.ok; } catch {}
  const r2 = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:text MARK:ZC87c" }] }, 30000);
  const ok = okSlow && aborted && alive && r2.status === 200 && r2.text.includes("MOCK-CHAT-TEXT");
  rec("R87", "上游 30s 慢响应不挂起 + 客户端断开不崩", ok,
    `慢响应: status=${r.status} 耗时=${(dt / 1000).toFixed(1)}s 内容完整=${txt.includes("MOCK-CHAT-TEXT")} | 客户端断开已中止=${aborted} proxy存活=${alive} 后续请求=${r2.status}`);
}

async function t_R88() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:empty MARK:ZC88" }] }, 30000);
  const hasDone = r.text.includes("data: [DONE]");
  // 如实记录：空上游不崩不挂起即合格；[DONE] 缺失则记为待改进
  const ok = r.status === 200;
  rec("R88", "上游空 body 不崩不挂起", ok,
    `status=${r.status} ctype=${r.ctype} bodyLen=${r.text.length} 有[DONE]=${hasDone}${hasDone ? "" : "（空流未补[DONE]，见 C-bugs.md）"}`);
  return hasDone;
}

async function t_R89() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:html MARK:ZC89" }] }, 30000);
  const ok = r.status === 200 && r.ctype.includes("text/html") && r.text.includes("mock html error page");
  rec("R89", "上游 HTML 错误页原样透传", ok, `status=${r.status} ctype=${r.ctype} body=${r.text.slice(0, 70)}`);
}

async function t_R90() {
  const s = await postStreamTimed(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:chunks MARK:ZC90" }] }, 30000);
  const dataLines = s.lines.filter((l) => l.startsWith("data:"));
  const txt = sseJson(s.text).map((e) => e.choices?.[0]?.delta?.content || "").join("");
  const streaming = s.firstDataAt >= 0 && s.firstDataAt < s.totalMs * 0.7;
  const ok = s.status === 200 && dataLines.length >= 3 && txt.includes("MOCK-CHAT-TEXT") && s.text.includes("data: [DONE]") && streaming;
  rec("R90", "上游分块慢响应：真流式透传", ok,
    `status=${s.status} 首块=${s.firstDataAt}ms 总耗时=${s.totalMs}ms data行=${dataLines.length} 内容完整=${txt.includes("MOCK-CHAT-TEXT")} 真流式=${streaming}`);
}

async function t_R91() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:nonjson MARK:ZC91" }] }, 30000);
  const ok = r.status === 200 && r.ctype.includes("text/plain") && r.text.includes("this is not json");
  rec("R91", "上游 200 非 JSON 原样透传", ok, `status=${r.status} ctype=${r.ctype} body=${r.text.slice(0, 60)}`);
}

async function t_R92() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:redirect MARK:ZC92" }] }, 30000);
  const txt = sseJson(r.text).map((e) => e.choices?.[0]?.delta?.content || "").join("");
  const ok = r.status === 200 && txt.includes("MOCK-CHAT-TEXT") && r.text.includes("data: [DONE]");
  rec("R92", "上游 302 重定向被跟随、无挂起", ok,
    `status=${r.status} 跟随后内容完整=${txt.includes("MOCK-CHAT-TEXT")}（fetch 默认跟随跳转）`);
}

// ================= 安全 R93-R98 =================
async function t_R93() {
  // proxy B：默认拒绝私网。用 -search 触发 webfetch 探针
  const cases = [
    ["ZC93a", "http://127.0.0.1:18901/page"],
    ["ZC93b", "http://10.0.0.1/"],
    ["ZC93c", "http://192.168.1.1/"],
  ];
  const probs = [];
  for (const [mark, url] of cases) {
    const r = await post(PROXY_B, "/v1/chat/completions", {
      model: MIMO + "-search", stream: true,
      messages: [{ role: "user", content: `SCN:fetchprobe MARK:${mark} URL:${url}` }],
    }, 60000);
    const blocked = r.text.includes("不允许抓取内网地址");
    const leaked = r.text.includes("FETCH-TARGET-CONTENT");
    if (!blocked) probs.push(`${url} 未被拦截`);
    if (leaked) probs.push(`${url} 实际抓到了内网内容！`);
  }
  rec("R93", "webfetch 内网地址被拦截（默认）", probs.length === 0,
    probs.length ? probs.join(";") : "127.0.0.1/10.0.0.1/192.168.1.1 均被 SSRF 拦截");
}

async function t_R94() {
  // proxy A（ALLOW_PRIVATE_FETCH=1）：外网地址放行
  const r = await post(PROXY_A, "/v1/chat/completions", {
    model: MIMO + "-search", stream: true,
    messages: [{ role: "user", content: "SCN:fetchprobe MARK:ZC94 URL:http://example.com/" }],
  }, 90000);
  const okFetch = r.text.includes("documentation examples"); // example.com 正文特征
  const blocked = r.text.includes("不允许抓取内网地址");
  rec("R94", "webfetch 外网地址正常放行", r.status === 200 && okFetch && !blocked,
    `status=${r.status} 抓到Example Domain=${okFetch} 被误拦=${blocked}`);
}

function t_R95() {
  // 仓库级密钥扫描（proxy.mjs + 周边脚本 + 启动脚本）
  const files = ["proxy.mjs", "proxy-mini.mjs", "worker.js", "install.sh", "start.sh",
    "test-scratch/mock-upstream.mjs", "test-scratch/redirect-dns.mjs", "test-scratch/fetch-target.mjs",
    "test-scratch/rounds100/runC.mjs"];
  const hits = [];
  for (const f of files) {
    let src = "";
    try { src = fs.readFileSync(path.join("/home/hatch/workspace/opencode-proxy", f), "utf8"); } catch { continue; }
    const lines = src.split("\n");
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|#|\*)/.test(ln)) return; // 跳过注释行
      const m = ln.match(/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)/);
      if (m) hits.push(`${f}:${i + 1}: ${m[1].slice(0, 12)}...`);
      const kv = ln.match(/(api[_-]?key|secret|passwd|password|bearer)\s*[:=]\s*["']([^"'<>\s]{12,})["']/i);
      if (kv && !/redacted|example|placeholder|xxx/i.test(kv[2])) hits.push(`${f}:${i + 1}: 疑似硬编码 ${kv[1]}`);
    });
  }
  rec("R95", "仓库无硬编码密钥", hits.length === 0, hits.length ? hits.join(";") : `扫描 ${files.length} 个文件，无硬编码 key/token/私钥`);
}

async function t_R96() {
  // 全部翻译路径：上游请求体 model 结尾永不残留 -search 后缀
  // （R99 的对抗变体 ZC99* 由 R99 自己断言，此处排除，避免同一 bug 重复计）
  const bad = [];
  let n = 0;
  for (const e of myMarks(fullLog())) {
    if (/^ZC99/.test(e.mark || "")) continue;
    n++;
    const m = e.body?.model;
    if (typeof m === "string" && m.endsWith("-search")) bad.push(`${e.mark}: upstreamModel=${m}`);
  }
  rec("R96", "-search 后缀永不进入上游请求体", bad.length === 0,
    bad.length ? bad.join(";") : `检查 ${n} 个上游请求体（含 -search 触发的 R93/R94），model 结尾均无 -search`);
}

async function t_R97() {
  let r = null, lastErr = null;
  for (let a = 0; a <= 3; a++) {
    try { r = await fetch(`${PROXY_A}/v1/chat/completions`, { method: "OPTIONS" }); break; }
    catch (e) { lastErr = e; await sleep(1500); }
  }
  if (!r) throw lastErr;
  const h = r.headers;
  const ok = r.status === 204
    && h.get("access-control-allow-origin") === "*"
    && (h.get("access-control-allow-methods") || "").includes("OPTIONS")
    && (h.get("access-control-allow-headers") || "").includes("*");
  rec("R97", "CORS OPTIONS 预检头正确", ok,
    `status=${r.status} allow-origin=${h.get("access-control-allow-origin")} methods=${h.get("access-control-allow-methods")} headers=${h.get("access-control-allow-headers")} max-age=${h.get("access-control-max-age")}`);
}

async function t_R98() {
  const probs = [];
  // 1) 上游 500 透传：normalizeUpstreamError 不应带堆栈
  const r1 = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:err500 MARK:ZC98a" }] });
  if (/\.mjs:\d+|at\s+[\w$.]+\s*\(|node_modules|\/home\/|Traceback|stack/i.test(r1.text)) probs.push("上游500透传体含堆栈/路径");
  // 2) 畸形 JSON 请求体：proxy 自身 400 不应泄露
  const r2 = await post(PROXY_A, "/v1/chat/completions", {}, 30000, "{not-json");
  if (/\.mjs:\d+|at\s+[\w$.]+\s*\(|node_modules|\/home\/hatch|SyntaxError.*at /s.test(r2.text)) probs.push(`畸形请求 400 泄露：${r2.text.slice(0, 120)}`);
  // 3) 空模型名
  const r3 = await post(PROXY_A, "/v1/chat/completions", { model: "-search", stream: true, messages: [{ role: "user", content: "hi" }] });
  if (/\.mjs:\d+|at\s+[\w$.]+\s*\(|\/home\/hatch/.test(r3.text)) probs.push("空模型名 400 泄露");
  const ok = probs.length === 0 && r1.status === 500 && r2.status === 400;
  rec("R98", "错误响应不泄露堆栈/内网信息", ok,
    probs.length ? probs.join(";") : `上游500=${r1.status} 畸形JSON=${r2.status} 空模型=${r3.status}，均无堆栈/路径泄露`);
}

// ================= 杂项 R99-R100 =================
async function t_R99() {
  const probs = [];
  const notes = [];
  const variants = [
    ["ZC99a", "MIMO-V2.6-FLASH-FREE", "大写"],
    ["ZC99b", " mimo-v2.6-flash-free ", "首尾空格"],
    ["ZC99c", "mimo-v2.6-flash-free-search-search", "双-search"],
    ["ZC99d", "mimo-search-v2.6-flash-free", "-search在中间"],
    ["ZC99e", "mimo-v2.6-flash-free-SEARCH", "大写后缀"],
    ["ZC99f", "-searchmimo-v2.6-flash-free", "-search在开头"],
  ];
  for (const [mark, model, label] of variants) {
    const f0 = fullLog().length;
    let r;
    try {
      r = await post(PROXY_A, "/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: `SCN:text MARK:${mark}` }] }, 45000);
    } catch (e) { probs.push(`${label}: 请求异常 ${e?.message}`); continue; }
    const up = fullLog().slice(f0).filter((e) => e.mark === mark);
    const upModel = up[0]?.body?.model;
    notes.push(`${label}→http${r.status}/上游model=${JSON.stringify(upModel)}`);
    if (r.status !== 200) probs.push(`${label}: http=${r.status}`);
    // 只有"结尾残留 -search" 才是剥离不彻底；中间/开头出现属字面量，不应剥
    if (typeof upModel === "string" && upModel.endsWith("-search")) probs.push(`${label}: 上游 model 结尾残留 -search（${upModel}）`);
    // 非后缀变体不应误触发 forceSearch（上游不应被注入 webfetch/websearch）
    const upTools = (reqLog().slice(0).filter((e) => e.mark === mark)[0]?.toolNames) || [];
    if (!model.endsWith("-search") && (upTools.includes("webfetch") || upTools.includes("websearch")))
      probs.push(`${label}: 非后缀模型误触发搜索注入 tools=${JSON.stringify(upTools)}`);
  }
  // 纯 "-search" 应干净 400
  const r0 = await post(PROXY_A, "/v1/chat/completions", { model: "-search", stream: true, messages: [{ role: "user", content: "hi" }] });
  if (r0.status !== 400) probs.push(`纯-search 期望400 实际=${r0.status}`);
  rec("R99", "模型名变体鲁棒性", probs.length === 0, `${probs.length ? probs.join(";") : "全部完成无挂起"} | ${notes.join(" | ")}`);
}

async function t_R100() {
  const probs = [];
  const got = {};
  const finOf = (evs) => { const f = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean); return f[f.length - 1] || null; };
  // chat 直接路径（mimo）：上游 finish_reason 原样透传
  const cases = [["ZC100a", "text", "stop"], ["ZC100b", "len", "length"], ["ZC100c", "toolcall", "tool_calls"], ["ZC100d", "cf", "content_filter"]];
  for (const [mark, scn, want] of cases) {
    const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: `SCN:${scn} MARK:${mark}` }] });
    const f = finOf(sseJson(r.text));
    got[`chat/${scn}`] = f;
    if (f !== want) probs.push(`chat ${scn}: finish=${f} 期望=${want}`);
  }
  // chat 翻译路径（spark）：incomplete 映射
  const tcases = [["ZC100e", "text", "stop"], ["ZC100f", "len", "length"], ["ZC100g", "toolcall", "tool_calls"]];
  for (const [mark, scn, want] of tcases) {
    const r = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: `SCN:${scn} MARK:${mark}` }] });
    const f = finOf(sseJson(r.text));
    got[`spark-chat/${scn}`] = f;
    if (f !== want) probs.push(`spark-chat ${scn}: finish=${f} 期望=${want}`);
  }
  // 翻译路径 content_filter：incomplete reason=content_filter 当前映射
  const rcf = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: true, messages: [{ role: "user", content: "SCN:cf MARK:ZC100h" }] });
  const fcf = finOf(sseJson(rcf.text));
  got["spark-chat/cf"] = fcf;
  if (fcf !== "content_filter") probs.push(`spark-chat cf: finish=${fcf}（content_filter 在翻译中丢失，期望 content_filter）`);
  // anthropic 路径
  const acases = [["ZC100i", "text", "end_turn"], ["ZC100j", "len", "max_tokens"], ["ZC100k", "toolcall", "tool_use"]];
  for (const [mark, scn, want] of acases) {
    const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, tools: [MSG_TOOL], messages: [{ role: "user", content: `SCN:${scn} MARK:${mark}` }] });
    const md = anthEvents(r.text).find((e) => e.event === "message_delta");
    const f = md?.data?.delta?.stop_reason || null;
    got[`anthropic/${scn}`] = f;
    if (f !== want) probs.push(`anthropic ${scn}: stop=${f} 期望=${want}`);
  }
  const rcf2 = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:cf MARK:ZC100l" }] });
  const fcf2 = anthEvents(rcf2.text).find((e) => e.event === "message_delta")?.data?.delta?.stop_reason;
  got["anthropic/cf"] = fcf2;
  if (fcf2 !== "content_filter") probs.push(`anthropic cf: stop=${fcf2}（content_filter 在翻译中丢失）`);
  // error：协议层面无此终结符（错误走 HTTP 状态码），确认代码无 finish_reason=error
  let hasErrorFR = false;
  try {
    const src = fs.readFileSync("/home/hatch/workspace/opencode-proxy/proxy.mjs", "utf8");
    hasErrorFR = /finish_reason:\s*["']error["']|stop_reason:\s*["']error["']/.test(src);
  } catch {}
  got["error"] = hasErrorFR ? "存在" : "N/A（协议无此终结符，错误走HTTP状态码）";
  rec("R100", "stop_reason 全枚举映射", probs.length === 0, `${probs.length ? probs.join(";") : "全部映射正确"} | ${JSON.stringify(got)}`);
}

async function t_R109() {
  const r = await post(PROXY_A, "/v1/responses", { model: SPARK, stream: false, tools: [RESP_TOOL], input: [{ role: "user", content: "SCN:toolcall MARK:ZC109" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const fn = (j?.output || []).find((o) => o.type === "function_call");
  let args = null; try { args = JSON.parse(fn?.arguments || ""); } catch {}
  const ok = r.status === 200 && fn?.name === "get_weather" && args?.city === "Beijing"
    && typeof fn?.call_id === "string" && j?.status === "completed";
  rec("R109", "非流式 responses function_call 完整", ok,
    `status=${r.status} fn=${fn?.name} args=${fn?.arguments} call_id=${fn?.call_id} status=${j?.status}`);
}

async function t_R110() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: SPARK, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:ZC110" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  let args = null; try { args = JSON.parse(tc?.function?.arguments || ""); } catch {}
  const ok = r.status === 200 && tc?.function?.name === "get_weather" && args?.city === "Beijing"
    && typeof tc?.id === "string" && j?.choices?.[0]?.finish_reason === "tool_calls" && j?.usage?.prompt_tokens === 21;
  rec("R110", "非流式 chat 翻译路径 tool_call 完整", ok,
    `status=${r.status} tool=${tc?.function?.name} id=${tc?.id} finish=${j?.choices?.[0]?.finish_reason} usage=${JSON.stringify(j?.usage)}`);
}

async function t_R111() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: false, messages: [{ role: "user", content: "SCN:emptyjson MARK:ZC111" }] }, 30000);
  const ok = r.status === 200 && r.text.trim() === "{}";
  rec("R111", "上游 200 空 JSON 非流式透传不崩", ok, `status=${r.status} body=${r.text.slice(0, 40)}`);
}

// ================= main =================
async function main() {
  await waitForProxy(PROXY_A);
  await waitForProxy(PROXY_B);
  await t_R71(); await t_R72(); await t_R73(); await t_R74(); await t_R75();
  await t_R76(); await t_R77(); await t_R78(); await t_R79(); await t_R80();
  await t_errRound("R81", "上游400透传", "err400", "chat", MIMO, true, 400);
  await t_errRound("R82", "上游401透传", "err401", "chat", MIMO, true, 401);
  await t_errRound("R83", "上游403透传", "err403", "chat", MIMO, true, 403);
  await t_errRound("R84", "上游429透传", "err429", "chat", MIMO, true, 429);
  await t_errRound("R85", "上游500透传", "err500", "chat", MIMO, true, 500);
  await t_errRound("R86", "上游502透传", "err502", "chat", MIMO, true, 502);
  await t_errRound("R81b", "上游500透传(responses非流式)", "err500", "responses", SPARK, false, 500);
  await t_errRound("R84b", "上游429透传(messages流式)", "err429", "messages", SPARK, true, 429);
  await t_R87();
  const r88done = await t_R88();
  await t_R89(); await t_R90(); await t_R91(); await t_R92();
  await t_R93(); await t_R94(); t_R95(); await t_R96(); await t_R97(); await t_R98();
  await t_R99(); await t_R100();
  await t_R101(); await t_R102(); await t_R103(); await t_R104();
  await t_R105(); await t_R106(); await t_R107(); await t_R108();
  await t_R109(); await t_R110(); await t_R111();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== C组 ${pass}/${results.length} passed ====`);
  fs.writeFileSync(OUTF, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (!r88done) {
    const bugNote = "\n## R88 观察：上游空 SSE 流时 proxy 未补发 data: [DONE]\n- 现象：SCN:empty（上游 200 空 body）时，客户端收到 200 空 body，流直接结束，无 data: [DONE]。\n- 位置：proxy.mjs streamChatDirectWithIntercept（透传路径不补终结符）。\n- 建议：translator 正常返回且 intercepted 为空时，若未发出过 [DONE] 则补发。\n";
    fs.appendFileSync(path.join(DIR, "C-bugs.md"), bugNote);
    console.log("R88 观察已记入 C-bugs.md");
  }
}

main().catch((e) => { console.error("runner failed:", e); process.exit(1); });

// ================= 深挖 R101-R108 =================
async function t_R101() {
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, tools: [MSG_TOOL, { name: "get_time", description: "t", input_schema: { type: "object", properties: { tz: { type: "string" } } } }], messages: [{ role: "user", content: "SCN:twotools MARK:ZC101" }] });
  const evs = anthEvents(r.text);
  const probs = [];
  const starts = new Map(), stops = new Map();
  evs.forEach((e) => {
    const d = e.data;
    if (e.event === "content_block_start") {
      if (d.content_block?.type !== "tool_use") probs.push(`非 tool_use block: ${d.content_block?.type}`);
      starts.set(d.index, d.content_block);
    } else if (e.event === "content_block_stop") stops.set(d.index, (stops.get(d.index) || 0) + 1);
    else if (e.event === "content_block_delta" && !starts.has(d.index)) probs.push(`delta 无 start: index ${d.index}`);
  });
  if (starts.size !== 2) probs.push(`tool_use block 数=${starts.size}（期望2）`);
  for (const [i, b] of starts) {
    if (stops.get(i) !== 1) probs.push(`index ${i} stop 次数=${stops.get(i) || 0}`);
    if (!b?.id || !b?.name) probs.push(`index ${i} 缺 id/name`);
  }
  const names = [...starts.values()].map((b) => b?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["get_time", "get_weather"])) probs.push(`工具名=${JSON.stringify(names)}`);
  const argJson = {};
  let cur = null;
  for (const e of evs) {
    if (e.event === "content_block_start") cur = e.data.index;
    if (e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta") argJson[cur] = (argJson[cur] || "") + e.data.delta.partial_json;
  }
  try {
    const a0 = JSON.parse(argJson[0] || ""), a1 = JSON.parse(argJson[1] || "");
    if (a0.city !== "Beijing") probs.push(`block0 参数=${argJson[0]}`);
    if (a1.tz !== "Shanghai") probs.push(`block1 参数=${argJson[1]}`);
  } catch { probs.push(`参数 JSON 拼装失败: ${JSON.stringify(argJson)}`); }
  const md = evs.find((e) => e.event === "message_delta");
  if (md?.data?.delta?.stop_reason !== "tool_use") probs.push(`stop_reason=${md?.data?.delta?.stop_reason}`);
  rec("R101", "Anthropic 双 tool_use block 开闭+参数", r.status === 200 && probs.length === 0,
    probs.length ? probs.join(";") : "2 个 tool_use block 各自 start/delta/stop 完整，参数拼装正确");
}

async function t_R102() {
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: true, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:thinktool MARK:ZC102" }] });
  const evs = anthEvents(r.text);
  const probs = [];
  const order = evs.filter((e) => ["content_block_start", "content_block_stop"].includes(e.event))
    .map((e) => `${e.event === "content_block_start" ? "start" : "stop"}${e.data.index}:${e.event === "content_block_start" ? e.data.content_block?.type : ""}`);
  const thinkStart = evs.findIndex((e) => e.event === "content_block_start" && e.data?.content_block?.type === "thinking");
  const toolStart = evs.findIndex((e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use");
  const thinkStop = evs.findIndex((e) => e.event === "content_block_stop" && e.data?.index === 0);
  if (!(thinkStart >= 0 && thinkStop > thinkStart && toolStart > thinkStop)) probs.push(`顺序错: [${order.join(" ")}]`);
  if (evs.some((e) => e.event === "content_block_start" && e.data?.content_block?.type === "text")) probs.push("不应有 text block");
  const think = evs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "thinking_delta").map((e) => e.data.delta.thinking).join("");
  if (think !== "MOCK-THINK-ONLY ") probs.push(`thinking 内容=${JSON.stringify(think)}`);
  rec("R102", "thinking→tool_use 直接切换（无 text）", r.status === 200 && probs.length === 0,
    probs.length ? probs.join(";") : `顺序 [${order.join(" ")}] 合法，thinking 先关再开 tool_use`);
}

async function t_R103() {
  const r = await post(PROXY_A, "/v1/chat/completions", {
    model: MIMO, stream: true,
    tools: [GW_TOOL, { type: "function", function: { name: "get_time", description: "t", parameters: { type: "object", properties: { tz: { type: "string" } } } } }],
    messages: [{ role: "user", content: "SCN:twotools MARK:ZC103" }],
  });
  const evs = sseJson(r.text);
  const tcs = {};
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0;
    tcs[i] = tcs[i] || { id: "", name: "", args: "" };
    if (tc.id) tcs[i].id = tc.id;
    if (tc.function?.name) tcs[i].name += tc.function.name;
    if (typeof tc.function?.arguments === "string") tcs[i].args += tc.function.arguments;
  }
  const probs = [];
  if (tcs[0]?.id !== "call_mock_a" || tcs[0]?.name !== "get_weather" || tcs[0]?.args !== '{"city":"Beijing"}')
    probs.push(`tc0=${JSON.stringify(tcs[0])}`);
  if (tcs[1]?.id !== "call_mock_b" || tcs[1]?.name !== "get_time" || tcs[1]?.args !== '{"tz":"Shanghai"}')
    probs.push(`tc1=${JSON.stringify(tcs[1])}`);
  const fin = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).pop();
  if (fin !== "tool_calls") probs.push(`finish=${fin}`);
  rec("R103", "chat 双 tool_calls id/参数不断链", r.status === 200 && probs.length === 0,
    probs.length ? probs.join(";") : "index0/1 的 id·name·args 全部透传正确");
}

async function t_R104() {
  const r = await post(PROXY_A, "/v1/messages", { model: SPARK, max_tokens: 256, stream: false, messages: [{ role: "user", content: "SCN:reasoning MARK:ZC104" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const c0 = j?.content?.[0], c1 = j?.content?.[1];
  const ok = r.status === 200 && c0?.type === "thinking" && typeof c0?.thinking === "string" && c0.thinking.includes("MOCK-REASONING")
    && c1?.type === "text" && c1?.text?.includes("MOCK-REASON-DONE") && j?.stop_reason === "end_turn";
  rec("R104", "非流式 anthropic thinking 置首", ok,
    `status=${r.status} content[0]=${c0?.type} thinking=${JSON.stringify(c0?.thinking?.slice(0, 30))} content[1]=${c1?.type} stop=${j?.stop_reason}`);
}

async function t_R105() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [{ role: "user", content: "SCN:err400html MARK:ZC105" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const noLeak = !/\.mjs:\d+|node_modules|\/home\/hatch/.test(r.text);
  const ok = r.status === 400 && j?.error?.message?.includes("400 Bad Request from mock gateway") && noLeak;
  rec("R105", "上游 400 HTML 错误体被归一化透传", ok,
    `status=${r.status} msg=${JSON.stringify(j?.error?.message?.slice(0, 60))} 无泄露=${noLeak}`);
}

async function t_R106() {
  const r = await post(PROXY_A, "/v1/chat/completions", { model: MIMO, stream: true, messages: [] });
  const ok = r.status === 400 && r.text.includes("消息列表为空");
  rec("R106", "空消息列表被 proxy 自身 400 拒绝", ok, `status=${r.status} body=${r.text.slice(0, 80)}`);
}

async function t_R107() {
  const probs = [];
  const g = await fetch(`${PROXY_A}/v1/models`);
  if (g.headers.get("access-control-allow-origin") !== "*") probs.push("GET /v1/models 缺 CORS 头");
  for (const p of ["/v1/responses", "/v1/messages"]) {
    let r = null;
    for (let a = 0; a <= 3; a++) {
      try { r = await fetch(`${PROXY_A}${p}`, { method: "OPTIONS" }); break; }
      catch { await sleep(1500); }
    }
    if (!r || r.status !== 204 || r.headers.get("access-control-allow-origin") !== "*") probs.push(`OPTIONS ${p} 异常`);
  }
  rec("R107", "CORS 头覆盖 GET 模型列表 + 各接口预检", probs.length === 0, probs.length ? probs.join(";") : "GET/OPTIONS 各路径 CORS 头齐全");
}

async function t_R108() {
  // 跳转链 SSRF：外网 URL 302 跳到 127.0.0.1，必须在第二跳被拦
  const r = await post(PROXY_B, "/v1/chat/completions", {
    model: MIMO + "-search", stream: true,
    messages: [{ role: "user", content: "SCN:fetchprobe MARK:ZC108 URL:http://httpbin.org/redirect-to?url=http://127.0.0.1:1/&status_code=302" }],
  }, 90000);
  const blocked = r.text.includes("不允许抓取内网地址");
  rec("R108", "webfetch 跳转进内网被拦截", r.status === 200 && blocked,
    `status=${r.status} 跳转链第二跳被拦=${blocked}`);
}
