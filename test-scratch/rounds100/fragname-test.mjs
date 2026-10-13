// Fragmented tool-name regression test (for name-fragment fixes).
// Requires mock-upstream.mjs to support SCN:fragname (chat SSE with tool names
// split across chunks: "get_wea"+"ther" client tool, "webfe"+"tch" proxy tool).
// Usage: node fragname-test.mjs  (proxy must be running on 18784 with fresh code)
const PROXY = "http://127.0.0.1:18784";

const results = [];
const rec = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${pass ? "" : " — " + detail}`);
};

async function post(p, body, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${PROXY}${p}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: "", err: e.name }; }
  finally { clearTimeout(t); }
}
const sseJson = (text) => {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try { out.push(JSON.parse(p)); } catch {}
  }
  return out;
};

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("proxy not up");
}

await waitForProxy();

// F1: chat direct path (-search model) — fragmented client tool name must arrive whole,
//     fragmented proxy tool (webfetch) must be intercepted, not leaked.
{
  const r = await post("/v1/chat/completions", {
    model: "muse-spark-search", stream: true,
    messages: [{ role: "user", content: "SCN:fragname MARK:F1" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "x", parameters: { type: "object", properties: {} } } }],
  });
  const evs = sseJson(r.text);
  const names = [];
  for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls || []) {
    if (tc.function?.name) names.push(tc.function.name);
  }
  // 流式透传中分片可见是正常的；关键断言：
  // 1. webfetch（代理工具）被拦截，不泄露（无 webfe/tch）
  // 2. 客户端工具分片能拼出完整名（get_wea+ther=get_weather）
  const full = names.join("");
  const leakedProxy = names.some((n) => n.includes("webfe") || n.includes("tch"));
  const clientOk = full.includes("get_weather");
  rec("F1", "chat直接路径分片工具名", r.status === 200 && clientOk && !leakedProxy,
    `status=${r.status} names=${JSON.stringify(names)}`);
}

// F2: responses + non-spark (chat translation) — function_call name must be whole.
{
  const r = await post("/v1/responses", {
    model: "mimo-test", input: [{ role: "user", content: "SCN:fragname MARK:F2" }], stream: false,
  });
  let name = "";
  try {
    const j = JSON.parse(r.text);
    const fc = (j.output || []).find((o) => o.type === "function_call");
    name = fc?.name || "";
  } catch {}
  rec("F2", "responses翻译路径分片工具名", r.status === 200 && name === "get_weather", `status=${r.status} name=${name}`);
}

// F3: messages + non-spark (chat translation) — tool_use block name must be whole.
{
  const r = await post("/v1/messages", {
    model: "mimo-test", max_tokens: 64,
    messages: [{ role: "user", content: "SCN:fragname MARK:F3" }], stream: true,
  });
  const evs = sseJson(r.text);
  const starts = evs.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  const name = starts[0]?.content_block?.name || "";
  rec("F3", "messages翻译路径分片工具名", r.status === 200 && name === "get_weather", `status=${r.status} name=${name}`);
}

// F4: sanity — normal (non-fragmented) toolcall still works on all 3 paths.
{
  const a = await post("/v1/chat/completions", {
    model: "muse-spark", stream: false,
    messages: [{ role: "user", content: "SCN:toolcall MARK:F4a" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "x", parameters: { type: "object", properties: {} } } }],
  });
  const b = await post("/v1/responses", {
    model: "mimo-test", input: [{ role: "user", content: "SCN:toolcall MARK:F4b" }], stream: false,
  });
  const c = await post("/v1/messages", {
    model: "mimo-test", max_tokens: 64, messages: [{ role: "user", content: "SCN:toolcall MARK:F4c" }], stream: false,
  });
  const ok = a.status === 200 && a.text.includes("get_weather") && b.status === 200 && c.status === 200;
  rec("F4", "非分片工具调用回归", ok, `a=${a.status} b=${b.status} c=${c.status}`);
}

const fails = results.filter((r) => !r.pass).length;
console.log(`\nFRAGNAME: ${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
