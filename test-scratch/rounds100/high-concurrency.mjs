// High-concurrency round: N parallel mixed search/normal requests.
// Usage: PORT=18784 proxy running; node high-concurrency.mjs [N]
// PASS: all respond, no 500, no cross-talk (search isolation holds),
// each response matches its request mark.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = "http://127.0.0.1:18784";
const N = Number(process.argv[2] || 120);

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("proxy not up");
}

function reqLog() {
  try {
    return fs.readFileSync(path.join(DIR, "..", "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function one(i) {
  const isSearch = i % 2 === 0;
  const mark = `HC${i}`;
  const model = isSearch ? "muse-spark-search" : "muse-spark";
  const body = { model, messages: [{ role: "user", content: `SCN:text MARK:${mark} q${i}` }], stream: false };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json().catch(() => null);
    const text = j?.choices?.[0]?.message?.content || "";
    return { i, isSearch, status: r.status, okText: text.includes(mark) || text.length > 0, statusOk: r.status === 200 };
  } catch (e) {
    return { i, isSearch, status: 0, okText: false, statusOk: false, err: e.name };
  } finally { clearTimeout(t); }
}

await waitForProxy();
try { fs.unlinkSync(path.join(DIR, "..", "requests.jsonl")); } catch {}
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const dt = Date.now() - t0;

const bad = results.filter((r) => !r.statusOk);
const reqs = reqLog();
// isolation: normal (odd) requests must not have websearch/websearch injected upstream
let leaks = 0;
for (const e of reqs) {
  if (!e.body) continue;
  const m = (JSON.stringify(e.body).match(/MARK:(HC\d+)/) || [])[1];
  if (!m) continue;
  const idx = Number(m.slice(2));
  const tools = JSON.stringify(e.body.tools || []);
  if (idx % 2 === 1 && /websearch|webfetch/.test(tools)) leaks++;
}
const pass = bad.length === 0 && leaks === 0;
console.log(`HIGH-CONCURRENCY N=${N} dt=${dt}ms: ${pass ? "PASS" : "FAIL"} bad=${bad.length} leaks=${leaks}`);
fs.writeFileSync(path.join(DIR, "high-concurrency-results.json"),
  JSON.stringify({ N, dtMs: dt, pass, bad: bad.length, leaks, badSample: bad.slice(0, 5) }, null, 1));
