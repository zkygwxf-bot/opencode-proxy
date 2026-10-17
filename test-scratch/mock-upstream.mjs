// Mock upstream for opencode-proxy tests.
// HTTPS on 127.0.0.1:443 (the proxy is DNS-redirected: opencode.ai -> 127.0.0.1).
// Serves /zen/v1/chat/completions and /zen/v1/responses with scripted scenarios.
// Scenario selection: first user text contains "SCN:<name>".
// Follow-up detection (tool roundtrips): messages contain role "tool", or
// input contains {type:"function_call_output"} -> scenario "final".
// Every request is appended to requests.jsonl for assertions.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(DIR, "requests.jsonl");
try { fs.unlinkSync(LOG); } catch {}
const logReq = (e) => fs.appendFileSync(LOG, JSON.stringify(e) + "\n");
// C组自查用：完整上游请求体日志（供 R79 id 链断言），不影响 requests.jsonl
const FULLLOG = path.join(DIR, "requests-full.jsonl");
try { fs.unlinkSync(FULLLOG); } catch {}
const logFull = (e) => { try { fs.appendFileSync(FULLLOG, JSON.stringify(e) + "\n"); } catch {} };

const DISGUISE = new Set(["read", "shell"]);
const PROXY_BUILTIN = new Set(["webfetch", "websearch"]);

function textsOf(items) {
  if (typeof items === "string") return items; // v65: responses 原生 input 可能是字符串
  const out = [];
  for (const m of items || []) {
    if (!m || typeof m !== "object" || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c))
      for (const p of c) if (typeof p?.text === "string") out.push(p.text);
  }
  return out.join("\n");
}
const scenarioOf = (body) => {
  const m = textsOf(body.messages || body.input).match(/SCN:([a-z0-9-]+)/);
  return m ? m[1] : "text";
};
const markOf = (body) => {
  const m = textsOf(body.messages || body.input).match(/MARK:([A-Za-z0-9-]+)/);
  return m ? m[1] : "";
};
// C组：webfetch 探针 URL（fetchprobe 场景），默认本地抓取目标
const probeUrlOf = (body) => {
  const m = textsOf(body.messages || body.input).match(/URL:([^\s"']+)/);
  return m ? m[1] : "http://127.0.0.1:18901/page";
};
// C组：final 场景回显工具输出（让客户端能看到 webfetch 执行结果）
const echoOutputs = (body) => {
  const outs = [];
  for (const m of body.messages || body.input || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool" && typeof m.content === "string") outs.push(m.content);
    else if (m.type === "function_call_output" && typeof m.output === "string")
      outs.push(m.output);
  }
  return outs.length ? " [ECHO:" + outs.join(" // ").slice(0, 600) + "]" : "";
};
const isFollowUp = (body) => {
  for (const m of body.messages || body.input || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool") return true;
    if (m.type === "function_call_output") return true;
  }
  return false;
};
// v65: follow-up 里已有的工具结果条数（多轮搜索场景用）
const nToolOutputs = (body) => {
  let n = 0;
  for (const m of body.messages || body.input || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool") n++;
    else if (m.type === "function_call_output") n++;
  }
  return n;
};
const toolNames = (body) =>
  (body.tools || []).map((t) => t?.function?.name || t?.name).filter(Boolean);
const clientToolName = (body) =>
  toolNames(body).find((n) => !DISGUISE.has(n) && !PROXY_BUILTIN.has(n)) ||
  "get_weather";

// ---------- chat SSE builders ----------
const cc = (id, model, delta, finish = null) =>
  `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: 1760310000, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const cUsage = (id, model, usage) =>
  `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: 1760310000, model,
    choices: [], usage,
  })}\n\n`;

function chatSSE(body, scenario, mark) {
  const id = "chatcmpl-mock";
  const model = body.model || "m";
  const fu = isFollowUp(body);
  // 未知 scenario（如 slow 延迟后）按 text 处理
  const scn = scenario === "searchloop" ? "searchloop" : scenario === "searchrounds" ? "searchrounds" : scenario === "slowsearch" ? "slowsearch" : fu ? "final" : ["text","toolcall","searchcall","reasoning","final","fetchprobe","len","cf","fragname","twotools","threesearch","threesearchfail","threesearchfailfirst","threemix","mixsearch","mixsearchfailfetch"].includes(scenario) ? scenario : "text";
  const name = clientToolName(body);
  let s = "";
  const done = () => (s += "data: [DONE]\n\n");
  if (scn === "text") {
    s += cc(id, model, { role: "assistant", content: `MOCK-CHAT-TEXT ${mark}` });
    s += cc(id, model, {}, "stop");
    // 非标准命名（chat 标准是 prompt_tokens/completion_tokens）：测回退
    s += cUsage(id, model, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    done();
  } else if (scn === "len") {
    // C组 R100：finish_reason=length
    s += cc(id, model, { role: "assistant", content: `MOCK-CHAT-LEN ${mark}` });
    s += cc(id, model, {}, "length");
    s += cUsage(id, model, { input_tokens: 71, output_tokens: 25, total_tokens: 96 });
    done();
  } else if (scn === "cf") {
    // C组 R100：finish_reason=content_filter
    s += cc(id, model, { role: "assistant", content: `MOCK-CHAT-CF ${mark}` });
    s += cc(id, model, {}, "content_filter");
    s += cUsage(id, model, { input_tokens: 72, output_tokens: 26, total_tokens: 98 });
    done();
  } else if (scn === "fetchprobe") {
    // C组 R93/R94：webfetch 探针，URL 从 URL: 标记取
    const purl = probeUrlOf(body);
    const args = JSON.stringify({ url: purl, format: "text" });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_probe", type: "function", function: { name: "webfetch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 81, output_tokens: 27, total_tokens: 108 });
    done();
  } else if (scn === "toolcall") {
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name, arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: 'ty":"Beijing"}' } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 21, output_tokens: 9, total_tokens: 30 });
    done();
  } else if (scn === "searchcall") {
    const args = JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_wf", type: "function", function: { name: "webfetch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 31, output_tokens: 12, total_tokens: 43 });
    done();
  } else if (scn === "reasoning") {
    s += cc(id, model, { role: "assistant", reasoning_content: "MOCK-REASONING " });
    s += cc(id, model, { reasoning_content: "MOCK-REASONING-2 " });
    s += cc(id, model, { content: "MOCK-REASON-DONE" });
    s += cc(id, model, {}, "stop");
    s += cUsage(id, model, { input_tokens: 41, output_tokens: 15, total_tokens: 56 });
    done();
  } else if (scn === "fragname") {
    // D组分片测试：工具名拆成两个 SSE chunk（"get_wea"+"ther" 客户端工具，"webfe"+"tch" 代理工具）
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_frag_1", type: "function", function: { name: "get_wea", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { name: "ther", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: '{"city":"X"}' } }] });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 1, id: "call_frag_2", type: "function", function: { name: "webfe", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, function: { name: "tch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" }) } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 91, output_tokens: 33, total_tokens: 124 });
    done();
  } else if (scn === "twotools") {
    // C组 R101/R103：同一轮两个 tool_calls（index 0/1）
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_a", type: "function", function: { name, arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, id: "call_mock_b", type: "function", function: { name: "get_time", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, function: { arguments: '{"tz":"Shanghai"}' } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 91, output_tokens: 33, total_tokens: 124 });
    done();
  } else if (scn === "searchloop") {
    // D组: 每轮都调 webfetch（含 follow-up），测 proxy 5 轮上限
    // v65: 第 6 次上游（收尾 follow-up，已有 5 个工具结果）返回正文，
    // 模拟真实模型在上限轮收敛回答
    if (nToolOutputs(body) >= 5) {
      s += cc(id, model, { role: "assistant", content: `MOCK-FINAL ${mark}${echoOutputs(body)}` });
      s += cc(id, model, {}, "stop");
      s += cUsage(id, model, { input_tokens: 51, output_tokens: 5, total_tokens: 56 });
      done();
    } else {
      const args = JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" });
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_loop", type: "function", function: { name: "webfetch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
      s += cc(id, model, {}, "tool_calls");
      s += cUsage(id, model, { input_tokens: 61, output_tokens: 11, total_tokens: 72 });
      done();
    }
  } else if (scn === "threesearch") {
    // v65 P1/P2：一轮 3 个 websearch 调用（SLOW 延迟由 mock exa 提供）
    const qs = ["SLOW Q1 apple", "SLOW Q2 banana", "SLOW Q3 cherry"];
    qs.forEach((q, i) => {
      const args = JSON.stringify({ query: q });
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: i, id: `call_mock_s${i + 1}`, type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: i, function: { arguments: args } }] });
    });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 41, total_tokens: 102 });
    done();
  } else if (scn === "threesearchfail") {
    // v65 P3：3 调用中 1 个失败（FAILME -> mock exa 500），失败项在中间
    const qs = ["SLOW Q1 apple", "FAILME boom", "SLOW Q3 cherry"];
    qs.forEach((q, i) => {
      const args = JSON.stringify({ query: q });
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: i, id: `call_mock_f${i + 1}`, type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: i, function: { arguments: args } }] });
    });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 41, total_tokens: 102 });
    done();
  } else if (scn === "threesearchfailfirst") {
    // v65 P3b：失败项在第一位
    const qs = ["FAILME first", "SLOW Q2 banana", "SLOW Q3 cherry"];
    qs.forEach((q, i) => {
      const args = JSON.stringify({ query: q });
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: i, id: `call_mock_g${i + 1}`, type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: i, function: { arguments: args } }] });
    });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 41, total_tokens: 102 });
    done();
  } else if (scn === "threemix") {
    // v65 P2b：完成顺序与调用顺序不同（FAST 60ms 先于 SLOW 900ms 完成），配对必须按 call_id
    const qs = ["SLOW Q1 first", "FAST Q2 second", "SLOW Q3 third"];
    qs.forEach((q, i) => {
      const args = JSON.stringify({ query: q });
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: i, id: `call_mock_x${i + 1}`, type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: i, function: { arguments: args } }] });
    });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 41, total_tokens: 102 });
    done();
  } else if (scn === "mixsearchfailfetch") {
    // v65 P4b：websearch 成功 + webfetch 404 失败混合
    const sArgs = JSON.stringify({ query: "SLOW Q-mix2" });
    const fArgs = JSON.stringify({ url: "http://127.0.0.1:18901/nope", format: "text" });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_n1", type: "function", function: { name: "websearch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: sArgs } }] });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 1, id: "call_mock_n2", type: "function", function: { name: "webfetch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, function: { arguments: fArgs } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 42, total_tokens: 103 });
    done();
  } else if (scn === "mixsearch") {
    // v65 P4：同轮 websearch + webfetch 混合
    const sArgs = JSON.stringify({ query: "SLOW Q-mix" });
    const fArgs = JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_m1", type: "function", function: { name: "websearch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: sArgs } }] });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 1, id: "call_mock_m2", type: "function", function: { name: "webfetch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 1, function: { arguments: fArgs } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 42, total_tokens: 103 });
    done();
  } else if (scn === "searchrounds") {
    // v65 P5：多轮搜索（round1 搜 -> follow-up round2 再搜 -> final）
    const n = nToolOutputs(body);
    if (n < 2) {
      const q = n === 0 ? "SLOW round1" : "SLOW round2";
      const args = JSON.stringify({ query: q });
      const cid = n === 0 ? "call_mock_r1" : "call_mock_r2";
      s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: cid, type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
      s += cc(id, model, {}, "tool_calls");
      s += cUsage(id, model, { input_tokens: 61, output_tokens: 21, total_tokens: 82 });
      done();
    } else {
      s += cc(id, model, { role: "assistant", content: `MOCK-FINAL ${mark}${echoOutputs(body)}` });
      s += cc(id, model, {}, "stop");
      s += cUsage(id, model, { input_tokens: 51, output_tokens: 5, total_tokens: 56 });
      done();
    }
  } else if (scn === "slowsearch") {
    // v65 S组：流式矩阵用——慢速正文块 + 1 个 websearch 调用
    if (fu) {
      s += cc(id, model, { role: "assistant", content: `MOCK-FINAL ${mark}${echoOutputs(body)}` });
      s += cc(id, model, {}, "stop");
      s += cUsage(id, model, { input_tokens: 51, output_tokens: 5, total_tokens: 56 });
      done();
    } else {
      s += cc(id, model, { role: "assistant", content: `MOCK-SLOW-1 ${mark} ` });
      s += cc(id, model, { content: `MOCK-SLOW-2 ${mark} ` });
      s += cc(id, model, { content: `MOCK-SLOW-3 ${mark} ` });
      const args = JSON.stringify({ query: `SLOW matrix ${mark}` });
      s += cc(id, model, { tool_calls: [{ index: 0, id: "call_mock_ss", type: "function", function: { name: "websearch", arguments: "" } }] });
      s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
      s += cc(id, model, {}, "tool_calls");
      s += cUsage(id, model, { input_tokens: 61, output_tokens: 41, total_tokens: 102 });
      done();
    }
  } else if (scn === "final") {
    s += cc(id, model, { role: "assistant", content: `MOCK-FINAL ${mark}${echoOutputs(body)}` });
    s += cc(id, model, {}, "stop");
    s += cUsage(id, model, { input_tokens: 51, output_tokens: 5, total_tokens: 56 });
    done();
  }
  return s;
}
const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
function respSSE(body, scenario, mark) {
  const model = body.model || "m";
  const rid = "resp_mock_1";
  const fu = isFollowUp(body);
  // 未知 scenario（如 slow 延迟后）按 text 处理
  const scn = scenario === "searchloop" ? "searchloop" : scenario === "searchrounds" ? "searchrounds" : scenario === "slowsearch" ? "slowsearch" : fu ? "final" : ["text","toolcall","searchcall","reasoning","final","thinktext","len","cf","fetchprobe","twotools","thinktool","threesearch"].includes(scenario) ? scenario : "text";
  const name = clientToolName(body);
  // 非标准命名（responses 标准是 input_tokens/output_tokens）：测回退
  const usage = (p, c, t) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: t });
  let s = "";
  const created = () =>
    ev({ type: "response.created", response: { id: rid, object: "response", created: 1760310000, model, status: "in_progress", output: [] } });
  const msgAdded = () => {
    s += ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_mock_1", role: "assistant", content: [] } });
    s += ev({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_mock_1", part: { type: "output_text", text: "", annotations: [] } });
  };
  const textDeltas = (t) => {
    for (const piece of t.match(/.{1,8}/g) || [t])
      s += ev({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_mock_1", delta: piece });
  };
  const textDone = (t) => {
    s += ev({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_mock_1", text: t });
    s += ev({ type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_mock_1", part: { type: "output_text", text: t, annotations: [] } });
    s += ev({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_mock_1", role: "assistant", content: [{ type: "output_text", text: t, annotations: [] }] } });
  };
  const completed = (u) =>
    s += ev({ type: "response.completed", response: { id: rid, object: "response", created: 1760310000, model, status: "completed", output: [], usage: u } });
  const fnCall = (callId, fnName, argsStr, idx = 1) => {
    s += ev({ type: "response.output_item.added", output_index: idx, item: { type: "function_call", id: callId, call_id: callId, name: fnName, arguments: "" } });
    for (const piece of argsStr.match(/.{1,10}/g) || [])
      s += ev({ type: "response.function_call_arguments.delta", output_index: idx, item_id: callId, delta: piece });
    s += ev({ type: "response.output_item.done", output_index: idx, item: { type: "function_call", id: callId, call_id: callId, name: fnName, arguments: argsStr } });
  };

  if (scn === "text") {
    s += created(); msgAdded();
    textDeltas(`MOCK-RESP-TEXT ${mark}`);
    textDone(`MOCK-RESP-TEXT ${mark}`);
    completed(usage(11, 7, 18));
  } else if (scn === "toolcall") {
    s += created();
    fnCall("call_mock_1", name, '{"city":"Beijing"}');
    completed(usage(21, 9, 30));
  } else if (scn === "searchcall") {
    s += created();
    fnCall("call_mock_wf", "webfetch", JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" }));
    completed(usage(31, 12, 43));
  } else if (scn === "threesearch") {
    // v65 P1：spark 通道一轮 3 个 websearch 调用
    s += created();
    const qs = ["SLOW Q1 apple", "SLOW Q2 banana", "SLOW Q3 cherry"];
    qs.forEach((q, i) => fnCall(`call_mock_rs${i + 1}`, "websearch", JSON.stringify({ query: q }), i + 1));
    completed(usage(61, 41, 102));
  } else if (scn === "slowsearch") {
    // v65 S组：spark 通道慢速正文 + 1 个 websearch 调用
    if (fu) {
      const ft = `MOCK-FINAL ${mark}${echoOutputs(body)}`;
      s += created(); msgAdded();
      textDeltas(ft);
      textDone(ft);
      completed(usage(51, 5, 56));
    } else {
      s += created(); msgAdded();
      textDeltas(`MOCK-SLOW-1 ${mark} `);
      textDeltas(`MOCK-SLOW-2 ${mark} `);
      textDeltas(`MOCK-SLOW-3 ${mark} `);
      fnCall("call_mock_ss", "websearch", JSON.stringify({ query: `SLOW matrix ${mark}` }), 1);
      completed(usage(61, 41, 102));
    }
  } else if (scn === "reasoning") {
    s += created(); msgAdded();
    s += ev({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "msg_mock_1", delta: "MOCK-REASONING " });
    textDeltas("MOCK-REASON-DONE");
    textDone("MOCK-REASON-DONE");
    completed(usage(41, 15, 56));
  } else if (scn === "searchloop") {
    // D组: 每轮都调 webfetch（含 follow-up），测 proxy 5 轮上限
    const args = JSON.stringify({ url: "http://127.0.0.1:18901/page", format: "text" });
    s += cc(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_loop", type: "function", function: { name: "webfetch", arguments: "" } }] });
    s += cc(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] });
    s += cc(id, model, {}, "tool_calls");
    s += cUsage(id, model, { input_tokens: 61, output_tokens: 11, total_tokens: 72 });
    done();
  } else if (scn === "final") {
    const ft = `MOCK-FINAL ${mark}${echoOutputs(body)}`;
    s += created(); msgAdded();
    textDeltas(ft);
    textDone(ft);
    completed(usage(51, 5, 56));
  } else if (scn === "thinktext") {
    // C组 R71/R72/R80：reasoning -> text -> function_call 同一轮
    s += created();
    s += ev({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_mock_1", summary: [] } });
    s += ev({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "rs_mock_1", delta: "MOCK-THINK-1 " });
    s += ev({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "rs_mock_1", delta: "MOCK-THINK-2" });
    msgAdded();
    textDeltas(`MOCK-TEXT-AFTER-THINK ${mark}`);
    textDone(`MOCK-TEXT-AFTER-THINK ${mark}`);
    fnCall("call_mock_tt", name, '{"city":"Shanghai"}');
    completed(usage(61, 17, 78));
  } else if (scn === "len") {
    // C组 R100：response.incomplete + max_output_tokens -> max_tokens
    s += created(); msgAdded();
    textDeltas(`MOCK-RESP-LEN ${mark}`);
    textDone(`MOCK-RESP-LEN ${mark}`);
    s += ev({ type: "response.incomplete", response: { id: rid, object: "response", created: 1760310000, model, status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, usage: usage(71, 25, 96) } });
  } else if (scn === "cf") {
    // C组 R100：response.incomplete + content_filter
    s += created(); msgAdded();
    textDeltas(`MOCK-RESP-CF ${mark}`);
    textDone(`MOCK-RESP-CF ${mark}`);
    s += ev({ type: "response.incomplete", response: { id: rid, object: "response", created: 1760310000, model, status: "incomplete", output: [], incomplete_details: { reason: "content_filter" }, usage: usage(72, 26, 98) } });
  } else if (scn === "fetchprobe") {
    // C组 R93/R94：responses 版 webfetch 探针
    s += created();
    fnCall("call_mock_probe", "webfetch", JSON.stringify({ url: probeUrlOf(body), format: "text" }));
    completed(usage(81, 27, 108));
  } else if (scn === "twotools") {
    // C组 R101：同一轮两个 function_call
    s += created();
    fnCall("call_mock_t1", name, '{"city":"Beijing"}', 1);
    fnCall("call_mock_t2", "get_time", '{"tz":"Shanghai"}', 2);
    completed(usage(92, 34, 126));
  } else if (scn === "thinktool") {
    // C组 R102：reasoning 后直接 function_call（无 text block）
    s += created();
    s += ev({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_mock_2", summary: [] } });
    s += ev({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "rs_mock_2", delta: "MOCK-THINK-ONLY " });
    fnCall("call_mock_tht", name, '{"city":"Shenzhen"}', 1);
    completed(usage(93, 35, 128));
  }
  return s;
}

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(DIR, "cert/key.pem")),
    cert: fs.readFileSync(path.join(DIR, "cert/cert.pem")),
  },
  (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url, "https://opencode.ai");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _parseError: true }; }
      const names = toolNames(body);
      const entry = {
        ts: Date.now(),
        path: url.pathname,
        model: body.model || null,
        scenario: scenarioOf(body),
        mark: markOf(body),
        followUp: isFollowUp(body),
        toolNames: names,
        nTools: names.length,
      };
      logFull({ ts: entry.ts, path: entry.path, mark: entry.mark, followUp: entry.followUp, body });
      const send = (code, ctype, text) => {
        logReq(entry);
        res.writeHead(code, { "content-type": ctype });
        res.end(text);
      };
      if (url.pathname === "/zen/v1/models") {
        return send(200, "application/json", JSON.stringify({ object: "list", data: [] }));
      }
      // C组 R92：重定向目标（返回正常 text 场景）
      if (url.pathname === "/zen/v1/chat/completions-ok") {
        return send(200, "text/event-stream", chatSSE(body, "text", markOf(body)));
      }
      const respond = () => {
        if (url.pathname === "/zen/v1/chat/completions") {
          return send(200, "text/event-stream", chatSSE(body, entry.scenario, markOf(body)));
        }
        if (url.pathname === "/zen/v1/responses") {
          return send(200, "text/event-stream", respSSE(body, entry.scenario, markOf(body)));
        }
        return send(404, "application/json", JSON.stringify({ error: "mock: unknown path" }));
      };
      // C组 R90：分块慢响应（每块间隔 400ms）
      const respondChunked = () => {
        logReq(entry);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const full = chatSSE(body, "text", markOf(body));
        const parts = [];
        const lines = full.split("\n\n");
        for (let i = 0; i < lines.length; i += 2) parts.push(lines.slice(i, i + 2).join("\n\n"));
        let i = 0;
        const tick = () => {
          if (i < parts.length) { res.write(parts[i] + "\n\n"); i++; setTimeout(tick, 400); }
          else res.end();
        };
        tick();
      };
      const errJson = (code, msg, type) =>
        send(code, "application/json", JSON.stringify({ error: { message: msg, type: type || "mock_error", code: "mock_" + code } }));
      // ---- B-group fuzz scenarios (R48-R56), additive only ----
      const bId = "chatcmpl-mock";
      const bChunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: bId, object: "chat.completion.chunk", created: 1760310000, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const bUsage = (usage) =>
        `data: ${JSON.stringify({ id: bId, object: "chat.completion.chunk", created: 1760310000, model: "m", choices: [], usage })}\n\n`;
      const bDone = () => "data: [DONE]\n\n";
      const bTextFlow = (usage) =>
        bChunk({ role: "assistant", content: `MOCK-B ${markOf(body)} ` }) +
        bChunk({}, "stop") +
        bUsage(usage) + bDone();
      const bToolFlow = (calls, finishReason) => {
        // calls: [{index, id, name, argsPieces[]}]
        let s = "";
        for (const c of calls)
          s += bChunk({ role: "assistant", tool_calls: [{ index: c.index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] });
        for (const c of calls)
          for (const p of c.argsPieces)
            s += bChunk({ tool_calls: [{ index: c.index, function: { arguments: p } }] });
        s += bChunk({}, finishReason);
        s += bUsage({ input_tokens: 21, output_tokens: 9, total_tokens: 30 });
        s += bDone();
        return s;
      };
      switch (entry.scenario) {
        case "u-inout": // R48: 标准 chat 命名
          return send(200, "text/event-stream", bTextFlow({ input_tokens: 11, output_tokens: 7, total_tokens: 18 }));
        case "u-prco": // R48: responses 式命名出现在 chat 路径
          return send(200, "text/event-stream", bTextFlow({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
        case "u-mixed": // R48: 混搭命名
          return send(200, "text/event-stream", bTextFlow({ input_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
        case "u-none": // R48: usage 对象存在但双命名都缺
          return send(200, "text/event-stream", bTextFlow({}));
        case "sparse": // R49: tool_calls 稀疏索引 [0,2,5]
          return send(200, "text/event-stream", bToolFlow([
            { index: 0, id: "call_s0", name: "get_weather", argsPieces: ['{"city":"Beijing"}'] },
            { index: 2, id: "call_s2", name: "get_time", argsPieces: ['{"tz":"UTC"}'] },
            { index: 5, id: "call_s5", name: "get_date", argsPieces: ['{"fmt":"iso"}'] },
          ], "tool_calls"));
        case "trunc": { // R50: 中途断流（无 [DONE]，直接 destroy）
          logReq(entry);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(bChunk({ role: "assistant", content: "MOCK-B-TRUNC partial " }));
          res.write(`data: {"id":"${bId}","incomplete":true,"choices":[{"index":0,"delta":{"content":"cut`);
          setTimeout(() => { try { res.destroy(); } catch {} }, 200);
          return;
        }
        case "truncresp": { // v65 T组：responses 路径中途断流（无 completed，直接 destroy）
          logReq(entry);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(ev({ type: "response.created", response: { id: "resp_mock_tr", object: "response", created: 1760310000, model: "m", status: "in_progress", output: [] } }));
          res.write(ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_mock_tr", role: "assistant", content: [] } }));
          res.write(ev({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_mock_tr", delta: "MOCK-TRUNC-PARTIAL " }));
          setTimeout(() => { try { res.destroy(); } catch {} }, 200);
          return;
        }
        case "ooo": // R51: 乱序事件（usage 先到）
          return send(200, "text/event-stream",
            bUsage({ input_tokens: 11, output_tokens: 7, total_tokens: 18 }) +
            bChunk({ role: "assistant", content: `MOCK-B-OOO ${markOf(body)} ` }) +
            bChunk({}, "stop") + bDone());
        case "dupid": // R52: 重复 SSE id
          return send(200, "text/event-stream",
            "id: 7\n" + bChunk({ role: "assistant", content: `MOCK-B-DUP ${markOf(body)} ` }) +
            "id: 7\n" + bChunk({ content: "again " }) +
            "id: 7\n" + bChunk({}, "stop") + bDone());
        case "emptychoices": // R53: 空 choices 数组 chunk
          return send(200, "text/event-stream",
            `data: ${JSON.stringify({ id: bId, object: "chat.completion.chunk", created: 1760310000, model: "m", choices: [] })}\n\n` +
            bChunk({ role: "assistant", content: `MOCK-B-EC ${markOf(body)} ` }) +
            bChunk({}, "stop") + bDone());
        case "nulldelta": // R54: delta 为 null
          return send(200, "text/event-stream",
            `data: ${JSON.stringify({ id: bId, object: "chat.completion.chunk", created: 1760310000, model: "m", choices: [{ index: 0, delta: null, finish_reason: null }] })}\n\n` +
            bChunk({ role: "assistant", content: `MOCK-B-ND ${markOf(body)} ` }) +
            bChunk({}, "stop") + bUsage({ input_tokens: 11, output_tokens: 7, total_tokens: 18 }) + bDone());
        case "strusage": // R55: usage 为字符串
          return send(200, "text/event-stream", bTextFlow("oops-not-an-object"));
        case "badargs": // R56: tool 参数非法 JSON
          return send(200, "text/event-stream", bToolFlow([
            { index: 0, id: "call_bad", name: "get_weather", argsPieces: ["{not valid json!!!"] },
          ], "tool_calls"));
        case "err400":
          return send(400, "application/json", JSON.stringify({ error: { message: "mock bad request", type: "invalid_request_error", code: "mock_400" } }));
        case "err401":
          return errJson(401, "mock unauthorized: bad key", "authentication_error");
        case "err403":
          return errJson(403, "mock forbidden: model not allowed", "permission_error");
        case "err429":
          return errJson(429, "mock rate limited", "rate_limit_error");
        case "err500":
          return send(500, "application/json", JSON.stringify({ error: { message: "mock internal error" } }));
        case "err502":
          return errJson(502, "mock bad gateway", "server_error");
        case "html":
          return send(200, "text/html", "<html><body><h1>mock html error page</h1></body></html>");
        case "empty":
          return send(200, "text/event-stream", "");
        case "slow":
          return setTimeout(respond, 2500);
        case "slow30":
          return setTimeout(respond, 30000);
        case "chunks":
          return respondChunked();
        case "slowsearch": {
          // v65 S组：慢速分块下发（每块 400ms），验证真流式首字时间
          const full = url.pathname === "/zen/v1/responses"
            ? respSSE(body, entry.scenario, markOf(body))
            : chatSSE(body, entry.scenario, markOf(body));
          logReq(entry);
          res.writeHead(200, { "content-type": "text/event-stream" });
          const lines = full.split("\n\n");
          const parts = [];
          for (let i = 0; i < lines.length; i += 2) parts.push(lines.slice(i, i + 2).join("\n\n"));
          let i = 0;
          const tick = () => {
            if (i < parts.length) { res.write(parts[i] + "\n\n"); i++; setTimeout(tick, 400); }
            else res.end();
          };
          tick();
          return;
        }
        case "nonjson":
          return send(200, "text/plain", "this is not json, just plain text from mock");
        case "err400html":
          return send(400, "text/html", "<html><body><h1>400 Bad Request from mock gateway</h1></body></html>");
        case "emptyjson":
          return send(200, "application/json", "{}");
        case "redirect":
          logReq(entry);
          res.writeHead(302, { location: "https://opencode.ai/zen/v1/chat/completions-ok" });
          return res.end();
        default:
          return respond();
      }
    });
  }
);

server.listen(443, "127.0.0.1", () => {
  console.log("[mock] upstream listening on https://127.0.0.1:443 (as opencode.ai)");
});
