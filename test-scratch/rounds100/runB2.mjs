// B组加轮深挖: B71-B80（fuzz/边界 + 并发纵深）
// 带失败重试：共享 mock 重启窗口（2-3 秒）内的 ECONNREFUSED / 上游失联 502 自动重试最多 3 次，
// 不记为 FAIL。超时（aborted）不重试——挂起是真问题，不能掩盖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(DIR, "..");
const PROXY = "http://127.0.0.1:18782";
const REQLOG = path.join(SCRATCH, "requests.jsonl");
const OUT = path.join(DIR, "B2-results.jsonl");
try { fs.unlinkSync(OUT); } catch {}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let RUN_T0 = 0;

function rec(round, name, pass, detail) {
  fs.appendFileSync(OUT, JSON.stringify({ round, name, pass, detail }) + "\n");
  results.push({ round, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${round} ${name}`);
  if (!pass) console.log(`     detail: ${String(detail).slice(0, 400)}`);
}

async function postRawOnce(p, raw, ctype, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "user-agent": "test-B2/1.0" };
    if (ctype) headers["content-type"] = ctype;
    const r = await fetch(`${PROXY}${p}`, { method: "POST", headers, body: raw, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get("content-type") || "", text, aborted: false };
  } catch (e) {
    const msg = String(e?.message || e);
    return { status: -1, ctype: "", text: msg, aborted: /abort/i.test(msg) };
  } finally { clearTimeout(t); }
}
// 瞬时故障（mock 重启窗口）才重试：连接层失败，或 proxy 明确报"上游连接失败"的 502
const isTransient = (r) =>
  (!r.aborted && r.status === -1) ||
  (r.status === 502 && /上游连接失败/.test(r.text));
async function postRaw(p, raw, ctype, timeoutMs = 30000, retries = 3) {
  let r = null, n = 0;
  for (let a = 0; a <= retries; a++) {
    r = await postRawOnce(p, raw, ctype, timeoutMs);
    if (a === 0) n = 1;
    if (!isTransient(r) || a === retries) { if (a > 0) r.retried = a; return r; }
    await sleep(2000);
  }
  return r;
}
const post = (p, body, timeoutMs = 30000) => postRaw(p, JSON.stringify(body), "application/json", timeoutMs);

function sseJson(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const pl = t.slice(5).trim();
    if (!pl || pl === "[DONE]") continue;
    try { out.push(JSON.parse(pl)); } catch {}
  }
  return out;
}
const chatTextOf = (evs) => evs.map((e) => e.choices?.[0]?.delta?.content || "").join("");
function reqLog() {
  try { return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
const byMark = (mark) => reqLog().filter((e) => e.mark === mark && e.ts >= RUN_T0);
const noCrash = (r) => !r.aborted && r.status !== -1 && r.status !== 500;
const hasMarkRe = (mark) => new RegExp(mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?!\\d)");

async function waitForProxy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("proxy did not come up");
}

// B71: 非流式 -search 全链路 (chat/mimo)
async function b71() {
  const mark = "B71";
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: false, messages: [{ role: "user", content: `SCN:searchcall MARK:${mark}` }] }, 60000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ups = byMark(mark);
  const leaked = (j?.choices?.[0]?.message?.tool_calls || []).length > 0;
  const ok = r.status === 200 && j?.object === "chat.completion"
    && (j?.choices?.[0]?.message?.content || "").includes("MOCK-FINAL")
    && (j?.choices?.[0]?.message?.content || "").includes(mark)
    && !leaked && ups.length === 2 && ups[1].followUp === true;
  rec("B71", "非流式-search全链路(chat)", ok,
    `status=${r.status} content=${JSON.stringify((j?.choices?.[0]?.message?.content || "").slice(0,60))} leaked=${leaked} upstreamReqs=${ups.length} followUp=${ups[1]?.followUp} retried=${r.retried || 0}`);
}

// B72: responses 非流式 + -search (spark)
async function b72() {
  const mark = "B72";
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free-search", stream: false, input: [{ role: "user", content: `SCN:searchcall MARK:${mark}` }] }, 60000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const txt = j?.output?.find((o) => o.type === "message")?.content?.[0]?.text || "";
  const fnLeak = (j?.output || []).some((o) => o.type === "function_call");
  const ups = byMark(mark);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && txt.includes(mark) && !fnLeak && ups.length === 2 && ups[1].followUp === true;
  rec("B72", "responses非流式-search(spark)", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} fnLeak=${fnLeak} upstreamReqs=${ups.length} retried=${r.retried || 0}`);
}

// B73: messages(Anthropic) + -search 流式 (spark)
async function b73() {
  const mark = "B73";
  const r = await post("/v1/messages", { model: "muse-spark-1.3-contributor-free-search", max_tokens: 256, stream: true, messages: [{ role: "user", content: `SCN:searchcall MARK:${mark}` }] }, 60000);
  const evs = sseJson(r.text);
  const txt = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text || "").join("");
  const toolLeak = evs.some((e) => e.content_block?.type === "tool_use");
  const ups = byMark(mark);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") && txt.includes(mark) && !toolLeak && ups.length === 2 && ups[1].followUp === true;
  rec("B73", "messages流式-search(spark)", ok,
    `status=${r.status} text=${JSON.stringify(txt.slice(0,60))} toolLeak=${toolLeak} upstreamReqs=${ups.length} retried=${r.retried || 0}`);
}

// B74: 1000 条 messages
async function b74() {
  const msgs = [];
  for (let i = 0; i < 999; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `filler ${i}` });
  msgs.push({ role: "user", content: "SCN:text MARK:B74" });
  const r = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: true, messages: msgs }, 60000);
  const txt = chatTextOf(sseJson(r.text));
  const ok = noCrash(r) && txt.includes("MOCK-RESP-TEXT");
  rec("B74", "1000条messages", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0,40))} retried=${r.retried || 0}`);
}

// B75: 多模态 content (image_url)
async function b75() {
  const imgMsg = { role: "user", content: [{ type: "text", text: "SCN:text MARK:B75a" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] };
  const r1 = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, messages: [imgMsg] }, 30000);
  const imgMsg2 = { role: "user", content: [{ type: "text", text: "SCN:text MARK:B75b" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] };
  const r2 = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: false, messages: [imgMsg2] }, 30000);
  const ok = noCrash(r1) && noCrash(r2);
  rec("B75", "多模态image_url", ok, `direct:status=${r1.status} body=${r1.text.slice(0,100)}; translate:status=${r2.status} body=${r2.text.slice(0,100)} retried=${r2.retried || 0}`);
}

// B76: tool_choice 参数透传
async function b76() {
  const GW = { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } } };
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, tool_choice: "required", tools: [GW], messages: [{ role: "user", content: "SCN:toolcall MARK:B76" }] }, 30000);
  const evs = sseJson(r.text);
  const hasTool = evs.some((e) => (e.choices?.[0]?.delta?.tool_calls || []).length > 0);
  const fin = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).pop() || null;
  const ok = noCrash(r) && hasTool && fin === "tool_calls";
  rec("B76", "tool_choice=required", ok, `status=${r.status} hasTool=${hasTool} finish=${fin} retried=${r.retried || 0}`);
}

// B77: 100 并发混合压力
async function b77() {
  const n = 100;
  const specs = [];
  for (let i = 0; i < n; i++) {
    const search = i % 3 === 0, useResp = i % 2 === 1, mark = `B77-${i}`;
    const base = useResp ? "muse-spark-1.3-contributor-free" : "mimo-v2.6-flash-free";
    const model = search ? base + "-search" : base;
    const content = `SCN:${search ? "searchcall" : "text"} MARK:${mark}`;
    const body = useResp ? { model, stream: true, input: [{ role: "user", content }] } : { model, stream: true, messages: [{ role: "user", content }] };
    specs.push({ mark, search, idx: i, path: useResp ? "/v1/responses" : "/v1/chat/completions", body });
  }
  const t0 = Date.now();
  const settled = await Promise.all(specs.map((s) => post(s.path, s.body, 90000).then((r) => ({ s, r }))));
  const dt = Date.now() - t0;
  const probs = [];
  for (const { s, r } of settled) {
    if (r.status !== 200) { probs.push(`${s.mark}:status=${r.status}`); continue; }
    const txt = s.path === "/v1/responses"
      ? sseJson(r.text).filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")
      : chatTextOf(sseJson(r.text));
    if (!hasMarkRe(s.mark).test(txt)) probs.push(`${s.mark}:mark mismatch`);
    const ups = byMark(s.mark);
    const want = s.search ? 2 : 1;
    if (ups.length !== want) probs.push(`${s.mark}:upstreamReqs=${ups.length}(want ${want})`);
    if (!s.search && ups.some((e) => e.toolNames.includes("webfetch") || e.toolNames.includes("websearch")))
      probs.push(`${s.mark}:LEAKED search tools`);
  }
  rec("B77", "100并发混合压力", probs.length === 0, probs.slice(0, 6).join("; ") || `${n}/${n} 全部正确, 总耗时${dt}ms`);
}

// B78: -search 首轮上游 500
async function b78() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: true, messages: [{ role: "user", content: "SCN:err500 MARK:B78" }] }, 30000);
  const ok = !r.aborted && r.status === 500;
  rec("B78", "-search上游首轮500", ok, `status=${r.status} aborted=${r.aborted} body=${r.text.slice(0,120)} retried=${r.retried || 0}`);
}

// B79: response_format json_object (spark chat→responses 翻译)
async function b79() {
  const r = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: false, response_format: { type: "json_object" }, messages: [{ role: "user", content: "SCN:text MARK:B79" }] }, 30000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = noCrash(r) && typeof (j?.choices?.[0]?.message?.content || "") === "string";
  rec("B79", "response_format=json_object", ok, `status=${r.status} content=${JSON.stringify((j?.choices?.[0]?.message?.content || "").slice(0,60))} retried=${r.retried || 0}`);
}

// B80: 空 tools 数组 + -search（搜索注入不受影响）
async function b80() {
  const mark = "B80";
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: true, tools: [], messages: [{ role: "user", content: "SCN:searchcall MARK:B80" }] }, 60000);
  const txt = chatTextOf(sseJson(r.text));
  const ups = byMark(mark);
  const first = ups[0];
  const ok = r.status === 200 && txt.includes("MOCK-FINAL")
    && first && first.toolNames.includes("webfetch") && first.toolNames.includes("websearch")
    && ups.length === 2 && ups[1].followUp === true;
  rec("B80", "空tools数组+-search", ok,
    `status=${r.status} upstreamTools=${JSON.stringify(first?.toolNames)} upstreamReqs=${ups.length} retried=${r.retried || 0}`);
}

async function main() {
  await waitForProxy();
  RUN_T0 = Date.now();
  console.log("proxy ok, start B2 rounds B71-B80 (with retry)");
  await b71(); await b72(); await b73(); await b74(); await b75();
  await b76(); await b77(); await b78(); await b79(); await b80();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== B2组 ${pass}/${results.length} passed ====`);
}
main().catch((e) => { console.error("runner failed:", e); process.exit(1); });
