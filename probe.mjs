// probe.mjs — OpenCode Zen 免费层黑盒探针（v59 测试版配套）
// 用途：每天打一次上游免费层，确认我们的 session 格式/鉴权仍被放行。
// 逻辑：复用 proxy.mjs 的 freshSessionId 同款算法生成全新 session id，
// 带官方风格请求头 GET https://opencode.ai/zen/v1/models。
// 退出码：200 → 0；非 200 → 1（供 cron/告警脚本判断）。
// 注意：只做 1 次请求，不重试、不绕过限流；429/403 原样上报。

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function randB62(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += B62[(Math.random() * 62) | 0];
  return s;
}

let _counter = 0;
// 与 proxy.mjs mintedTimePrefix() 同款：~(unix_ms*0x1000+counter) 取低 48 位
function freshSessionId() {
  const counter = (++_counter) & 0xfff;
  const current = BigInt(Date.now()) * 0x1000n + BigInt(counter);
  const inverted = (~current) & 0xffffffffffffn;
  return "ses_" + inverted.toString(16).padStart(12, "0") + randB62(14);
}

const sid = freshSessionId();
const headers = {
  "user-agent": "opencode/latest/2.0.28/cli",
  "x-opencode-client": "cli",
  "x-opencode-session-id": sid,
  "x-opencode-session": sid,
  "x-session-affinity": sid,
  "X-Session-Id": sid,
};

const t0 = Date.now();
try {
  const res = await fetch("https://opencode.ai/zen/v1/models", { headers });
  const ms = Date.now() - t0;
  console.log(`[probe] ${new Date().toISOString()} status=${res.status} elapsed=${ms}ms sid=${sid.slice(0, 16)}...`);
  if (res.status === 200) {
    console.log("[probe] OK: 免费层放行");
    process.exit(0);
  } else {
    const body = await res.text().catch(() => "");
    console.log(`[probe] ALERT: 非 200，body 前 200 字符: ${body.slice(0, 200)}`);
    process.exit(1);
  }
} catch (e) {
  console.log(`[probe] ERROR: 请求失败: ${e.message}`);
  process.exit(2);
}
