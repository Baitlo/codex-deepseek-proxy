# codex-deepseek-proxy

[中文 README](./README.md)

A minimal local proxy that lets **Codex app / Codex CLI** call the official **DeepSeek API** through an OpenAI Responses-compatible local endpoint.

```text
Codex app / Codex CLI
        ↓ OpenAI Responses API
http://127.0.0.1:3456/v1/responses
        ↓ local protocol conversion
DeepSeek official API /chat/completions
```

## Features

- `POST /v1/responses` for Codex
- `GET /v1/models`
- `GET /health`
- Converts Responses `input` to Chat Completions `messages`
- Converts Responses-style tools to Chat Completions `tools`
- Supports streaming Responses SSE events
- Enables DeepSeek V4 thinking by default
- Supports `reasoning_effort=high/max`
- Attempts to preserve and replay DeepSeek `reasoning_content` for multi-turn tool calls
- Normalizes Chat Completions usage into Responses usage fields such as `input_tokens` and `output_tokens`

## Install

Requires Node.js 18+.

```bash
cd ~/Tools
git clone git@github.com:Baitlo/codex-deepseek-proxy.git
cd codex-deepseek-proxy
cp .env.example .env
chmod 600 .env
nano .env
npm start
```

## Configure `.env`

```env
DEEPSEEK_API_KEY=sk-your-real-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com

HOST=127.0.0.1
PORT=3456

DEFAULT_MODEL=deepseek-v4-pro
THINKING=enabled
REASONING_EFFORT=high

LOCAL_API_KEY=local-only
DEBUG=0
```

Do not commit your real API key. Do not add inline comments after `DEEPSEEK_API_KEY=...`.

## Test

```bash
curl http://127.0.0.1:3456/health
```

```bash
curl -N http://127.0.0.1:3456/v1/responses \
  -H "Authorization: Bearer local-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "Hello. Reply briefly.",
    "stream": true
  }'
```

## Codex config

`~/.codex/config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek_local"

model_reasoning_effort = "high"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[model_providers.deepseek_local]
name = "DeepSeek V4 Local Responses Proxy"
base_url = "http://127.0.0.1:3456/v1"
wire_api = "responses"
experimental_bearer_token = "local-only"
stream_idle_timeout_ms = 900000
request_max_retries = 2
stream_max_retries = 2
```

Use `deepseek-v4-flash` for cheaper/faster daily coding, and `deepseek-v4-pro` for heavier reasoning or repository-level tasks.

## Run in background

```bash
npm install -g pm2
cd ~/Tools/codex-deepseek-proxy
pm2 start npm --name codex-deepseek-proxy -- start
pm2 save
pm2 startup
```

## Related projects

This project is a small clean-room implementation for a narrow personal workflow. It was designed with reference to the behavior and compatibility problems discussed in related projects:

- [jazzenchen/VibeAround](https://github.com/jazzenchen/VibeAround)
- [jazzenchen/va-ai-api-proxy](https://github.com/jazzenchen/va-ai-api-proxy)
- [wang-h/chat2response](https://github.com/wang-h/chat2response)
- [labiium/routiium](https://github.com/labiium/routiium)
- [looplj/axonhub](https://github.com/looplj/axonhub)

## Disclaimer

This is not an official DeepSeek, OpenAI, or Codex project. Keep your API keys private. API compatibility may need updates when upstream APIs change.
