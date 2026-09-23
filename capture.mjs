// Manual session capture server.
// 1. Run: node capture.mjs          (waits on :18787)
// 2. In another terminal run opencode pointed at it:
//      mkdir -p /tmp/zencap && cat > /tmp/zencap/opencode.json <<'EOF'
//      {"$schema":"https://opencode.ai/config.json",
//       "provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:18787/zen/v1"}}}}
//      EOF
//      cd /tmp/zencap && OPENCODE_API_KEY=sk-... opencode run "say hi" \
//        --model opencode/mimo-v2.6-flash-free --standalone
// 3. capture.mjs saves session.json on the first request carrying
//    x-session-* headers, then exits.
import http from "http";
import fs from "fs";
import path from "path";

const DIR = import.meta.dirname;
const PORT = 18787;

const server = http.createServer((req, res) => {
  const h = req.headers;
  if (h["x-session-id"] || h["x-opencode-session"] || h["x-opencode-org-id"]) {
    const session = {
      userAgent: h["user-agent"] || "opencode/latest/2.0.12/cli",
      xOpencodeClient: h["x-opencode-client"] || "cli",
      xOpencodeOrgId: h["x-opencode-org-id"] || "",
      xOpencodeProject: h["x-opencode-project"] || "",
      xOpencodeSession: h["x-opencode-session"] || h["x-session-id"] || "",
      xSessionId: h["x-session-id"] || h["x-opencode-session"] || "",
      xSessionAffinity:
        h["x-session-affinity"] || h["x-session-id"] || h["x-opencode-session"] || "",
      capturedAt: new Date().toISOString(),
    };
    if (session.xSessionId) {
      fs.writeFileSync(
        path.join(DIR, "session.json"),
        JSON.stringify(session, null, 2)
      );
      console.log("Saved session.json");
      console.log(JSON.stringify(session, null, 2));
    }
  }
  req.resume();
  req.on("end", async () => {
    // Proxy everything to the real upstream so opencode works normally.
    try {
      const chunks = [];
      // body already drained; re-read not possible here because we resumed
      // without buffering. For capture purposes we forward headers only for
      // GETs and echo a minimal SSE for POSTs (opencode only needs headers).
      if (req.method === "GET") {
        const upstream = await fetch(`https://opencode.ai${req.url}`, {
          headers: { authorization: req.headers["authorization"] || "" },
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "content-type": "application/json" });
        return res.end(text);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"id":"cap","object":"chat.completion.chunk","created":1,"model":"cap","choices":[{"index":0,"finish_reason":"stop","delta":{"role":"assistant","content":"ok"}}]}\n\ndata: [DONE]\n'
      );
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Waiting for an OpenCode request on :${PORT} ...`);
  console.log("Point opencode at it via provider.opencode.options.baseURL,");
  console.log("then run any opencode command. session.json will be saved.");
});
