// Deep fuzz round: random mutation of valid payloads against the proxy.
// Usage: PORT=18784 node --import <abs>/test-scratch/redirect-dns.mjs proxy.mjs &
//        node deep-fuzz.mjs [seed] [iterations]
// PASS criteria: proxy responds within timeout (any HTTP status, incl. 4xx),
// never hangs, never returns 500 on structurally-valid input, process stays alive.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = "http://127.0.0.1:18784";
const seed = Number(process.argv[2] || Date.now() % 100000);
const ITER = Number(process.argv[3] || 200);

let s = seed;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const MUT = [
  "drop-field", "null-field", "wrong-type", "empty-string", "huge-string",
  "neg-number", "float-number", "dup-key", "extra-field", "truncate-array",
  "weird-model", "bad-role", "nested-garbage",
];

function baseChat() {
  return {
    model: "muse-spark",
    messages: [{ role: "user", content: "SCN:text hello" }],
    stream: false,
  };
}
function baseResp() {
  return { model: "muse-spark", input: [{ role: "user", content: "SCN:text hello" }], stream: false };
}
function baseMsg() {
  return { model: "muse-spark", max_tokens: 64, messages: [{ role: "user", content: "SCN:text hello" }] };
}

function mutate(obj, depth = 0) {
  const m = pick(MUT);
  const o = JSON.parse(JSON.stringify(obj));
  switch (m) {
    case "drop-field": { const ks = Object.keys(o); if (ks.length) delete o[pick(ks)]; break; }
    case "null-field": { const ks = Object.keys(o); if (ks.length) o[pick(ks)] = null; break; }
    case "wrong-type":
      { const ks = Object.keys(o); if (ks.length) { const k = pick(ks); o[k] = typeof o[k] === "string" ? 12345 : typeof o[k] === "number" ? "str" : [1, 2]; } break; }
    case "empty-string": { for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = ""; break; }
    case "huge-string": { o.messages ? (o.messages[0].content = "x".repeat(200000)) : (o.input = "y".repeat(200000)); break; }
    case "neg-number": o.max_tokens = -5; break;
    case "float-number": o.max_tokens = 3.7; o.temperature = 99.9; break;
    case "dup-key": break; // JSON can't dup; skip
    case "extra-field": o.__evil = { a: [1, { b: null }] }; o.debug = true; break;
    case "truncate-array": if (o.messages) o.messages = []; if (o.input && Array.isArray(o.input)) o.input = []; break;
    case "weird-model": o.model = pick(["", " ", "../x", "muse-spark-search", "-search", "MUSE-SPARK", "a".repeat(300), "null"]); break;
    case "bad-role": if (o.messages) o.messages[0].role = pick(["admin", "", null, 42]); break;
    case "nested-garbage": o.messages ? o.messages.push({ role: "user", content: [{ type: "weird", x: [null, {}] }] }) : null; break;
  }
  return { body: o, mutation: m };
}

async function waitForProxy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${PROXY}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("proxy not up");
}

async function one(path, body, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${PROXY}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    await r.text();
    return { status: r.status, timeout: false };
  } catch (e) {
    return { status: 0, timeout: e.name === "AbortError" };
  } finally { clearTimeout(t); }
}

const out = [];
let pass = 0, fail = 0, crash = 0;
await waitForProxy();
const paths = [["/v1/chat/completions", baseChat], ["/v1/responses", baseResp], ["/v1/messages", baseMsg]];
for (let i = 0; i < ITER; i++) {
  const [p, bf] = pick(paths);
  let { body, mutation } = mutate(bf());
  if (rnd() < 0.3) { const m2 = mutate(body); body = m2.body; mutation += "+" + m2.mutation; }
  const r = await one(p, body);
  // health check: is proxy still alive?
  let alive = true;
  try { const h = await fetch(`${PROXY}/health`); alive = h.ok; } catch { alive = false; }
  let ok = true, note = `st=${r.status}`;
  if (r.timeout) { ok = false; note = "TIMEOUT/HANG"; }
  else if (!alive) { ok = false; crash = 1; note = "PROXY DIED"; }
  else if (r.status === 500 && !["drop-field", "wrong-type"].includes(mutation.split("+")[0])) { ok = false; note = "500 on odd input"; }
  if (ok) pass++; else fail++;
  out.push({ i, path: p, mutation, pass: ok, detail: note });
  if (!alive) break;
}
fs.writeFileSync(path.join(DIR, "deep-fuzz-results.json"), JSON.stringify({ seed, iter: ITER, pass, fail, crash, out }, null, 1));
console.log(`DEEP-FUZZ seed=${seed} iter=${ITER}: PASS=${pass} FAIL=${fail} CRASH=${crash}`);
for (const o of out.filter((x) => !x.pass).slice(0, 20)) console.log(`  FAIL #${o.i} ${o.path} [${o.mutation}] ${o.detail}`);
