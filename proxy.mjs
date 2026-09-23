// OpenAI-compatible proxy for OpenCode Zen free models.
//
// Why this exists: Zen's free tier rejects requests with
//   {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
// unless the request carries OpenCode client identity (session headers)
// plus an agentic payload (6+ OpenCode tools).
//
// What the proxy does per request:
//   1. Adds User-Agent + x-opencode-* / x-session-* headers from session.json
//      (captured from a real `opencode run`; refresh with `npm run capture`).
//   2. Injects 6+ real OpenCode tool definitions when the client sent few/none,
//      and sets tool_choice:"none" in that case so the model answers directly
//      instead of emitting tool_calls the client never asked for.
//   3. Forwards to https://opencode.ai/zen/v1 and streams the response back.
//
// NOTE: no key needed for free models — like a fresh `opencode` install,
// the proxy defaults to the literal key "public". Set OPENCODE_API_KEY only
// if you also want paid Zen models through the same endpoint.
// Free models are rate-limited and may be withdrawn at any time; this proxy
// does not change that. If upstream returns FreeTierError the proxy reports
// it and you should re-run `npm run capture` to refresh the session identity.
//
// Endpoints (OpenAI-compatible, base http://127.0.0.1:8788/v1):
//   GET  /v1/models
//   POST /v1/chat/completions   (free chat models: *-free, big-pickle)
//   POST /v1/responses           (free responses models: muse-spark-*-free)
//   GET  /health
import http from "http";
import fs from "fs";
import path from "path";

const PORT = Number(process.env.PORT || 8788);
const UPSTREAM = "https://opencode.ai";
const DIR = import.meta.dirname;

const CHAT_TOOLS = JSON.parse(
  fs.readFileSync(path.join(DIR, "tools-chat.json"), "utf8")
);
const RESPONSES_TOOLS = JSON.parse(
  fs.readFileSync(path.join(DIR, "tools-responses.json"), "utf8")
);
const MIN_TOOLS = 6;

function getApiKey() {
  // Free ($0) models accept the literal key "public" — same as a fresh
  // `opencode` install with no key configured. A real Zen key is only
  // needed for paid models.
  return (
    process.env.OPENCODE_API_KEY ||
    process.env.OPENCODE_ZEN_API_KEY ||
    "public"
  );
}

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "session.json"), "utf8"));
  } catch {
    return null;
  }
}

function identityHeaders(session) {
  const h = {};
  if (!session) return h;
  h["user-agent"] = session.userAgent || "opencode/latest/2.0.12/cli";
  if (session.xOpencodeClient) h["x-opencode-client"] = session.xOpencodeClient;
  if (session.xOpencodeOrgId) h["x-opencode-org-id"] = session.xOpencodeOrgId;
  if (session.xOpencodeProject)
    h["x-opencode-project"] = session.xOpencodeProject;
  if (session.xOpencodeSession)
    h["x-opencode-session"] = session.xOpencodeSession;
  if (session.xSessionId) h["x-session-id"] = session.xSessionId;
  if (session.xSessionAffinity)
    h["x-session-affinity"] = session.xSessionAffinity;
  return h;
}

function ensureChatTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length < MIN_TOOLS) {
    body.tools = CHAT_TOOLS.slice(0, Math.max(MIN_TOOLS, tools.length));
    // Client didn't ask for tools; keep the model in text mode.
    if (tools.length === 0 && body.tool_choice === undefined) {
      body.tool_choice = "none";
    }
  }
  // Zen free tier only accepts streaming chat requests; the proxy
  // de-streams below when the client asked for non-streaming.
  body.stream = true;
  if (body.stream_options === undefined) {
    body.stream_options = { include_usage: true };
  }
  return { injected: tools.length < MIN_TOOLS };
}

function ensureResponsesTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length < MIN_TOOLS) {
    body.tools = RESPONSES_TOOLS.slice(0, Math.max(MIN_TOOLS, tools.length));
  }
  // Like chat, the free tier only answers streaming responses requests.
  body.stream = true;
  return { injected: tools.length < MIN_TOOLS };
}

// Assemble a non-streaming Responses object from SSE events.
// Text comes only from response.output_text.delta events; the final
// response.completed repeats the full output, so it must be ignored
// to avoid duplicating the text.
function sseToResponse(sseText, fallbackModel) {
  let id = `resp-proxy-${Date.now()}`;
  let model = fallbackModel;
  let text = "";
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const resp = obj.response || {};
    if (resp.id) id = resp.id;
    if (resp.model) model = resp.model;
    if (obj.model) model = obj.model;
    if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
      text += obj.delta;
    }
  }
  return {
    id,
    object: "response",
    status: "completed",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Assemble a non-streaming OpenAI chat.completion from SSE chunks.
function sseToChatCompletion(sseText, fallbackModel) {
  let content = "";
  let reasoning = "";
  let toolCalls = [];
  let id = `chatcmpl-proxy-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let finishReason = "stop";
  let usage = null;
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.id) id = obj.id;
    if (obj.created) created = obj.created;
    if (obj.model) model = obj.model;
    const choice = obj.choices?.[0];
    if (!choice) {
      if (obj.usage) usage = obj.usage;
      continue;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        toolCalls[idx] = toolCalls[idx] || {
          id: tc.id || "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string")
          toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (obj.usage) usage = obj.usage;
  }
  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://localhost");

    // Learn mode: real OpenCode pointed at this proxy (via
    // provider.opencode.options.baseURL) carries fresh identity headers.
    // Persist them so plain OpenAI clients can reuse them afterwards.
    const incomingSid =
      req.headers["x-session-id"] || req.headers["x-opencode-session"];
    if (incomingSid) {
      try {
        fs.writeFileSync(
          path.join(DIR, "session.json"),
          JSON.stringify(
            {
              userAgent:
                req.headers["user-agent"] || "opencode/latest/2.0.12/cli",
              xOpencodeClient: req.headers["x-opencode-client"] || "cli",
              xOpencodeOrgId: req.headers["x-opencode-org-id"] || "",
              xOpencodeProject: req.headers["x-opencode-project"] || "",
              xOpencodeSession:
                req.headers["x-opencode-session"] || incomingSid,
              xSessionId: incomingSid,
              xSessionAffinity:
                req.headers["x-session-affinity"] || incomingSid,
              capturedAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
      } catch {}
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, upstream: UPSTREAM + "/zen/v1" });
    }

    const apiKey = getApiKey();

    let upstreamPath = null;
    if (url.pathname === "/v1/models" || url.pathname === "/zen/v1/models") {
      upstreamPath = "/zen/v1/models";
    } else if (
      (url.pathname === "/v1/chat/completions" ||
        url.pathname === "/zen/v1/chat/completions") &&
      req.method === "POST"
    ) {
      upstreamPath = "/zen/v1/chat/completions";
    } else if (
      (url.pathname === "/v1/responses" ||
        url.pathname === "/zen/v1/responses") &&
      req.method === "POST"
    ) {
      upstreamPath = "/zen/v1/responses";
    } else {
      return sendJson(res, 404, { error: `Unknown route ${req.method} ${url.pathname}` });
    }

    const session = loadSession();
    if (upstreamPath !== "/zen/v1/models" && !session?.xSessionId) {
      return sendJson(res, 500, {
        error: "Missing session.json. Run: npm run capture (see README)",
      });
    }

    let body = null;
    let clientWantsStream = false;
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString());
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON body" });
      }
      if (upstreamPath === "/zen/v1/chat/completions") {
        clientWantsStream = body.stream === true;
        ensureChatTools(body);
      }
      if (upstreamPath === "/zen/v1/responses") {
        clientWantsStream = body.stream === true;
        ensureResponsesTools(body);
      }
    }

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      accept: "*/*",
      ...identityHeaders(session),
    };

    // Prefer fresh identity when the caller is real OpenCode; otherwise
    // fall back to the stored session. NOTE: every HTTP client sends its
    // own User-Agent (curl, python, ...), so only adopt the incoming UA
    // when it actually looks like OpenCode.
    const incomingUA = req.headers["user-agent"] || "";
    if (/opencode/i.test(incomingUA)) headers["user-agent"] = incomingUA;
    for (const k of [
      "x-opencode-client",
      "x-opencode-org-id",
      "x-opencode-project",
      "x-opencode-session",
      "x-session-id",
      "x-session-affinity",
      "b3",
      "traceparent",
    ]) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }

    try {
      if (process.env.PROXY_DEBUG) {
        console.error(
          "OUT headers=" +
            JSON.stringify({ ...headers, authorization: "Bearer REDACTED" }) +
            " bodyKeys=" +
            (body ? Object.keys(body).join(",") : "none") +
            " tools=" +
            (body?.tools?.length ?? 0) +
            " stream=" +
            body?.stream
        );
      }
      const upstream = await fetch(UPSTREAM + upstreamPath, {
        method: req.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        duplex: "half",
      });

      // Peek non-streaming errors (e.g. FreeTierError) to give a useful hint.
      const ctype = upstream.headers.get("content-type") || "";
      if (!ctype.includes("text/event-stream")) {
        const text = await upstream.text();
        if (text.includes("FreeTierError")) {
          console.error(
            "Upstream FreeTierError: session identity rejected. Re-run `npm run capture`."
          );
        }
        res.writeHead(upstream.status, { "content-type": "application/json" });
        return res.end(text);
      }

      if (
        upstreamPath === "/zen/v1/chat/completions" &&
        !clientWantsStream
      ) {
        // Buffer SSE, return a single chat.completion object.
        const bufs = [];
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bufs.push(Buffer.from(value));
        }
        const sseText = Buffer.concat(bufs).toString();
        if (sseText.includes("FreeTierError")) {
          console.error(
            "Upstream FreeTierError: session identity rejected. Re-run `npm run capture`."
          );
        }
        return sendJson(
          res,
          upstream.status,
          sseToChatCompletion(sseText, body?.model || "unknown")
        );
      }

      if (upstreamPath === "/zen/v1/responses" && !clientWantsStream) {
        const bufs = [];
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bufs.push(Buffer.from(value));
        }
        const sseText = Buffer.concat(bufs).toString();
        if (sseText.includes("FreeTierError")) {
          console.error(
            "Upstream FreeTierError: session identity rejected. Re-run `npm run capture`."
          );
        }
        return sendJson(
          res,
          upstream.status,
          sseToResponse(sseText, body?.model || "unknown")
        );
      }

      res.writeHead(upstream.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      console.error("Upstream fetch failed:", e);
      if (!res.headersSent) return sendJson(res, 502, { error: String(e) });
      try {
        res.end();
      } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`opencode-zen-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`OpenAI base URL: http://127.0.0.1:${PORT}/v1`);
  if (getApiKey() === "public") {
    console.log("No OPENCODE_API_KEY set — running keyless (free models only).");
  }
});
