// Test matrix runner for opencode-proxy (proxy.mjs NOT modified).
// Hits the proxy at 127.0.0.1:18788 (started with DNS-redirect preload ->
// mock upstream on 127.0.0.1:443). Writes results.json + prints summary.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = "http://127.0.0.1:18788";
const REQLOG = path.join(DIR, "requests.jsonl");
const FETCHLOG = path.join(DIR, "fetchtarget.jsonl");

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${PROXY}/health`);
      if (r.ok) { const j = await r.json(); console.log("proxy health:", JSON.stringify(j)); return; }
    } catch {}
    await sleep(500);
  }
  throw new Error("proxy did not come up");
}

async function post(p, body, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${PROXY}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "test-matrix/1.0" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get("content-type") || "", text };
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
const chatTextOf = (evs) =>
  evs.map((e) => e.choices?.[0]?.delta?.content || "").join("");
const chatFinishOf = (evs) => {
  const f = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
  return f[f.length - 1] || null;
};
const chatUsageOf = (evs) => evs.map((e) => e.usage).find(Boolean) || null;

function reqLog() {
  try {
    return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function fetchLog() {
  try {
    return fs.readFileSync(FETCHLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const withMark = (entries, mark) => entries.filter((e) => e.mark === mark);

const GW_TOOL = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const RESP_TOOL = { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const MSG_TOOL = { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };

function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}`);
  if (!pass) console.log(`     detail: ${detail}`);
}

// ---------------- chat/completions (direct, mimo) ----------------
async function t_H1() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:text MARK:H1" }] });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs), u = chatUsageOf(evs);
  const ok = r.status === 200 && r.ctype.includes("text/event-stream")
    && txt.includes("MOCK-CHAT-TEXT") && txt.includes("H1")
    && fin === "stop" && r.text.includes("data: [DONE]")
    && u && (u.input_tokens === 11 || u.prompt_tokens === 11);
  rec("H1", "chat流式纯文本(direct/mimo)", ok,
    `status=${r.status} ctype=${r.ctype} text=${JSON.stringify(txt.slice(0,60))} finish=${fin} usage=${JSON.stringify(u)} done=${r.text.includes("data: [DONE]")}`);
}
async function t_H0() {
  const before = reqLog().length;
  const r = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: true, messages: [{ role: "user", content: "SCN:text MARK:H0" }] });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), fin = chatFinishOf(evs), u = chatUsageOf(evs);
  const up = reqLog().slice(before).filter((e) => e.mark === "H0");
  const ok = r.status === 200 && txt.includes("MOCK-RESP-TEXT") && txt.includes("H0")
    && fin === "stop" && up.length >= 1 && up[0].path === "/zen/v1/responses"
    && u && u.prompt_tokens === 11 && u.completion_tokens === 7;
  rec("H0", "chat流式纯文本(spark翻译路径)", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} finish=${fin} upstreamPath=${up[0]?.path} usage=${JSON.stringify(u)}`);
}
async function t_H2() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, messages: [{ role: "user", content: "SCN:text MARK:H2" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const msg = j?.choices?.[0]?.message, u = j?.usage;
  const ok = r.status === 200 && j?.object === "chat.completion"
    && typeof msg?.content === "string" && msg.content.includes("MOCK-CHAT-TEXT") && msg.content.includes("H2")
    && u && (u.input_tokens === 11 || u.prompt_tokens === 11);
  rec("H2", "chat非流式纯文本(direct/mimo)", ok,
    `status=${r.status} object=${j?.object} content=${JSON.stringify(msg?.content?.slice(0,60))} usage=${JSON.stringify(u)}`);
}
async function t_H3() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:H3" }] });
  const evs = sseJson(r.text);
  const tcs = [];
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0;
    tcs[i] = tcs[i] || { id: "", name: "", args: "" };
    if (tc.id) tcs[i].id = tc.id;
    if (tc.function?.name) tcs[i].name += tc.function.name;
    if (typeof tc.function?.arguments === "string") tcs[i].args += tc.function.arguments;
  }
  const fin = chatFinishOf(evs);
  const ok = r.status === 200 && tcs.length === 1 && tcs[0].name === "get_weather"
    && tcs[0].args === '{"city":"Beijing"}' && fin === "tool_calls";
  rec("H3", "chat流式tool_call", ok,
    `status=${r.status} tool=${JSON.stringify(tcs[0])} finish=${fin}`);
  return tcs[0]?.id || "call_mock_1";
}
async function t_H4() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:H4" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  let args = null; try { args = JSON.parse(tc?.function?.arguments || ""); } catch {}
  const ok = r.status === 200 && tc?.function?.name === "get_weather"
    && args && args.city === "Beijing" && j?.choices?.[0]?.finish_reason === "tool_calls";
  rec("H4", "chat非流式tool_call", ok,
    `status=${r.status} tool=${tc?.function?.name} args=${tc?.function?.arguments} finish=${j?.choices?.[0]?.finish_reason}`);
}
async function t_H5(callId) {
  const before = reqLog().length;
  const r = await post("/v1/chat/completions", {
    model: "mimo-v2.6-flash-free", stream: true, tools: [GW_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:H5" },
      { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }] },
      { role: "tool", tool_call_id: callId, content: "72F sunny" },
    ],
  });
  const txt = chatTextOf(sseJson(r.text));
  const ups = reqLog().slice(before).filter((e) => e.mark === "H5");
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && txt.includes("H5")
    && ups.length === 1 && ups[0].followUp === true;
  rec("H5", "chat tool结果回传第二轮", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} upstreamReqs=${ups.length} followUp=${ups[0]?.followUp}`);
}
async function t_H6() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:reasoning MARK:H6" }] });
  const evs = sseJson(r.text);
  const rc = evs.map((e) => e.choices?.[0]?.delta?.reasoning_content || "").join("");
  const txt = chatTextOf(evs);
  const ok = r.status === 200 && rc.includes("MOCK-REASONING") && txt.includes("MOCK-REASON-DONE");
  rec("H6", "chat reasoning内容透传", ok,
    `status=${r.status} reasoning=${JSON.stringify(rc.slice(0,60))} text=${JSON.stringify(txt.slice(0,40))}`);
}

// ---------------- responses (direct, spark) ----------------
async function t_R1() {
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free", stream: true, input: [{ role: "user", content: "SCN:text MARK:R1" }] });
  const evs = sseJson(r.text);
  const deltas = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const comp = evs.find((e) => e.type === "response.completed");
  const u = comp?.response?.usage;
  // 直连 responses 路径是 SSE 原样透传（无翻译），usage 保持上游原样：
  // mock 故意用非标准命名 prompt_tokens/completion_tokens，期望透传不变
  const ok = r.status === 200 && r.ctype.includes("text/event-stream")
    && deltas.includes("MOCK-RESP-TEXT") && deltas.includes("R1")
    && !!comp && u?.prompt_tokens === 11 && u?.completion_tokens === 7;
  rec("R1", "responses流式纯文本(spark,直连透传)", ok,
    `status=${r.status} deltas=${JSON.stringify(deltas.slice(0,60))} completed=${!!comp} usage=${JSON.stringify(u)}（直连路径usage原样透传，未归一化）`);
}
async function t_R2() {
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free", stream: false, input: [{ role: "user", content: "SCN:text MARK:R2" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = j?.output?.find((o) => o.type === "message")?.content?.[0]?.text || "";
  const u = j?.usage;
  const ok = r.status === 200 && j?.object === "response"
    && txt.includes("MOCK-RESP-TEXT") && txt.includes("R2")
    && u?.input_tokens === 11 && u?.output_tokens === 7;
  rec("R2", "responses非流式纯文本(spark)", ok,
    `status=${r.status} object=${j?.object} text=${JSON.stringify(txt.slice(0,60))} usage=${JSON.stringify(u)}`);
}
async function t_R3() {
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free", stream: true, tools: [RESP_TOOL], input: [{ role: "user", content: "SCN:toolcall MARK:R3" }] });
  const evs = sseJson(r.text);
  const done = evs.find((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
  const comp = evs.find((e) => e.type === "response.completed");
  const ok = r.status === 200 && done?.item?.name === "get_weather"
    && done?.item?.arguments === '{"city":"Beijing"}' && !!comp;
  rec("R3", "responses流式function_call", ok,
    `status=${r.status} fn=${done?.item?.name} args=${done?.item?.arguments} completed=${!!comp}`);
  return done?.item?.call_id || "call_mock_1";
}
async function t_R4(callId) {
  const before = reqLog().length;
  const r = await post("/v1/responses", {
    model: "muse-spark-1.3-contributor-free", stream: true, tools: [RESP_TOOL],
    input: [
      { role: "user", content: "SCN:toolcall MARK:R4" },
      { type: "function_call", call_id: callId, name: "get_weather", arguments: '{"city":"Beijing"}' },
      { type: "function_call_output", call_id: callId, output: "72F sunny" },
    ],
  });
  const evs = sseJson(r.text);
  const txt = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const ups = reqLog().slice(before).filter((e) => e.mark === "R4");
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && txt.includes("R4")
    && ups.length === 1 && ups[0].followUp === true;
  rec("R4", "responses function_call结果回传", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} upstreamReqs=${ups.length} followUp=${ups[0]?.followUp}`);
}
async function t_R5() {
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free", stream: true, input: [{ role: "user", content: "SCN:reasoning MARK:R5" }] });
  const evs = sseJson(r.text);
  const rc = evs.filter((e) => e.type === "response.reasoning_summary_text.delta").map((e) => e.delta).join("");
  const txt = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const ok = r.status === 200 && rc.includes("MOCK-REASONING") && txt.includes("MOCK-REASON-DONE");
  rec("R5", "responses reasoning透传", ok,
    `status=${r.status} reasoning=${JSON.stringify(rc.slice(0,60))} text=${JSON.stringify(txt.slice(0,40))}`);
}

// ---------------- messages (Anthropic) ----------------
async function t_M1() {
  const r = await post("/v1/messages", { model: "muse-spark-1.3-contributor-free", max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:text MARK:M1" }] });
  const evs = sseJson(r.text);
  const types = evs.map((e) => e.type);
  const txt = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text || "").join("");
  const md = evs.find((e) => e.type === "message_delta");
  const ok = r.status === 200 && types.includes("message_start") && types.includes("message_stop")
    && txt.includes("MOCK-RESP-TEXT") && txt.includes("M1")
    && md?.delta?.stop_reason === "end_turn";
  rec("M1", "messages流式纯文本(spark)", ok,
    `status=${r.status} has_start=${types.includes("message_start")} has_stop=${types.includes("message_stop")} text=${JSON.stringify(txt.slice(0,60))} stop_reason=${md?.delta?.stop_reason}`);
}
async function t_M2() {
  const r = await post("/v1/messages", { model: "muse-spark-1.3-contributor-free", max_tokens: 256, stream: false, messages: [{ role: "user", content: "SCN:text MARK:M2" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = j?.content?.find((c) => c.type === "text")?.text || "";
  const ok = r.status === 200 && j?.type === "message"
    && txt.includes("MOCK-RESP-TEXT") && txt.includes("M2")
    && j?.stop_reason === "end_turn" && j?.usage?.input_tokens === 11;
  rec("M2", "messages非流式纯文本(spark)", ok,
    `status=${r.status} type=${j?.type} text=${JSON.stringify(txt.slice(0,60))} stop=${j?.stop_reason} usage=${JSON.stringify(j?.usage)}`);
}
async function t_M3() {
  const r = await post("/v1/messages", { model: "muse-spark-1.3-contributor-free", max_tokens: 256, stream: true, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:M3" }] });
  const evs = sseJson(r.text);
  const start = evs.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  const argJson = evs.filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");
  const md = evs.find((e) => e.type === "message_delta");
  let args = null; try { args = JSON.parse(argJson); } catch {}
  const ok = r.status === 200 && start?.content_block?.name === "get_weather"
    && args?.city === "Beijing" && md?.delta?.stop_reason === "tool_use";
  rec("M3", "messages流式tool_use", ok,
    `status=${r.status} tool=${start?.content_block?.name} args=${argJson} stop=${md?.delta?.stop_reason}`);
}
async function t_M4() {
  const before = reqLog().length;
  const r = await post("/v1/messages", {
    model: "muse-spark-1.3-contributor-free", max_tokens: 256, stream: true, tools: [MSG_TOOL],
    messages: [
      { role: "user", content: "SCN:toolcall MARK:M4" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_m4_1", name: "get_weather", input: { city: "Beijing" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_m4_1", content: "72F sunny" }] },
    ],
  });
  const evs = sseJson(r.text);
  const txt = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text || "").join("");
  const ups = reqLog().slice(before).filter((e) => e.mark === "M4");
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && txt.includes("M4")
    && ups.length === 1 && ups[0].followUp === true;
  rec("M4", "messages tool_result回传", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} upstreamReqs=${ups.length} followUp=${ups[0]?.followUp}`);
}
async function t_M5() {
  const before = reqLog().length;
  const r = await post("/v1/messages", { model: "mimo-v2.6-flash-free", max_tokens: 256, stream: true, messages: [{ role: "user", content: "SCN:text MARK:M5" }] });
  const evs = sseJson(r.text);
  const txt = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text || "").join("");
  const up = reqLog().slice(before).filter((e) => e.mark === "M5");
  const ok = r.status === 200 && txt.includes("MOCK-CHAT-TEXT") && txt.includes("M5")
    && up.length >= 1 && up[0].path === "/zen/v1/chat/completions";
  rec("M5", "messages流式(非spark→chat翻译)", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} upstreamPath=${up[0]?.path}`);
}
async function t_Q1() {
  const r = await post("/v1/responses", { model: "mimo-v2.6-flash-free", stream: false, input: [{ role: "user", content: "SCN:text MARK:Q1" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = j?.output?.find((o) => o.type === "message")?.content?.[0]?.text || "";
  const ok = r.status === 200 && j?.object === "response"
    && txt.includes("MOCK-CHAT-TEXT") && txt.includes("Q1");
  rec("Q1", "responses非流式(非spark→chat翻译)", ok,
    `status=${r.status} object=${j?.object} text=${JSON.stringify(txt.slice(0,60))} usage=${JSON.stringify(j?.usage)}`);
}

// ---------------- -search ----------------
async function t_S1() {
  const b0 = reqLog().length, f0 = fetchLog().length;
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: true, messages: [{ role: "user", content: "SCN:searchcall MARK:S1" }] });
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs);
  const ups = reqLog().slice(b0).filter((e) => e.mark === "S1");
  const fh = fetchLog().slice(f0);
  const first = ups[0];
  const exposed = r.text.includes("webfetch");
  const ok = r.status === 200
    && first && first.toolNames.includes("webfetch") && first.toolNames.includes("websearch")
    && first.toolNames.includes("read") && first.toolNames.includes("shell")
    && !exposed
    && fh.length >= 1
    && ups.length === 2 && ups[1].followUp === true
    && txt.includes("MOCK-FINAL") && txt.includes("S1");
  rec("S1", "-search模型chat流式:搜索工具注入+webfetch本地执行", ok,
    `status=${r.status} upstreamTools=${JSON.stringify(first?.toolNames)} webfetchExposed=${exposed} fetchHits=${fh.length} upstreamReqs=${ups.length} followUp=${ups[1]?.followUp} text=${JSON.stringify(txt.slice(0,60))}`);
}
async function t_S2() {
  const b0 = reqLog().length, f0 = fetchLog().length;
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free-search", stream: true, input: [{ role: "user", content: "SCN:searchcall MARK:S2" }] });
  const evs = sseJson(r.text);
  const txt = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const fnExposed = evs.some((e) => e.item?.type === "function_call" || e.type === "response.output_item.done" && e.item?.type === "function_call");
  const ups = reqLog().slice(b0).filter((e) => e.mark === "S2");
  const fh = fetchLog().slice(f0);
  const first = ups[0];
  const ok = r.status === 200
    && first && first.toolNames.includes("webfetch") && first.toolNames.includes("websearch")
    && !fnExposed && fh.length >= 1
    && ups.length === 2 && ups[1].followUp === true
    && txt.includes("MOCK-FINAL") && txt.includes("S2");
  rec("S2", "-search模型responses流式:搜索工具注入+webfetch本地执行", ok,
    `status=${r.status} upstreamTools=${JSON.stringify(first?.toolNames)} fnExposed=${fnExposed} fetchHits=${fh.length} upstreamReqs=${ups.length} text=${JSON.stringify(txt.slice(0,60))}`);
}
async function t_S3() {
  const b0 = reqLog().length;
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:searchcall MARK:S3" }] });
  const evs = sseJson(r.text);
  const tcs = [];
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0; tcs[i] = tcs[i] || { name: "" };
    if (tc.function?.name) tcs[i].name += tc.function.name;
  }
  const ups = reqLog().slice(b0).filter((e) => e.mark === "S3");
  const first = ups[0];
  const ok = r.status === 200
    && first && !first.toolNames.includes("webfetch") && !first.toolNames.includes("websearch")
    && first.toolNames.includes("read") && first.toolNames.includes("shell")
    && tcs.length === 1 && tcs[0].name === "webfetch"   // 透传给客户端，未本地执行
    && chatFinishOf(evs) === "tool_calls"
    && ups.length === 1;  // 无 follow-up：没有本地执行
  rec("S3", "普通模型:无搜索工具注入,上游webfetch调用透传不执行", ok,
    `status=${r.status} upstreamTools=${JSON.stringify(first?.toolNames)} passthroughTool=${tcs[0]?.name} finish=${chatFinishOf(evs)} upstreamReqs=${ups.length}`);
}

// ---------------- 并发 ----------------
async function t_C1() {
  const b0 = reqLog().length;
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    const search = i >= 5;
    jobs.push(post("/v1/chat/completions", {
      model: search ? "mimo-v2.6-flash-free-search" : "mimo-v2.6-flash-free",
      stream: true,
      messages: [{ role: "user", content: `SCN:text MARK:C1-${i}` }],
    }).then((r) => ({ i, r })));
  }
  const settled = await Promise.all(jobs);
  let crossTalk = [];
  for (const { i, r } of settled) {
    const txt = chatTextOf(sseJson(r.text));
    const mine = new RegExp(`C1-${i}(?!\\d)`);
    if (r.status !== 200 || !mine.test(txt)) crossTalk.push(`req${i}:missing-own-mark`);
    for (let j = 0; j < 10; j++) {
      if (j !== i && new RegExp(`C1-${j}(?!\\d)`).test(txt)) crossTalk.push(`req${i}:has-other-mark-C1-${j}`);
    }
  }
  // 上游侧：-search 请求必须带搜索工具，普通请求必须不带
  const ups = reqLog().slice(b0);
  let toolMix = [];
  for (let i = 0; i < 10; i++) {
    const es = withMark(ups, `C1-${i}`);
    if (es.length !== 1) { toolMix.push(`req${i}:upstreamReqs=${es.length}`); continue; }
    const has = es[0].toolNames.includes("webfetch") && es[0].toolNames.includes("websearch");
    if ((i >= 5) !== has) toolMix.push(`req${i}:search=${i >= 5} but toolsHasSearch=${has}`);
  }
  const ok = crossTalk.length === 0 && toolMix.length === 0;
  rec("C1", "并发10请求(5搜索/5普通):无串扰,搜索标志无污染", ok,
    `crossTalk=[${crossTalk.join(";")}] toolMix=[${toolMix.join(";")}]`);
}

// ---------------- 上游异常 ----------------
async function t_E1() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:err400 MARK:E1" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 400 && j?.error?.message === "mock bad request";
  rec("E1", "上游400透传", ok, `status=${r.status} body=${r.text.slice(0,160)}`);
}
async function t_E2() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:err500 MARK:E2" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 500 && typeof j?.error?.message === "string" && j.error.message.includes("mock internal error");
  rec("E2", "上游500透传", ok, `status=${r.status} body=${r.text.slice(0,160)}`);
}
async function t_E3() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:html MARK:E3" }] });
  const ok = r.status === 200 && r.ctype.includes("text/html") && r.text.includes("mock html error page");
  rec("E3", "上游返回HTML(200)原样透传", ok, `status=${r.status} ctype=${r.ctype} body=${r.text.slice(0,80)}`);
}
async function t_E4() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:empty MARK:E4" }] });
  // v65: 空 body = 未收到任何完成信号 → 按截断处理，给出错误信号（对齐原生 incomplete-stream error，不再静默空回）
  const ok = r.status === 200 && r.text.includes("upstream_truncated") && !/"finish_reason":"stop"/.test(r.text);
  rec("E4", "上游空body(SSE 200空)→截断错误信号", ok, `status=${r.status} ctype=${r.ctype} bodyLen=${r.text.length} body=${JSON.stringify(r.text.slice(0,80))}`);
}
async function t_E5() {
  const t0 = Date.now();
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:slow MARK:E5" }] });
  const dt = Date.now() - t0;
  const txt = chatTextOf(sseJson(r.text));
  const ok = r.status === 200 && dt >= 2000 && dt < 60000 && txt.includes("MOCK-CHAT-TEXT");
  rec("E5", "上游延迟2.5s:成功返回(300s超时未触发)", ok, `status=${r.status} elapsed=${dt}ms text=${JSON.stringify(txt.slice(0,40))}`);
}

async function main() {
  await waitForProxy();
  await t_H1();
  await t_H0();
  await t_H2();
  const h3id = await t_H3();
  await t_H4();
  await t_H5(h3id);
  await t_H6();
  await t_R1();
  await t_R2();
  const r3id = await t_R3();
  await t_R4(r3id);
  await t_R5();
  await t_M1();
  await t_M2();
  await t_M3();
  await t_M4();
  await t_M5();
  await t_Q1();
  await t_S1();
  await t_S2();
  await t_S3();
  await t_C1();
  await t_E1();
  await t_E2();
  await t_E3();
  await t_E4();
  await t_E5();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== ${pass}/${results.length} passed ====`);
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error("runner failed:", e); process.exit(1); });
