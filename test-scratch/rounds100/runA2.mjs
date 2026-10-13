// Group A deep-dive rounds R41-R52 (uses new mock scenarios: fragname/len/cf).
// Appends to the same A-results.jsonl. Run: node runA2.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = "http://127.0.0.1:18781";
const REQLOG = path.join(path.dirname(DIR), "requests.jsonl");
const OUT = path.join(DIR, "A-results.jsonl");

const SPARK = "muse-spark-1.3-contributor-free";
const MIMO = "mimo-v2.6-flash-free";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function rec(round, name, pass, detail) {
  results.push({ round, name, pass, detail });
  fs.appendFileSync(OUT, JSON.stringify({ round, name, pass, detail }) + "\n");
  console.log(`${pass ? "PASS" : "FAIL"} ${round} ${name}`);
  if (!pass) console.log(`     detail: ${detail}`);
}
async function post(p, body, timeoutMs = 60000) {
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
    } catch (e) { lastErr = e; if (attempt < 3) await sleep(1500); }
    finally { clearTimeout(t); }
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
  try { return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
const GW_TOOL = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const MSG_TOOL = { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const arrIn = (t) => [{ type: "message", role: "user", content: [{ type: "input_text", text: t }] }];
const R = {};

// R41: fragname 分片工具名组装（chat direct 非流式）
R.R41 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:fragname MARK:R41" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tcs = j?.choices?.[0]?.message?.tool_calls || [];
  const names = tcs.map((t) => t?.function?.name);
  const ok = r.status === 200 && names.includes("get_weather") && names.includes("webfetch")
    && tcs.every((t) => !/get_wea|webfe/.test(t?.function?.name || "") || t?.function?.name?.length > 6)
    && j?.choices?.[0]?.finish_reason === "tool_calls";
  rec("R41", "fragname分片工具名组装", ok, `status=${r.status} names=${JSON.stringify(names)} finish=${j?.choices?.[0]?.finish_reason}`);
};

// R42: B12 端到端（流式）：messages+mimo SCN:len → max_tokens
R.R42 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: true, max_tokens: 1024, messages: [{ role: "user", content: "SCN:len MARK:R42" }] });
  const evs = sseJson(r.text);
  const sr = evs.find((e) => e.type === "message_delta")?.delta?.stop_reason;
  const ok = r.status === 200 && sr === "max_tokens";
  rec("R42", "B12端到端(流式)length→max_tokens", ok, `status=${r.status} stop_reason=${sr}`);
};

// R43: B12 端到端（非流式）：messages+mimo SCN:len → max_tokens
R.R43 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:len MARK:R43" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && j?.stop_reason === "max_tokens";
  rec("R43", "B12端到端(非流式)length→max_tokens", ok, `status=${r.status} stop_reason=${j?.stop_reason}`);
};

// R44: translateToChat非流式翻转：length → status incomplete + max_output_tokens
R.R44 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: false, input: arrIn("SCN:len MARK:R44") });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && j?.status === "incomplete" && j?.incomplete_details?.reason === "max_output_tokens";
  rec("R44", "chat→responses翻转length→incomplete(非流式)", ok,
    `status=${r.status} respStatus=${j?.status} reason=${j?.incomplete_details?.reason}`);
};

// R45: translateToChat流式翻转：length → response.incomplete + max_output_tokens
R.R45 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: true, input: arrIn("SCN:len MARK:R45") });
  const evs = sseJson(r.text);
  const inc = evs.find((e) => e.type === "response.incomplete");
  const ok = r.status === 200 && inc?.response?.status === "incomplete" && inc?.response?.incomplete_details?.reason === "max_output_tokens";
  rec("R45", "chat→responses翻转length→incomplete(流式)", ok,
    `status=${r.status} hasIncomplete=${!!inc} reason=${inc?.response?.incomplete_details?.reason}`);
};

// R46: 并发 forceSearch 隔离（B6 的并发隐患）：2个-search+2个普通同时打
R.R46 = async () => {
  const before = reqLog().length;
  const mk = (model, mark) => post("/v1/messages", { model, stream: false, max_tokens: 1024, messages: [{ role: "user", content: `SCN:text MARK:${mark}` }] });
  const [a, b, c, d] = await Promise.all([
    mk(SPARK + "-search", "R46a"), mk(SPARK, "R46b"), mk(SPARK + "-search", "R46c"), mk(SPARK, "R46d"),
  ]);
  const after = reqLog().slice(before);
  const tn = (m) => new Set((after.find((e) => e.mark === m)?.toolNames) || []);
  const okS = (m) => tn(m).has("webfetch") && tn(m).has("websearch");
  const okN = (m) => !tn(m).has("webfetch") && !tn(m).has("websearch");
  const ok = a.status === 200 && b.status === 200 && c.status === 200 && d.status === 200
    && okS("R46a") && okN("R46b") && okS("R46c") && okN("R46d");
  rec("R46", "并发forceSearch隔离(-search/普通互不串扰)", ok,
    `R46a=${JSON.stringify([...tn("R46a")])} R46b=${JSON.stringify([...tn("R46b")])} R46c=${JSON.stringify([...tn("R46c")])} R46d=${JSON.stringify([...tn("R46d")])}`);
};

// R47: chat+spark非流式tool_call（responseToChatCompletion工具路径）
R.R47 = async () => {
  const r = await post("/v1/chat/completions", { model: SPARK, stream: false, tools: [GW_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R47" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
  let args = null; try { args = JSON.parse(tc?.function?.arguments || ""); } catch {}
  const ok = r.status === 200 && tc?.function?.name === "get_weather" && args?.city === "Beijing" && j?.choices?.[0]?.finish_reason === "tool_calls";
  rec("R47", "chat+spark非流式tool_call", ok, `status=${r.status} tool=${tc?.function?.name} finish=${j?.choices?.[0]?.finish_reason}`);
};

// R48: messages+mimo流式tool_use（streamChatToAnthropic工具路径）
R.R48 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: true, max_tokens: 1024, tools: [MSG_TOOL], messages: [{ role: "user", content: "SCN:toolcall MARK:R48" }] });
  const evs = sseJson(r.text);
  const start = evs.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  const sr = evs.find((e) => e.type === "message_delta")?.delta?.stop_reason;
  const ok = r.status === 200 && start?.content_block?.name === "get_weather" && sr === "tool_use";
  rec("R48", "messages+mimo流式tool_use", ok, `status=${r.status} name=${start?.content_block?.name} stop=${sr}`);
};

// R49: responses+mimo流式function_call（streamChatToResponses工具路径）
R.R49 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: true, tools: [GW_TOOL], input: arrIn("SCN:toolcall MARK:R49") });
  const evs = sseJson(r.text);
  const added = evs.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
  // 注：streamChatToResponses 是缓冲后发完整 added/done，不发 arguments.delta 逐片事件（设计如此）
  const ok = r.status === 200 && added?.item?.name === "get_weather" && added?.item?.arguments === '{"city":"Beijing"}';
  rec("R49", "responses+mimo流式function_call", ok, `status=${r.status} name=${added?.item?.name} args=${added?.item?.arguments}`);
};

// R50: chat非流式reasoning组装（mimo direct）
R.R50 = async () => {
  const r = await post("/v1/chat/completions", { model: MIMO, stream: false, messages: [{ role: "user", content: "SCN:reasoning MARK:R50" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const msg = j?.choices?.[0]?.message || {};
  const ok = r.status === 200 && typeof msg.reasoning_content === "string" && msg.reasoning_content.includes("MOCK-REASONING")
    && typeof msg.content === "string" && msg.content.includes("MOCK-REASON-DONE");
  rec("R50", "chat非流式reasoning组装", ok, `status=${r.status} reasoning=${JSON.stringify((msg.reasoning_content || "").slice(0, 30))}`);
};

// R51: messages+mimo非流式 SCN:cf → content_filter（别组修复验证）
R.R51 = async () => {
  const r = await post("/v1/messages", { model: MIMO, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "SCN:cf MARK:R51" }] });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && j?.stop_reason === "content_filter";
  rec("R51", "messages非流式content_filter映射", ok, `status=${r.status} stop_reason=${j?.stop_reason}`);
};

// R52: responses+mimo非流式 SCN:cf → incomplete + content_filter
R.R52 = async () => {
  const r = await post("/v1/responses", { model: MIMO, stream: false, input: arrIn("SCN:cf MARK:R52") });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && j?.status === "incomplete" && j?.incomplete_details?.reason === "content_filter";
  rec("R52", "chat→responses翻转content_filter→incomplete", ok,
    `status=${r.status} respStatus=${j?.status} reason=${j?.incomplete_details?.reason}`);
};

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("proxy not up");
}

await waitForProxy();
const order = ["R41","R42","R43","R44","R45","R46","R47","R48","R49","R50","R51","R52"];
for (const k of order) {
  try { await R[k](); }
  catch (e) { rec(k, "exception", false, String(e?.message || e)); }
}
const pass = results.filter((r) => r.pass).length;
console.log(`\n==== 深挖轮完成: ${pass}/${results.length} PASS ====`);
