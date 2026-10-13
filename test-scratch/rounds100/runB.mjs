// B组: R41-R70 fuzz/边界 + 并发 (opencode-proxy v57 百轮自查)
// 被测: http://127.0.0.1:18782 (proxy.mjs 未修改) ; 上游 mock 127.0.0.1:443
// 结果: 终端打印 + rounds100/B-results.jsonl
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(DIR, "..");
const PROXY = "http://127.0.0.1:18782";
const REQLOG = path.join(SCRATCH, "requests.jsonl");
const FETCHLOG = path.join(SCRATCH, "fetchtarget.jsonl");
const PROXYLOG = "/tmp/proxy-18782.log";
const OUT = path.join(DIR, "B-results.jsonl");
try { fs.unlinkSync(OUT); } catch {}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rec(round, name, pass, detail) {
  fs.appendFileSync(OUT, JSON.stringify({ round, name, pass, detail }) + "\n");
  results.push({ round, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${round} ${name}`);
  if (!pass) console.log(`     detail: ${String(detail).slice(0, 400)}`);
}

async function postRaw(p, raw, ctype, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "user-agent": "test-B/1.0" };
    if (ctype) headers["content-type"] = ctype;
    const r = await fetch(`${PROXY}${p}`, { method: "POST", headers, body: raw, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get("content-type") || "", text, aborted: false };
  } catch (e) {
    const msg = String(e?.message || e);
    return { status: -1, ctype: "", text: msg, aborted: /abort/i.test(msg) };
  } finally { clearTimeout(t); }
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
const chatUsageOf = (evs) => evs.map((e) => e.usage).find((u) => u !== undefined) || null;

function reqLog() {
  try {
    return fs.readFileSync(REQLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const byMark = (mark) => reqLog().filter((e) => e.mark === mark && e.ts >= RUN_T0);
let RUN_T0 = 0;
function proxyLog() { try { return fs.readFileSync(PROXYLOG, "utf8"); } catch { return ""; } }

// fuzz 通用: 不挂起、不 500 即算"不崩"
const noCrash = (r) => !r.aborted && r.status !== -1 && r.status !== 500;
const hasMarkRe = (mark) => new RegExp(mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?!\\d)");

async function waitForProxy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("proxy did not come up");
}

// ---------------- R41-R60 fuzz/边界 ----------------
async function r41() {
  const r = await postRaw("/v1/chat/completions", "", null, 15000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 400 && typeof j?.error?.message === "string";
  rec("R41", "空body", ok, `status=${r.status} body=${r.text.slice(0,120)}`);
}
async function r42() {
  const big = "SCN:text MARK:B42 " + "x".repeat(2 * 1024 * 1024);
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, messages: [{ role: "user", content: big }] }, 60000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = noCrash(r) && (r.status === 200 ? (j?.choices?.[0]?.message?.content || "").includes("MOCK-CHAT-TEXT") : r.status === 413 || r.status === 400);
  rec("R42", "超大body(2MB)", ok, `status=${r.status} aborted=${r.aborted} len=${r.text.length} ok=${!!j}`);
}
async function r43() {
  const r = await postRaw("/v1/chat/completions", '{"model": "mimo", "messages": [', "application/json", 15000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 400 && typeof j?.error?.message === "string";
  rec("R43", "畸形JSON", ok, `status=${r.status} body=${r.text.slice(0,120)}`);
}
async function r44() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false }, 15000);
  const ok = noCrash(r);
  rec("R44", "缺messages/input字段", ok, `status=${r.status} body=${r.text.slice(0,150)}`);
}
async function r45() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, messages: null }, 15000);
  const ok = noCrash(r);
  rec("R45", "messages为null", ok, `status=${r.status} body=${r.text.slice(0,150)}`);
}
async function r46() {
  const m = "m".repeat(500);
  const r = await post("/v1/chat/completions", { model: m, stream: false, messages: [{ role: "user", content: "SCN:text MARK:B46" }] }, 15000);
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const up = byMark("B46");
  const ok = r.status === 200 && (j?.choices?.[0]?.message?.content || "").includes("MOCK-CHAT-TEXT")
    && up.length >= 1 && (up[0].model || "").length === 500;
  rec("R46", "超长模型名(500字符)", ok, `status=${r.status} upstreamModelLen=${up[0]?.model?.length} upstreamReqs=${up.length}`);
}
async function r47() {
  const names = ["../etc/passwd", "100%", "model\nwith\nnewline", "模型🚀emoji"];
  const probs = [];
  for (let i = 0; i < names.length; i++) {
    const r = await post("/v1/chat/completions", { model: names[i], stream: false, messages: [{ role: "user", content: `SCN:text MARK:B47-${i}` }] }, 15000);
    if (!noCrash(r)) probs.push(`${JSON.stringify(names[i])}:status=${r.status}`);
    const up = byMark(`B47-${i}`);
    if (r.status === 200 && up.length >= 1 && up[0].path !== "/zen/v1/chat/completions")
      probs.push(`${JSON.stringify(names[i])}:unexpected upstream path ${up[0].path}`);
  }
  rec("R47", "特殊字符模型名", probs.length === 0, probs.join("; ") || "4/4 不崩, 上游路径正常");
}
async function r48() {
  const cases = [
    ["u-inout", (u) => u && u.input_tokens === 11 && u.output_tokens === 7],
    ["u-prco", (u) => u && u.prompt_tokens === 11 && u.completion_tokens === 7],
    ["u-mixed", (u) => u && u.input_tokens === 11 && u.completion_tokens === 7],
    ["u-none", (u) => u && typeof u === "object" && Object.keys(u).length === 0],
  ];
  const probs = [];
  for (const [scn, check] of cases) {
    const mark = `B48-${scn}`;
    const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: `SCN:${scn} MARK:${mark}` }] }, 15000);
    const evs = sseJson(r.text);
    const txt = chatTextOf(evs), u = chatUsageOf(evs);
    if (!(r.status === 200 && txt.includes("MOCK-B") && txt.includes(mark) && r.text.includes("data: [DONE]") && check(u)))
      probs.push(`${scn}:status=${r.status} usage=${JSON.stringify(u)} done=${r.text.includes("data: [DONE]")}`);
  }
  rec("R48", "usage命名4种组合", probs.length === 0, probs.join("; ") || "4/4 透传+归一化正常, 不崩");
}
async function r49() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:sparse MARK:B49" }] }, 15000);
  const evs = sseJson(r.text);
  const tcs = {};
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0;
    tcs[i] = tcs[i] || { id: "", name: "", args: "" };
    if (tc.id) tcs[i].id = tc.id;
    if (tc.function?.name) tcs[i].name += tc.function.name;
    if (typeof tc.function?.arguments === "string") tcs[i].args += tc.function.arguments;
  }
  const idx = Object.keys(tcs).map(Number).sort((a, b) => a - b);
  const fin = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).pop() || null;
  const ok = r.status === 200 && JSON.stringify(idx) === "[0,2,5]"
    && tcs[0].name === "get_weather" && tcs[0].args === '{"city":"Beijing"}'
    && tcs[2].name === "get_time" && tcs[2].args === '{"tz":"UTC"}'
    && tcs[5].name === "get_date" && tcs[5].args === '{"fmt":"iso"}'
    && fin === "tool_calls";
  rec("R49", "tool_calls稀疏索引[0,2,5]", ok, `status=${r.status} idx=${JSON.stringify(idx)} finish=${fin} tcs=${JSON.stringify(tcs)}`);
}
async function r50() {
  // 上游中途断流: 两条路径都不应挂起
  const r1 = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:trunc MARK:B50a" }] }, 15000);
  const r2 = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: true, messages: [{ role: "user", content: "SCN:trunc MARK:B50b" }] }, 15000);
  const ok1 = !r1.aborted && r1.status === 200 && r1.text.includes("MOCK-B-TRUNC partial");
  const ok2 = !r2.aborted; // 翻译路径: 不挂起即合格, 状态记录
  rec("R50", "SSE截断(上游中途断流)", ok1 && ok2,
    `direct:aborted=${r1.aborted} status=${r1.status} partial=${r1.text.includes("MOCK-B-TRUNC partial")}; translate:aborted=${r2.aborted} status=${r2.status} body=${r2.text.slice(0,120)}`);
}
async function r51() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:ooo MARK:B51" }] }, 15000);
  const txt = chatTextOf(sseJson(r.text));
  const ok = noCrash(r) && txt.includes("MOCK-B-OOO") && r.text.includes("data: [DONE]");
  rec("R51", "SSE乱序事件", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0,40))} done=${r.text.includes("data: [DONE]")}`);
}
async function r52() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:dupid MARK:B52" }] }, 15000);
  const txt = chatTextOf(sseJson(r.text));
  const ok = noCrash(r) && txt.includes("MOCK-B-DUP") && txt.includes("again") && r.text.includes("data: [DONE]");
  rec("R52", "重复SSE事件id", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0,50))}`);
}
async function r53() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:emptychoices MARK:B53" }] }, 15000);
  const txt = chatTextOf(sseJson(r.text));
  const ok = noCrash(r) && txt.includes("MOCK-B-EC") && r.text.includes("data: [DONE]");
  rec("R53", "空choices数组", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0,40))}`);
}
async function r54() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:nulldelta MARK:B54" }] }, 15000);
  const txt = chatTextOf(sseJson(r.text));
  const ok = noCrash(r) && txt.includes("MOCK-B-ND") && r.text.includes("data: [DONE]");
  rec("R54", "delta为null的chunk", ok, `status=${r.status} text=${JSON.stringify(txt.slice(0,40))}`);
}
async function r55() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:strusage MARK:B55" }] }, 15000);
  const evs = sseJson(r.text);
  const txt = chatTextOf(evs), u = chatUsageOf(evs);
  const ok = noCrash(r) && txt.includes("MOCK-B") && r.text.includes("data: [DONE]");
  rec("R55", "usage为字符串", ok, `status=${r.status} downstreamUsage=${JSON.stringify(u)}`);
}
async function r56() {
  const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: "SCN:badargs MARK:B56" }] }, 15000);
  const evs = sseJson(r.text);
  const tcs = [];
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    const i = tc.index ?? 0;
    tcs[i] = tcs[i] || { name: "", args: "" };
    if (tc.function?.name) tcs[i].name += tc.function.name;
    if (typeof tc.function?.arguments === "string") tcs[i].args += tc.function.arguments;
  }
  const fin = evs.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).pop() || null;
  const ok = noCrash(r) && tcs.length === 1 && tcs[0].name === "get_weather"
    && tcs[0].args === "{not valid json!!!" && fin === "tool_calls";
  rec("R56", "tool参数非法JSON", ok, `status=${r.status} tool=${JSON.stringify(tcs[0])} finish=${fin}（-search本地执行路径的代码兜底已静态确认: runProxyTool内try/catch）`);
}
async function r57() {
  const msgs = [
    { role: "system", content: "你是助手" },
    { role: "weirdrole", content: "SCN:text MARK:B57a" },
    { role: "user", content: "hello" },
  ];
  const r1 = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, messages: msgs }, 15000);
  const r2 = await post("/v1/chat/completions", { model: "muse-spark-1.3-contributor-free", stream: false, messages: msgs }, 15000);
  const ok = noCrash(r1) && noCrash(r2);
  rec("R57", "messages含未知role", ok, `direct:status=${r1.status}; translate:status=${r2.status} body=${r2.text.slice(0,130)}`);
}
async function r58() {
  const r = await post("/v1/responses", { model: "muse-spark-1.3-contributor-free", stream: true, input: "SCN:text MARK:B58 just a string" }, 15000);
  const deltas = sseJson(r.text).filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  const ok = noCrash(r) && deltas.includes("MOCK-RESP-TEXT");
  rec("R58", "input为字符串(Responses)", ok, `status=${r.status} deltas=${JSON.stringify(deltas.slice(0,50))}`);
}
async function r59() {
  const probs = [];
  for (const mt of [-1, 0, 999999999]) {
    const r = await post("/v1/messages", { model: "muse-spark-1.3-contributor-free", max_tokens: mt, stream: false, messages: [{ role: "user", content: `SCN:text MARK:B59-${mt}` }] }, 15000);
    if (!noCrash(r)) probs.push(`max_tokens=${mt}:status=${r.status}`);
  }
  rec("R59", "max_tokens负数/0/超大", probs.length === 0, probs.join("; ") || "-1/0/999999999 均不崩(状态已记录)");
}
async function r60() {
  const probs = [];
  for (const tp of [-1, 2.5, "abc"]) {
    const r = await post("/v1/chat/completions", { model: "mimo-v2.6-flash-free", stream: false, temperature: tp, messages: [{ role: "user", content: `SCN:text MARK:B60-${tp}` }] }, 15000);
    if (!noCrash(r)) probs.push(`temperature=${JSON.stringify(tp)}:status=${r.status}`);
  }
  rec("R60", "temperature越界", probs.length === 0, probs.join("; ") || "-1/2.5/\"abc\" 均不崩");
}

// ---------------- R61-R70 并发 ----------------
// 混合并发: search 请求用 SCN:searchcall(触发 webfetch 本地执行+follow-up),
// 普通请求用 SCN:text. endpoint 轮换 chat/mimo 与 responses/spark.
function mixedBody(i, round, useResp, search) {
  const mark = `${round}-${i}`;
  const base = useResp ? "muse-spark-1.3-contributor-free" : "mimo-v2.6-flash-free";
  const model = search ? base + "-search" : base;
  const scn = search ? "searchcall" : "text";
  const content = `SCN:${scn} MARK:${mark}`;
  if (useResp) return { path: "/v1/responses", body: { model, stream: true, input: [{ role: "user", content }] }, mark, search };
  return { path: "/v1/chat/completions", body: { model, stream: true, messages: [{ role: "user", content }] }, mark, search };
}
function respTextOf(path, text) {
  if (path === "/v1/responses")
    return sseJson(text).filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  return chatTextOf(sseJson(text));
}
async function mixedRound(round, name, n, searchEvery, timeoutMs = 60000) {
  const specs = [];
  for (let i = 0; i < n; i++) specs.push(mixedBody(i, round, i % 2 === 1, i % searchEvery === 0));
  const settled = await Promise.all(specs.map((s) =>
    post(s.path, s.body, timeoutMs).then((r) => ({ s, r }))
  ));
  const probs = [];
  for (const { s, r } of settled) {
    const txt = respTextOf(s.path, r.text);
    if (r.status !== 200) { probs.push(`${s.mark}:status=${r.status}`); continue; }
    if (!hasMarkRe(s.mark).test(txt)) probs.push(`${s.mark}:missing-own-mark`);
    for (let j = 0; j < n; j++) {
      if (j !== Number(s.mark.split("-")[1]) && hasMarkRe(`${round}-${j}`).test(txt))
        probs.push(`${s.mark}:has-other-mark-${round}-${j}`);
    }
    const ups = byMark(s.mark);
    if (s.search) {
      if (ups.length !== 2) probs.push(`${s.mark}:search upstreamReqs=${ups.length}(want 2)`);
      else {
        const first = ups[0];
        if (!(first.toolNames.includes("webfetch") && first.toolNames.includes("websearch")))
          probs.push(`${s.mark}:search missing tools ${JSON.stringify(first.toolNames)}`);
        if (!txt.includes("MOCK-FINAL")) probs.push(`${s.mark}:search no MOCK-FINAL`);
      }
    } else {
      if (ups.length !== 1) probs.push(`${s.mark}:plain upstreamReqs=${ups.length}(want 1)`);
      else if (ups[0].toolNames.includes("webfetch") || ups[0].toolNames.includes("websearch"))
        probs.push(`${s.mark}:plain LEAKED search tools ${JSON.stringify(ups[0].toolNames)}`);
    }
  }
  rec(round, name, probs.length === 0, probs.slice(0, 8).join("; ") || `${n}并发: 响应一一对应, 搜索注入隔离正确`);
}
async function r61() { await mixedRound("R61", "2并发(1搜索+1普通)", 2, 2); }
async function r62() { await mixedRound("R62", "5并发混合", 5, 2); }
async function r63() { await mixedRound("R63", "10并发混合", 10, 3); }
async function r64() { await mixedRound("R64", "20并发混合", 20, 3); }
async function r65() { await mixedRound("R65", "50并发混合", 50, 3, 90000); }

async function r66() {
  // 连续20次交替: 查 requestForceSearch 残留
  const probs = [];
  for (let i = 0; i < 20; i++) {
    const search = i % 2 === 0;
    const mark = `B66-${i}`;
    const model = search ? "mimo-v2.6-flash-free-search" : "mimo-v2.6-flash-free";
    const r = await post("/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: `SCN:${search ? "searchcall" : "text"} MARK:${mark}` }] }, 30000);
    if (r.status !== 200) { probs.push(`${mark}:status=${r.status}`); continue; }
    const ups = byMark(mark);
    const hasSearchTools = ups.some((e) => e.toolNames.includes("webfetch") || e.toolNames.includes("websearch"));
    if (search !== hasSearchTools) probs.push(`${mark}:search=${search} tools=${JSON.stringify(ups[0]?.toolNames)}`);
    if (search && ups.length !== 2) probs.push(`${mark}:search followup missing`);
  }
  rec("R66", "连续20次交替search/普通(requestForceSearch残留)", probs.length === 0, probs.slice(0, 8).join("; ") || "20/20 注入标志正确, 无残留");
}

async function r67() {
  // 同一模型名并发: 带-search 与不带同时打
  const specs = [];
  for (let i = 0; i < 6; i++) {
    const search = i >= 3;
    const mark = `B67-${i}`;
    const model = search ? "mimo-v2.6-flash-free-search" : "mimo-v2.6-flash-free";
    specs.push({ mark, search, body: { model, stream: true, messages: [{ role: "user", content: `SCN:${search ? "searchcall" : "text"} MARK:${mark}` }] } });
  }
  const settled = await Promise.all(specs.map((s) => post("/v1/chat/completions", s.body, 60000).then((r) => ({ s, r }))));
  const probs = [];
  for (const { s, r } of settled) {
    if (r.status !== 200) { probs.push(`${s.mark}:status=${r.status}`); continue; }
    const ups = byMark(s.mark);
    const has = ups.some((e) => e.toolNames.includes("webfetch") && e.toolNames.includes("websearch"));
    if (s.search !== has) probs.push(`${s.mark}:search=${s.search} but toolsHasSearch=${has}`);
    const txt = chatTextOf(sseJson(r.text));
    if (!hasMarkRe(s.mark).test(txt)) probs.push(`${s.mark}:mark mismatch`);
  }
  rec("R67", "同一模型名并发(±search)", probs.length === 0, probs.join("; ") || "6/6 注入隔离正确");
}

async function r68() {
  // 并发下 usage 日志不串行: spark 翻译路径, 两种用量场景交错
  const logBefore = proxyLog();
  const specs = [];
  for (let i = 0; i < 12; i++) {
    const scn = i % 2 === 0 ? "text" : "reasoning"; // text:11/7 reasoning:41/15
    const mark = `B68-${i}`;
    specs.push({ mark, scn, body: { model: "muse-spark-1.3-contributor-free", stream: true, messages: [{ role: "user", content: `SCN:${scn} MARK:${mark}` }] } });
  }
  const settled = await Promise.all(specs.map((s) => post("/v1/chat/completions", s.body, 60000).then((r) => ({ s, r }))));
  const probs = [];
  for (const { s, r } of settled) {
    if (r.status !== 200) { probs.push(`${s.mark}:status=${r.status}`); continue; }
    const u = chatUsageOf(sseJson(r.text));
    const want = s.scn === "text" ? 11 : 41;
    if (!u || u.prompt_tokens !== want) probs.push(`${s.mark}:usage串了 want入${want} got=${JSON.stringify(u)}`);
  }
  const logAfter = proxyLog().slice(logBefore.length);
  const in11 = (logAfter.match(/· 入11 ·/g) || []).length;
  const in41 = (logAfter.match(/· 入41 ·/g) || []).length;
  if (in11 !== 6 || in41 !== 6) probs.push(`日志行: 入11x${in11}(want 6) 入41x${in41}(want 6)`);
  rec("R68", "并发下usage日志不串行", probs.length === 0, probs.join("; ") || `12/12 响应usage对得上; 日志 入11x${in11} 入41x${in41}`);
}

async function r69() {
  // 并发 + 上游延迟(2.5s)
  const t0 = Date.now();
  const specs = [];
  for (let i = 0; i < 5; i++) {
    const mark = `B69-${i}`;
    specs.push({ mark, body: { model: "mimo-v2.6-flash-free", stream: true, messages: [{ role: "user", content: `SCN:slow MARK:${mark}` }] } });
  }
  const settled = await Promise.all(specs.map((s) => post("/v1/chat/completions", s.body, 30000).then((r) => ({ s, r }))));
  const dt = Date.now() - t0;
  const probs = [];
  for (const { s, r } of settled) {
    const txt = chatTextOf(sseJson(r.text));
    if (r.status !== 200 || !hasMarkRe(s.mark).test(txt)) probs.push(`${s.mark}:status=${r.status}`);
  }
  rec("R69", "并发+上游延迟不超时错乱", probs.length === 0 && dt >= 2000, probs.join("; ") || `5/5 完成, 总耗时${dt}ms(上游各延迟2.5s)`);
}

async function r70() {
  // 50并发全search: 本地webfetch拦截不丢tool_call
  const f0 = (() => { try { return fs.readFileSync(FETCHLOG, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } })();
  const specs = [];
  for (let i = 0; i < 50; i++) {
    const mark = `B70-${i}`;
    specs.push({ mark, body: { model: "mimo-v2.6-flash-free-search", stream: true, messages: [{ role: "user", content: `SCN:searchcall MARK:${mark}` }] } });
  }
  const settled = await Promise.all(specs.map((s) => post("/v1/chat/completions", s.body, 90000).then((r) => ({ s, r }))));
  const probs = [];
  let followUps = 0;
  for (const { s, r } of settled) {
    const txt = chatTextOf(sseJson(r.text));
    if (r.status !== 200) { probs.push(`${s.mark}:status=${r.status}`); continue; }
    if (!txt.includes("MOCK-FINAL") || !hasMarkRe(s.mark).test(txt)) { probs.push(`${s.mark}:终答异常`); continue; }
    // 拦截的 tool_call 不应以 tool_calls chunk 形式泄露给客户端(正文含"webfetch"是
    // mock 把抓取结果 ECHO 进终答, 属正常; 判泄露只看 tool_calls 结构)
    const leaked = sseJson(r.text).some((e) => e.choices?.[0]?.delta?.tool_calls);
    if (leaked) probs.push(`${s.mark}:tool_calls泄露给客户端`);
    const ups = byMark(s.mark);
    if (ups.length === 2 && ups[1].followUp) followUps++;
    else probs.push(`${s.mark}:follow-up缺失(upstreamReqs=${ups.length})`);
  }
  const f1 = (() => { try { return fs.readFileSync(FETCHLOG, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } })();
  if (f1 - f0 < 50) probs.push(`webfetch本地执行 ${f1 - f0}/50`);
  rec("R70", "50并发全search", probs.length === 0, probs.slice(0, 8).join("; ") || `50/50 终答正常, follow-up ${followUps}/50, webfetch本地执行${f1 - f0}/50`);
}

async function main() {
  await waitForProxy();
  RUN_T0 = Date.now();
  console.log("proxy ok, start B rounds R41-R70");
  await r41(); await r42(); await r43(); await r44(); await r45();
  await r46(); await r47(); await r48(); await r49(); await r50();
  await r51(); await r52(); await r53(); await r54(); await r55();
  await r56(); await r57(); await r58(); await r59(); await r60();
  await r61(); await r62(); await r63(); await r64(); await r65();
  await r66(); await r67(); await r68(); await r69(); await r70();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== B组 ${pass}/${results.length} passed ====`);
}
main().catch((e) => { console.error("runner failed:", e); process.exit(1); });
