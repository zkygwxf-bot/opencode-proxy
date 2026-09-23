# opencode-proxy

[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991)](https://platform.openai.com/docs/api-reference)
[![No deps](https://img.shields.io/badge/dependencies-zero-lightgrey)](#)

**Use OpenCode Zen's free models anywhere.** A tiny zero-dependency local
proxy that exposes Zen's free tier (`mimo`, `nemotron`, `ling`,
`big-pickle`, `muse-spark` free models) as a standard OpenAI-compatible API
— so any tool that speaks OpenAI works: SDKs, agents, chat UIs, IDE plugins.

```bash
export OPENCODE_API_KEY="sk-..."   # your own Zen key
node proxy.mjs                     # listening on http://127.0.0.1:8788
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="anything")
r = client.chat.completions.create(
    model="mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "Explain closures briefly"}],
)
print(r.choices[0].message.content)
```

## Why

Calling a Zen free model directly fails:

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode"}}
```

The free tier only answers requests that look like they come from the
OpenCode CLI: OpenCode session headers, streaming requests, and an agentic
payload with real OpenCode tool definitions. This proxy adds all of that
automatically, then translates the result back into the plain OpenAI shape
your client expects. You write normal OpenAI code; the proxy handles the
handshake.

## Features

- **OpenAI-compatible** — `/v1/models`, `/v1/chat/completions`,
  `/v1/responses` (for `muse-spark` free models), `/health`
- **Streaming + non-streaming** — free tier only answers streaming
  requests, so the proxy always streams upstream and re-assembles a normal
  JSON object when your client asked for `stream: false`
- **Tool injection** — adds 6+ genuine OpenCode tool definitions when your
  request has few/none, with `tool_choice: "none"` so the model answers in
  text instead of emitting `tool_calls` you never asked for. Your own tools
  pass through untouched when you supply them
- **Session learning** — point real OpenCode at the proxy once and it saves
  fresh identity headers automatically; no manual refresh step
- **Zero dependencies** — one `proxy.mjs`, Node 18+ stdlib only
- **Paid models too** — non-free Zen models proxy through unchanged

## Quickstart

Requirements: Node 18+, the `opencode` CLI, and **your own** Zen API key
([get one here](https://opencode.ai)).

```bash
git clone https://github.com/zkygwxf-bot-Varma/opencode-proxy.git
cd opencode-proxy
export OPENCODE_API_KEY="sk-..."   # or OPENCODE_ZEN_API_KEY

# 1. Capture a session identity (~30s). Terminal A:
node capture.mjs

#    Terminal B, same key exported:
mkdir -p /tmp/zencap && cat > /tmp/zencap/opencode.json <<'EOF'
{"$schema":"https://opencode.ai/config.json",
 "provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:18787/zen/v1"}}}}
EOF
cd /tmp/zencap && opencode run "say hi" \
  --model opencode/mimo-v2.6-flash-free --standalone
# capture.mjs saves session.json and exits.

# 2. Start the proxy:
node proxy.mjs   # or: PORT=8788 node proxy.mjs
```

`session.json` holds only session-affinity IDs (never your API key) and
expires after a while — if `FreeTierError` returns, repeat step 1.

**Shortcut:** set `provider.opencode.options.baseURL` to
`http://127.0.0.1:8788/zen/v1` in any OpenCode project and run one command.
The proxy learns the fresh identity from that traffic and updates
`session.json` by itself.

## Use it with anything

Base URL `http://127.0.0.1:8788/v1`. Any `api_key` value works — the real key
comes from the proxy's environment.

| Client | Config |
|---|---|
| cURL | `curl http://127.0.0.1:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Hi"}]}'` |
| Python SDK | `OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="x")` |
| Node SDK | `new OpenAI({ baseURL: "http://127.0.0.1:8788/v1", apiKey: "x" })` |
| Continue / Cline / Roo | Add an OpenAI-compatible provider pointing at `http://127.0.0.1:8788/v1` |
| LiteLLM | `model: openai/mimo-v2.6-flash-free, api_base: http://127.0.0.1:8788/v1` |
| Anything OpenAI-shaped | If it takes a base URL + model name, it works |

Responses API (for the `muse-spark` free models):

```bash
curl http://127.0.0.1:8788/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"muse-spark-1.3-contributor-free",
       "input":"Say hi in 5 words","store":false}'
```

## Free models (verified)

| Model ID | Endpoint | Notes |
|---|---|---|
| `mimo-v2.6-flash-free` | `/v1/chat/completions` | Fast default pick |
| `mimo-v2.5-free` | `/v1/chat/completions` | Previous generation |
| `nemotron-3-ultra-free` | `/v1/chat/completions` | Largest Nemotron 3 |
| `nemotron-3.5-lightning-free` | `/v1/chat/completions` | Low latency |
| `ling-3.0-flash-fin-free` | `/v1/chat/completions` | Finance-tuned flash |
| `big-pickle` | `/v1/chat/completions` | Stealth model |
| `muse-spark-1.3-contributor-free` | `/v1/responses` | Meta, multimodal |
| `muse-spark-1.2-contributor-free` | `/v1/responses` | Previous generation |
| `jev-1.13-free` | `/v1/chat/completions` | Listed as free |

Free-model IDs rotate (OpenCode marks them "limited time"), so check
`/v1/models` for the current set. Paid Zen models work through the same
endpoints with no special handling.

## How it works

```
your client  ── plain OpenAI request ──►  proxy  ── OpenCode-identified,
                                          streaming + tools ──►  Zen
```

Per request the proxy: attaches `User-Agent: opencode/...` plus
`x-opencode-*` / `x-session-*` headers from `session.json`; ensures
`stream: true` upstream (re-assembling SSE when you asked non-streaming);
and injects genuine OpenCode tool definitions when yours are missing.

## FAQ

**Is this affiliated with OpenCode?** No. Independent project, not built,
endorsed, or supported by the OpenCode team. Free-tier availability and
rules are theirs and can change anytime.

**Do I need my own key?** Yes. Bring your own Zen key via `OPENCODE_API_KEY`.
Never commit keys or `session.json`.

**It worked, now I get `FreeTierError`?** Your session identity expired —
repeat the 30-second capture step.

**Will the model call tools I didn't ask for?** No. When you send no tools
the proxy pins `tool_choice: "none"`, so you get plain text.

## License

MIT — see [LICENSE](LICENSE).
