// Test-only preload for opencode-proxy: redirect opencode.ai -> 127.0.0.1
// (mock upstream). Does NOT modify proxy.mjs. Loaded via:
//   node --import file:///abs/path/redirect-dns.mjs proxy.mjs
// Only affects the proxy process; no /etc/hosts changes.
import dns from "node:dns";

const TARGET = "opencode.ai";
const isTarget = (h) => typeof h === "string" && h.toLowerCase() === TARGET;

// --- callback-style dns.lookup ---
const origLookup = dns.lookup.bind(dns);
dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (isTarget(hostname)) {
    const all = options && typeof options === "object" && options.all;
    process.nextTick(() => {
      if (all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    });
    return undefined;
  }
  return origLookup(hostname, options, callback);
};

// --- promises-style dns.promises.lookup ---
const dp = dns.promises;
const origPLookup = dp.lookup.bind(dp);
dp.lookup = async function (hostname, options) {
  if (isTarget(hostname)) {
    if (options && typeof options === "object" && options.all) {
      return [{ address: "127.0.0.1", family: 4 }];
    }
    return { address: "127.0.0.1", family: 4 };
  }
  return origPLookup(hostname, options);
};

console.error("[test-preload] opencode.ai -> 127.0.0.1 (mock upstream)");

// --- fetch URL rewrite ---
// Node 24 的 undici 用 named import 取 dns.lookup，上面补丁覆盖不到，
// 实测 fetch 会直连真实上游。这里直接重写 URL 做兜底：只改 opencode.ai，
// 其他域名（如 Exa、webfetch 目标）原样放行。测试专用，不碰 proxy.mjs。
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  try {
    let urlStr = null;
    if (typeof input === "string") urlStr = input;
    else if (input instanceof URL) urlStr = input.href;
    else if (input && typeof input.url === "string") urlStr = input.url;
    if (urlStr) {
      const u = new URL(urlStr);
      if (isTarget(u.hostname)) {
        u.hostname = "127.0.0.1";
        u.port = "443";
        if (typeof input === "string") input = u.href;
        else if (input instanceof URL) input = u;
        else input = new Request(u.href, input);
      }
    }
  } catch {}
  return origFetch.call(this, input, init);
};
