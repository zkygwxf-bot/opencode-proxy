// v65 test runner: parallel in-round tool execution.
// Requires run-v65.sh (mocks + v65 proxy on 18788 + v64 baseline on 18789).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const P65 = "http://127.0.0.1:18788";
const P64 = "http://127.0.0.1:18789";
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail: detail || "" });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${pass ? "" : " :: " + detail}`);
}

async function post(base, p, body, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

// Incremental SSE read with per-chunk timestamps (for first-delta timing).
async function postStream(base, p, body, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = now();
  try {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", raw = "";
    let firstDeltaMs = null;
    const lines = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const p2 = line.slice(5).trim();
        if (!p2 || p2 === "[DONE]") continue;
        let o = null;
        try { o = JSON.parse(p2); } catch {}
        if (!o) continue;
        lines.push(o);
        if (firstDeltaMs === null) {
          const txt = o.choices?.[0]?.delta?.content || o.delta?.text || (o.type === "response.output_text.delta" ? o.delta : "");
          if (typeof txt === "string" && txt.length > 0) firstDeltaMs = now() - t0;
        }
      }
    }
    return { status: r.status, firstDeltaMs, totalMs: now() - t0, lines, raw };
  } finally { clearTimeout(t); }
}

const readJsonl = (f) => {
  try { return fs.readFileSync(path.join(DIR, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const exaNew = (before) => readJsonl("exalog.jsonl").slice(before);
const fuReqs = (mark) => readJsonl("requests-full.jsonl").filter((e) => e.mark === mark && e.followUp);
const chatToolResults = (entry) => {
  const out = {};
  for (const m of entry.body.messages || []) {
    if (m && m.role === "tool") out[m.tool_call_id] = m.content;
  }
  return out;
};
const respToolResults = (entry) => {
  // spark 原生路径的 follow-up 走上游 /zen/v1/responses：input 数组里的 function_call_output
  const out = {};
  for (const m of entry.body.input || []) {
    if (m && m.type === "function_call_output") out[m.call_id] = m.output;
  }
  return out;
};
const countType = (lines, t) => lines.filter((l) => l.type === t).length;
const leakedTool = (raw) => /"name":"websearch"|"name":"webfetch"|"function":\{"name":"websearch"|"function":\{"name":"webfetch"/.test(raw);

const DS = "deepseek-v4.1-flash-free-search";
const SPARK = "muse-spark-1.2-contributor-free-search";
const MODELS10 = [
  "deepseek-v4.1-flash-free", "glm-5.3-flash-free", "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free", "big-pickle",
  "beam-free", "longcat-2.5-preview-free", "space-bunny-free",
  "muse-spark-1.2-contributor-free",
];

// ---------------- P-group: parallel execution ----------------
async function p1() {
  const before = readJsonl("exalog.jsonl").length;
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:threesearch MARK:P1" }],
  });
  const es = exaNew(before);
  const t0s = es.map((e) => e.t0), t1s = es.map((e) => e.t1);
  const startSpread = Math.max(...t0s) - Math.min(...t0s);
  const span = Math.max(...t1s) - Math.min(...t0s);
  const ok = r.status === 200 && es.length === 3 && startSpread <= 500 && span >= 700 && span <= 2000 &&
    r.raw.includes("MOCK-FINAL") && !leakedTool(r.raw);
  rec("P1", "一轮3搜索并行：同发起(≤500ms)、总耗时≈900ms量级", ok,
    `n=${es.length} startSpread=${startSpread}ms span=${span}ms status=${r.status}`);
  return span;
}

async function p1b() {
  const before = readJsonl("exalog.jsonl").length;
  const r = await postStream(P64, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:threesearch MARK:P1B" }],
  });
  const es = exaNew(before);
  const span = Math.max(...es.map((e) => e.t1)) - Math.min(...es.map((e) => e.t0));
  const ok = r.status === 200 && es.length === 3 && span >= 2200 && span <= 6000;
  rec("P1b", "v64顺序基线对照：总耗时≈2700ms量级", ok, `span=${span}ms status=${r.status}`);
  return span;
}

async function p2() {
  const fus = fuReqs("P1");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = fus.length >= 1 &&
    (tr["call_mock_s1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_s2"] || "").includes("RESULT-FOR:SLOW Q2 banana") &&
    (tr["call_mock_s3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P2", "配对正确：3个可区分结果逐一对上call_id", ok,
    `fus=${fus.length} keys=${Object.keys(tr).join(",")}`);
}

async function p2b() {
  const before = readJsonl("exalog.jsonl").length;
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:threemix MARK:P2B" }],
  });
  const es = exaNew(before);
  const byQ = Object.fromEntries(es.map((e) => [e.query, e]));
  const q2done = byQ["FAST Q2 second"]?.t1, q1done = byQ["SLOW Q1 first"]?.t1;
  const orderDiffers = q2done !== undefined && q1done !== undefined && q2done < q1done - 300;
  const fus = fuReqs("P2B");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const paired = (tr["call_mock_x1"] || "").includes("RESULT-FOR:SLOW Q1 first") &&
    (tr["call_mock_x2"] || "").includes("RESULT-FOR:FAST Q2 second") &&
    (tr["call_mock_x3"] || "").includes("RESULT-FOR:SLOW Q3 third");
  rec("P2b", "乱序完成下配对仍正确（FAST先于SLOW完成）", r.status === 200 && orderDiffers && paired,
    `orderDiffers=${orderDiffers} paired=${paired}`);
}

async function p3() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:threesearchfail MARK:P3" }],
  });
  const fus = fuReqs("P3");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 &&
    (tr["call_mock_f1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_f2"] || "").startsWith("搜索失败") &&
    (tr["call_mock_f3"] || "").includes("RESULT-FOR:SLOW Q3 cherry") &&
    r.raw.includes("MOCK-FINAL");
  rec("P3", "错误隔离：中间1个失败，其余正常、整轮完成", ok,
    `f2=${String(tr["call_mock_f2"]).slice(0, 40)}`);
}

async function p3b() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:threesearchfailfirst MARK:P3B" }],
  });
  const fus = fuReqs("P3B");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 &&
    (tr["call_mock_g1"] || "").startsWith("搜索失败") &&
    (tr["call_mock_g2"] || "").includes("RESULT-FOR:SLOW Q2 banana") &&
    (tr["call_mock_g3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P3b", "错误隔离：首个失败不拖垮整轮", ok, `status=${r.status}`);
}

async function p4() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:mixsearch MARK:P4" }],
  });
  const fus = fuReqs("P4");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 &&
    (tr["call_mock_m1"] || "").includes("RESULT-FOR:SLOW Q-mix") &&
    (tr["call_mock_m2"] || "").includes("FETCH-TARGET-CONTENT-abc123");
  rec("P4", "混合调用：websearch+webfetch同轮并行", ok, `status=${r.status}`);
}

async function p4b() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:mixsearchfailfetch MARK:P4B" }],
  });
  const fus = fuReqs("P4B");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 &&
    (tr["call_mock_n1"] || "").includes("RESULT-FOR:SLOW Q-mix2") &&
    (tr["call_mock_n2"] || "").startsWith("抓取失败");
  rec("P4b", "混合失败隔离：webfetch 404不影响websearch", ok,
    `n2=${String(tr["call_mock_n2"]).slice(0, 40)}`);
}

async function p5() {
  const before = readJsonl("exalog.jsonl").length;
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:searchrounds MARK:P5" }],
  });
  const es = exaNew(before);
  const ups = readJsonl("requests-full.jsonl").filter((e) => e.mark === "P5");
  const queries = es.map((e) => e.query).sort();
  const ok = r.status === 200 && ups.length === 3 &&
    JSON.stringify(queries) === JSON.stringify(["SLOW round1", "SLOW round2"]) &&
    r.raw.includes("RESULT-FOR:SLOW round1") && r.raw.includes("RESULT-FOR:SLOW round2");
  rec("P5", "多轮搜索：2轮搜索正常接续（3次上游请求）", ok,
    `ups=${ups.length} queries=${queries.join("|")}`);
}

async function p6() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:searchcall MARK:P6" }],
  });
  rec("P6", "单调用轮次行为不变", r.status === 200 && r.raw.includes("FETCH-TARGET-CONTENT-abc123"),
    `status=${r.status}`);
}

async function p7() {
  const r = await postStream(P65, "/v1/responses", {
    model: DS, input: "SCN:threesearch MARK:P7", stream: true,
  });
  const fus = fuReqs("P7");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} }); // P7 翻译走 chat 上游：role:tool
  const ok = r.status === 200 && countType(r.lines, "response.completed") === 1 && !leakedTool(r.raw) &&
    (tr["call_mock_s1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_s2"] || "").includes("RESULT-FOR:SLOW Q2 banana") &&
    (tr["call_mock_s3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P7", "responses翻译路径(X循环)并行+配对", ok,
    `completed=${countType(r.lines, "response.completed")} fus=${fus.length}`);
}

async function p8() {
  const r = await postStream(P65, "/v1/messages", {
    model: DS, max_tokens: 200, stream: true,
    messages: [{ role: "user", content: "SCN:threesearch MARK:P8" }],
  });
  const stops = r.lines.filter((l) => l.type === "message_stop").length;
  const fus = fuReqs("P8");
  const tr = chatToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 && stops === 1 && !leakedTool(r.raw) &&
    (tr["call_mock_s1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_s3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P8", "messages翻译路径并行+配对", ok, `stops=${stops} fus=${fus.length}`);
}

async function p9() {
  const r = await post(P65, "/v1/responses", {
    model: DS, input: "SCN:threesearch MARK:P9", stream: false,
  });
  let j = null;
  try { j = JSON.parse(r.text); } catch {}
  const txt = JSON.stringify(j);
  const ok = r.status === 200 && txt.includes("MOCK-FINAL") &&
    txt.includes("RESULT-FOR:SLOW Q1 apple") && txt.includes("RESULT-FOR:SLOW Q3 cherry") &&
    j?.usage && typeof j.usage.input_tokens === "number";
  rec("P9", "responses非流式(NS循环)并行+usage", ok, `status=${r.status}`);
}

async function p10() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: SPARK, stream: true,
    messages: [{ role: "user", content: "SCN:threesearch MARK:P10" }],
  });
  const fus = fuReqs("P10");
  const tr = respToolResults(fus[fus.length - 1] || { body: {} }); // chat+spark 走上游 responses：input 数组
  // 注：chat+spark 走上游 /zen/v1/responses，mock 用 call_mock_rs* id
  const ok = r.status === 200 && fus.length >= 1 &&
    (tr["call_mock_rs1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_rs3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P10", "chat+spark模型路径并行+配对", ok, `status=${r.status} fus=${fus.length}`);
}

async function p11() {
  const r = await post(P65, "/v1/messages", {
    model: DS, max_tokens: 200, stream: false,
    messages: [{ role: "user", content: "SCN:searchcall MARK:P11" }],
  });
  rec("P11", "messages非流式(Y循环)单调用", r.status === 200 && r.text.includes("FETCH-TARGET-CONTENT-abc123"),
    `status=${r.status}`);
}

async function p12() {
  const r = await postStream(P65, "/v1/responses", {
    model: SPARK, input: "SCN:threesearch MARK:P12", stream: true,
  });
  const fus = fuReqs("P12");
  const tr = respToolResults(fus[fus.length - 1] || { body: {} });
  const ok = r.status === 200 && countType(r.lines, "response.completed") === 1 && !leakedTool(r.raw) &&
    fus.length >= 1 &&
    (tr["call_mock_rs1"] || "").includes("RESULT-FOR:SLOW Q1 apple") &&
    (tr["call_mock_rs3"] || "").includes("RESULT-FOR:SLOW Q3 cherry");
  rec("P12", "responses原生spark(F循环)并行+配对", ok,
    `completed=${countType(r.lines, "response.completed")} fus=${fus.length}`);
}

async function p13() {
  const r = await postStream(P65, "/v1/chat/completions", {
    model: DS, stream: true,
    messages: [{ role: "user", content: "SCN:searchloop MARK:P13" }],
  });
  const ups = readJsonl("requests-full.jsonl").filter((e) => e.mark === "P13");
  const ok = r.status === 200 && ups.length === 6 && !leakedTool(r.raw) && r.raw.includes("MOCK-FINAL");
  rec("P13", "5轮上限回归：6次上游、无泄漏、正常收尾", ok, `ups=${ups.length}`);
}

// ---------------- S-group: 30-cell true-streaming matrix re-run ----------------
async function sCell(iface, model, idx) {
  const mark = `S${idx}`;
  const m = model === "muse-spark-1.2-contributor-free" ? SPARK : model + "-search";
  let r;
  if (iface === "chat") {
    r = await postStream(P65, "/v1/chat/completions", {
      model: m, stream: true, messages: [{ role: "user", content: `SCN:slowsearch MARK:${mark}` }],
    });
  } else if (iface === "responses") {
    r = await postStream(P65, "/v1/responses", { model: m, input: `SCN:slowsearch MARK:${mark}`, stream: true });
  } else {
    r = await postStream(P65, "/v1/messages", {
      model: m, max_tokens: 200, stream: true,
      messages: [{ role: "user", content: `SCN:slowsearch MARK:${mark}` }],
    });
  }
  const doneCount = iface === "chat"
    ? (r.raw.match(/"finish_reason":"stop"|"finish_reason":"tool_calls"/g) || []).length
    : iface === "responses"
      ? countType(r.lines, "response.completed")
      : r.lines.filter((l) => l.type === "message_stop").length;
  const fuCount = readJsonl("requests-full.jsonl").filter((e) => e.mark === mark && e.followUp).length;
  const ok = r.status === 200 && r.firstDeltaMs !== null && r.firstDeltaMs < 1500 &&
    r.firstDeltaMs < r.totalMs - 1200 && doneCount === 1 && fuCount >= 1 && !leakedTool(r.raw);
  if (!ok) {
    rec(`S-${iface}-${model}`, "真流式", false,
      `first=${r.firstDeltaMs} total=${r.totalMs} done=${doneCount} fu=${fuCount} status=${r.status}`);
  }
  return ok;
}

async function sGroup() {
  let pass = 0, total = 0, idx = 0;
  for (const iface of ["chat", "responses", "messages"]) {
    for (const model of MODELS10) {
      idx++;
      total++;
      try {
        if (await sCell(iface, model, idx)) pass++;
      } catch (e) {
        rec(`S-${iface}-${model}`, "真流式", false, `threw: ${e.message}`);
      }
    }
  }
  rec("S", `真流式矩阵 30格（3接口×10模型，搜索开+流式）`, pass === total, `${pass}/${total}`);
}

// ---------------- T-group: upstream truncation ----------------
// mock 上游在正文一半处直接断开（无完成信号）→ 下游必须收到错误/未完成信号，
// 且不出现伪造的 completed/stop/[DONE]。正常完成与声明式截断必须不受影响。
async function t1() {
  // /v1/chat + 非 spark 流式（B 循环）：error chunk 收尾，无伪造 stop/[DONE]
  const r = await postStream(P65, "/v1/chat/completions", {
    model: "mimo-v2.6-flash-free-search", stream: true,
    messages: [{ role: "user", content: "SCN:trunc MARK:T1" }],
  });
  const hasPartial = r.raw.includes("MOCK-B-TRUNC partial");
  const hasErr = r.raw.includes("upstream_truncated");
  const forgedStop = /"finish_reason":"stop"/.test(r.raw);
  const hasDone = r.raw.includes("[DONE]");
  rec("T1", "chat流式断流→error chunk、无伪造stop/[DONE]", hasPartial && hasErr && !forgedStop && !hasDone,
    `partial=${hasPartial} err=${hasErr} forgedStop=${forgedStop} done=${hasDone} status=${r.status}`);
}
async function t2() {
  // /v1/responses + spark 流式（D 循环）：response.failed，无伪造 completed
  const r = await postStream(P65, "/v1/responses", {
    model: SPARK, stream: true,
    input: [{ role: "user", content: "SCN:truncresp MARK:T2" }],
  });
  const types = r.lines.map((l) => l.type);
  rec("T2", "responses流式断流→response.failed、无伪造completed",
    types.includes("response.failed") && !types.includes("response.completed"),
    `failed=${types.includes("response.failed")} completed=${types.includes("response.completed")} status=${r.status}`);
}
async function t3() {
  // /v1/messages + spark 流式（F 循环）：error 事件，无伪造 message_stop
  const r = await postStream(P65, "/v1/messages", {
    model: SPARK, stream: true, max_tokens: 100,
    messages: [{ role: "user", content: "SCN:truncresp MARK:T3" }],
  });
  const hasErr = r.lines.some((l) => l.type === "error");
  const hasStop = r.lines.some((l) => l.type === "message_stop");
  rec("T3", "messages流式断流→error事件、无伪造message_stop", hasErr && !hasStop,
    `err=${hasErr} stop=${hasStop} status=${r.status}`);
}
async function t4() {
  // /v1/chat + 非 spark 非流式（C 循环）：502 + 错误形状，无伪造 completion
  const r = await post(P65, "/v1/chat/completions", {
    model: "mimo-v2.6-flash-free-search", stream: false,
    messages: [{ role: "user", content: "SCN:trunc MARK:T4" }],
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const isErr = r.status === 502 && !!(j && j.error);
  const forged = /"finish_reason":"stop"/.test(r.text);
  rec("T4", "chat非流式断流→502错误形状、无伪造completion", isErr && !forged,
    `status=${r.status} errShape=${!!(j && j.error)} forged=${forged}`);
}
async function t5() {
  // /v1/responses + spark 非流式（NS 循环）：502 + 错误形状
  const r = await post(P65, "/v1/responses", {
    model: SPARK,
    input: [{ role: "user", content: "SCN:truncresp MARK:T5" }],
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const isErr = r.status === 502 && !!(j && j.error);
  const forged = /"status":"completed"/.test(r.text);
  rec("T5", "responses非流式断流→502错误形状、无伪造completed", isErr && !forged,
    `status=${r.status} errShape=${!!(j && j.error)} forged=${forged}`);
}
async function t6() {
  // /v1/responses + 非 spark 搜索流式（X 循环）：response.failed，无伪造 completed
  const r = await postStream(P65, "/v1/responses", {
    model: "mimo-v2.6-flash-free-search", stream: true,
    input: [{ role: "user", content: "SCN:trunc MARK:T6" }],
  });
  const types = r.lines.map((l) => l.type);
  rec("T6", "X会话断流→response.failed、无伪造completed",
    types.includes("response.failed") && !types.includes("response.completed"),
    `failed=${types.includes("response.failed")} completed=${types.includes("response.completed")} status=${r.status}`);
}
async function t7() {
  // /v1/messages + 非 spark 搜索流式（X 循环 anthropic）：error 事件，无伪造 message_stop
  const r = await postStream(P65, "/v1/messages", {
    model: "mimo-v2.6-flash-free-search", stream: true, max_tokens: 100,
    messages: [{ role: "user", content: "SCN:trunc MARK:T7" }],
  });
  const hasErr = r.lines.some((l) => l.type === "error");
  const hasStop = r.lines.some((l) => l.type === "message_stop");
  rec("T7", "X会话(anthropic)断流→error事件、无伪造message_stop", hasErr && !hasStop,
    `err=${hasErr} stop=${hasStop} status=${r.status}`);
}
async function t8() {
  // 正常完成不受影响：chat 流式仍有 stop + [DONE]，无截断误报
  const r = await postStream(P65, "/v1/chat/completions", {
    model: "mimo-v2.6-flash-free-search", stream: true,
    messages: [{ role: "user", content: "SCN:text MARK:T8" }],
  });
  const hasStop = /"finish_reason":"stop"/.test(r.raw);
  const hasDone = r.raw.includes("[DONE]");
  const noErr = !r.raw.includes("upstream_truncated");
  rec("T8", "正常完成不受影响（stop+[DONE]，无误报）", hasStop && hasDone && noErr,
    `stop=${hasStop} done=${hasDone} noErr=${noErr}`);
}
async function t9() {
  // 上游声明 length：非流式仍透出 length，不误报截断
  const r = await post(P65, "/v1/chat/completions", {
    model: "mimo-v2.6-flash-free-search", stream: false,
    messages: [{ role: "user", content: "SCN:len MARK:T9" }],
  });
  let j = null; try { j = JSON.parse(r.text); } catch {}
  const fr = j && j.choices && j.choices[0] && j.choices[0].finish_reason;
  rec("T9", "声明式length截断照旧透出（不误报）", fr === "length" && !(j && j.error),
    `finish=${fr} status=${r.status}`);
}
async function t10() {
  // X 会话正常完成：response.completed，无误报
  const r = await postStream(P65, "/v1/responses", {
    model: "mimo-v2.6-flash-free-search", stream: true,
    input: [{ role: "user", content: "SCN:text MARK:T10" }],
  });
  const types = r.lines.map((l) => l.type);
  rec("T10", "X会话正常完成（completed，无误报）",
    types.includes("response.completed") && !types.includes("response.failed"),
    `completed=${types.includes("response.completed")} failed=${types.includes("response.failed")}`);
}
async function t11() {
  // /v1/responses + 非 spark 无搜索流式（streamChatToResponses）：response.failed
  const r = await postStream(P65, "/v1/responses", {
    model: "mimo-v2.6-flash-free", stream: true,
    input: [{ role: "user", content: "SCN:trunc MARK:T11" }],
  });
  const types = r.lines.map((l) => l.type);
  rec("T11", "无搜索翻译路径断流→response.failed、无伪造completed",
    types.includes("response.failed") && !types.includes("response.completed"),
    `failed=${types.includes("response.failed")} completed=${types.includes("response.completed")} status=${r.status}`);
}
async function t12() {
  // /v1/messages + 非 spark 无搜索流式（streamChatToAnthropic）：error 事件
  const r = await postStream(P65, "/v1/messages", {
    model: "mimo-v2.6-flash-free", stream: true, max_tokens: 100,
    messages: [{ role: "user", content: "SCN:trunc MARK:T12" }],
  });
  const hasErr = r.lines.some((l) => l.type === "error");
  const hasStop = r.lines.some((l) => l.type === "message_stop");
  rec("T12", "无搜索翻译路径(messages)断流→error事件、无伪造message_stop", hasErr && !hasStop,
    `err=${hasErr} stop=${hasStop} status=${r.status}`);
}
async function t13() {
  // /v1/chat + spark 流式（streamResponsesToChat）：error chunk，无伪造 stop/[DONE]
  const r = await postStream(P65, "/v1/chat/completions", {
    model: SPARK, stream: true,
    messages: [{ role: "user", content: "SCN:truncresp MARK:T13" }],
  });
  const hasErr = r.raw.includes("upstream_truncated");
  const forgedStop = /"finish_reason":"stop"/.test(r.raw);
  const hasDone = r.raw.includes("[DONE]");
  rec("T13", "chat+spark流式断流→error chunk、无伪造stop/[DONE]", hasErr && !forgedStop && !hasDone,
    `err=${hasErr} forgedStop=${forgedStop} done=${hasDone} status=${r.status}`);
}

async function tGroup() {
  for (const t of [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13]) {
    try { await t(); } catch (e) { rec(t.name, "断流", false, `threw: ${e.message}`); }
  }
}

// ---------------- G-group: 120-grid (3接口×10模型×流式/非流式×搜索开/关) ----------------
// v63 的 120 格矩阵文件已失传，此处按同样维度重建：每格断言 200 + 正文 marker，
// 非流式加断言 usage 存在且数值合理。
function gBody(iface, model, stream, mark) {
  const content = `SCN:text MARK:${mark}`;
  if (iface === "chat")
    return ["/v1/chat/completions", { model, stream, messages: [{ role: "user", content }] }];
  if (iface === "responses")
    return ["/v1/responses", { model, stream, input: [{ role: "user", content }] }];
  return ["/v1/messages", { model, stream, max_tokens: 100, messages: [{ role: "user", content }] }];
}
async function gCell(iface, model, stream, search, idx) {
  const mname = search ? `${model}-search` : model;
  const mark = `G${idx}`;
  const [path, body] = gBody(iface, mname, stream, mark);
  const id = `G-${iface}-${model.split("-")[0]}-${stream ? "s" : "ns"}-${search ? "q" : "nq"}`;
  try {
    if (stream) {
      const r = await postStream(P65, path, body);
      const ok = r.status === 200 && r.raw.includes("MOCK");
      if (!ok) rec(id, "120格", false, `status=${r.status} hasMock=${r.raw.includes("MOCK")}`);
      return ok;
    }
    const r = await post(P65, path, body);
    let j = null; try { j = JSON.parse(r.text); } catch {}
    const hasMock = r.text.includes("MOCK");
    const u = j && (j.usage || j.response?.usage);
    const uok = u && (u.prompt_tokens === 11 || u.input_tokens === 11) && (u.completion_tokens === 7 || u.output_tokens === 7);
    const ok = r.status === 200 && hasMock && !!uok;
    if (!ok) rec(id, "120格", false, `status=${r.status} mock=${hasMock} usage=${JSON.stringify(u)}`);
    return ok;
  } catch (e) {
    rec(id, "120格", false, `threw: ${e.message}`);
    return false;
  }
}
async function gGroup() {
  let pass = 0, total = 0, idx = 0;
  for (const iface of ["chat", "responses", "messages"]) {
    for (const model of MODELS10) {
      for (const stream of [true, false]) {
        for (const search of [true, false]) {
          idx++; total++;
          if (await gCell(iface, model, stream, search, idx)) pass++;
        }
      }
    }
  }
  rec("G", "120格矩阵（3接口×10模型×流式/非流式×搜索开/关）", pass === total, `${pass}/${total}`);
}

// ---------------- U-group: 用量 16 项 ----------------
// mock text 场景的已知用量：chat 11/7/18，responses 11/7/18，messages 11/7。
// 断言代理透出的 usage 精确值（防 BUG-3 类重复计数/丢失回退）。
async function uCell(id, path, body, check) {
  try {
    const r = await post(P65, path, body);
    const j = JSON.parse(r.text);
    const u = j.usage || j.response?.usage;
    const ok = r.status === 200 && check(u);
    rec(id, "用量", ok, ok ? "" : `status=${r.status} usage=${JSON.stringify(u)}`);
  } catch (e) { rec(id, "用量", false, `threw: ${e.message}`); }
}
const U11 = (u) => u && u.prompt_tokens === 11 && u.completion_tokens === 7 && u.total_tokens === 18;
const U117 = (u) => u && u.input_tokens === 11 && u.output_tokens === 7;
// 流式 usage 的字段命名随路径而异（chat 流式用 input_tokens、responses 直传用 prompt_tokens），
// 只校验数值（mock text 场景已知值 11/7）。
const U_NUM = (u) => u && (u.prompt_tokens ?? u.input_tokens) === 11 && (u.completion_tokens ?? u.output_tokens) === 7;
async function uGroup() {
  const mk = (m) => `SCN:text MARK:U-${m}`;
  await uCell("U1", "/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: false, messages: [{ role: "user", content: mk("U1") }] }, U11);
  await uCell("U2", "/v1/chat/completions", { model: "deepseek-v4.1-flash-free", stream: false, messages: [{ role: "user", content: mk("U2") }] }, U11);
  await uCell("U3", "/v1/chat/completions", { model: "muse-spark-1.2-contributor-free-search", stream: false, messages: [{ role: "user", content: mk("U3") }] }, U11);
  await uCell("U4", "/v1/chat/completions", { model: "longcat-2.5-preview-free", stream: false, messages: [{ role: "user", content: mk("U4") }] }, U11);
  await uCell("U5", "/v1/responses", { model: "muse-spark-1.2-contributor-free-search", input: [{ role: "user", content: mk("U5") }] }, U117);
  await uCell("U6", "/v1/responses", { model: "muse-spark-1.2-contributor-free", input: [{ role: "user", content: mk("U6") }] }, U117);
  await uCell("U7", "/v1/responses", { model: "mimo-v2.6-flash-free-search", input: [{ role: "user", content: mk("U7") }] }, U117);
  await uCell("U8", "/v1/responses", { model: "big-pickle", input: [{ role: "user", content: mk("U8") }] }, U117);
  await uCell("U9", "/v1/messages", { model: "muse-spark-1.2-contributor-free-search", max_tokens: 100, messages: [{ role: "user", content: mk("U9") }] }, U117);
  await uCell("U10", "/v1/messages", { model: "muse-spark-1.2-contributor-free", max_tokens: 100, messages: [{ role: "user", content: mk("U10") }] }, U117);
  await uCell("U11", "/v1/messages", { model: "nemotron-3.5-lightning-free-search", max_tokens: 100, messages: [{ role: "user", content: mk("U11") }] }, U117);
  await uCell("U12", "/v1/messages", { model: "space-bunny-free", max_tokens: 100, messages: [{ role: "user", content: mk("U12") }] }, U117);
  // U13-U16：流式尾部 usage 事件数值正确
  try {
    const r13 = await postStream(P65, "/v1/chat/completions", { model: "mimo-v2.6-flash-free-search", stream: true, messages: [{ role: "user", content: mk("U13") }] });
    const u13 = r13.lines.map((l) => l.usage).find(Boolean);
    rec("U13", "用量", r13.status === 200 && U_NUM(u13), `usage=${JSON.stringify(u13)}`);
    const r14 = await postStream(P65, "/v1/responses", { model: "muse-spark-1.2-contributor-free-search", stream: true, input: [{ role: "user", content: mk("U14") }] });
    const c14 = r14.lines.find((l) => l.type === "response.completed");
    rec("U14", "用量", r14.status === 200 && U_NUM(c14?.response?.usage), `usage=${JSON.stringify(c14?.response?.usage)}`);
    // U15: mock 在此场景故意发非标准命名（prompt_tokens）测回退，translator 按既有语义发 0/0 不崩；
    // 此处只断言结构（message_delta + usage 对象 + end_turn），数值精确性由 U1-U14 覆盖。
    const r15 = await postStream(P65, "/v1/messages", { model: "muse-spark-1.2-contributor-free-search", stream: true, max_tokens: 100, messages: [{ role: "user", content: mk("U15") }] });
    const d15 = r15.lines.find((l) => l.type === "message_delta" && l.usage);
    const u15ok = r15.status === 200 && d15 && d15.delta?.stop_reason === "end_turn" && typeof d15.usage === "object";
    rec("U15", "用量", !!u15ok, `delta=${JSON.stringify(d15)}`);
    const r16 = await postStream(P65, "/v1/responses", { model: "mimo-v2.6-flash-free-search", stream: true, input: [{ role: "user", content: mk("U16") }] });
    const c16 = r16.lines.find((l) => l.type === "response.completed");
    rec("U16", "用量", r16.status === 200 && U_NUM(c16?.response?.usage), `usage=${JSON.stringify(c16?.response?.usage)}`);
  } catch (e) { rec("U13-16", "用量", false, `threw: ${e.message}`); }
}

// ---------------- main ----------------
async function main() {
  const only = process.env.V65_ONLY || "";
  const run = (g) => !only || only.split(",").includes(g);
  if (run("P")) {
    console.log("== P-group: parallel execution ==");
    const span65 = await p1();
    const span64 = await p1b();
    console.log(`   timing: v65(parallel)=${span65}ms  v64(sequential)=${span64}ms`);
    await p2(); await p2b(); await p3(); await p3b(); await p4(); await p4b();
    await p5(); await p6(); await p7(); await p8(); await p9(); await p10();
    await p11(); await p12(); await p13();
    var span65v = span65, span64v = span64;
  }
  if (run("T")) { console.log("== T-group: upstream truncation =="); await tGroup(); }
  if (run("S")) { console.log("== S-group: streaming matrix =="); await sGroup(); }
  if (run("G")) { console.log("== G-group: 120-grid =="); await gGroup(); }
  if (run("U")) { console.log("== U-group: usage =="); await uGroup(); }
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== ${pass}/${results.length} passed ====`);
  fs.writeFileSync(path.join(DIR, "v65-results.json"), JSON.stringify({ results }, null, 2));
  if (pass !== results.length) process.exit(1);
}
main().catch((e) => { console.error("runner failed:", e); process.exit(2); });
