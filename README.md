# codex-deepseek-proxy

[English README](./README.en.md)

一个面向 **Codex app / Codex CLI** 的极简本地代理，用来让 Codex 通过 OpenAI Responses API 形式调用 **DeepSeek 官方 API**，并尽量保持 DeepSeek V4 的 thinking 能力。

> 适合场景：你不想使用功能较重的桌面代理工具，只想在本机启动一个小服务，让 Codex app 访问 `http://127.0.0.1:3456/v1/responses`，然后由本工具转发到 DeepSeek 官方 `/chat/completions`。

## 桌面版

仓库已新增 `desktop/` 目录，提供一个 Tauri/Rust 桌面应用原型：

- 输入 DeepSeek API Key。
- 选择 `deepseek-v4-pro` 或 `deepseek-v4-flash`。
- 启动/停止内置本地代理。
- 一键备份并编辑 `~/.codex/config.toml`。
- 提供 DMG 构建 workflow：`.github/workflows/build-desktop.yml`。

本地构建：

```bash
cd desktop
npm install
npm run build
```

构建产物通常位于：

```bash
desktop/src-tauri/target/release/bundle/dmg/
```

说明：当前桌面版是最小可运行原型，代理启动、模型选择、Codex 配置写入已经实现；开机启动按钮目前保留为占位提示，后续可继续接入 macOS Login Item 或 LaunchAgent。

## 功能特性

- 提供本地 OpenAI Responses 兼容端点：`POST /v1/responses`
- 提供模型列表端点：`GET /v1/models`
- 提供健康检查端点：`GET /health`
- 将 Codex 的 Responses `input` 转换为 Chat Completions `messages`
- 将 Responses 工具格式转换为 Chat Completions `tools` 格式
- 支持 streaming 响应，并输出 Codex 可解析的 Responses SSE 事件
- 默认开启 DeepSeek V4 thinking：`thinking: { type: "enabled" }`
- 支持 `reasoning_effort=high/max`
- 尝试保存并回放 DeepSeek 的 `reasoning_content`，用于缓解多轮工具调用时报错：`The reasoning_content in the thinking mode must be passed back to the API.`
- 规范化 usage 字段，避免 Codex 解析 `response.completed` 时缺少 `input_tokens`

## 工作链路

```text
Codex app / Codex CLI
        ↓ OpenAI Responses API
http://127.0.0.1:3456/v1/responses
        ↓ 本地格式转换
DeepSeek 官方 API /chat/completions
```

## 安装 CLI 版

要求 Node.js 18 或更高版本。

```bash
cd ~/Tools
git clone git@github.com:Baitlo/codex-deepseek-proxy.git
cd codex-deepseek-proxy
cp .env.example .env
chmod 600 .env
nano .env
npm start
```

如果你使用 HTTPS clone：

```bash
git clone https://github.com/Baitlo/codex-deepseek-proxy.git
```

## 配置 `.env`

最重要的是填写你的 DeepSeek 官方 API Key：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

完整示例：

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

注意：

- 不要把真实 API Key 提交到 GitHub。
- 不要在 `DEEPSEEK_API_KEY=...` 同一行后面追加中文注释或其他非 ASCII 字符。
- `.env` 已被 `.gitignore` 忽略。

## 启动 CLI 版

```bash
npm start
```

健康检查：

```bash
curl http://127.0.0.1:3456/health
```

正常情况下会返回类似：

```json
{"ok":true,"provider":"deepseek","thinking":"enabled"}
```

## 测试 Responses 流式调用

```bash
curl -N http://127.0.0.1:3456/v1/responses \
  -H "Authorization: Bearer local-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "你好，简短回答。",
    "stream": true
  }'
```

## Codex 配置

编辑：

```bash
nano ~/.codex/config.toml
```

推荐配置：

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

日常编码可以改用：

```toml
model = "deepseek-v4-flash"
```

复杂推理、长链路 debug、代码库级重构可以使用：

```toml
model = "deepseek-v4-pro"
```

## 后台运行 CLI 版

推荐使用 `pm2`：

```bash
npm install -g pm2
cd ~/Tools/codex-deepseek-proxy
pm2 start npm --name codex-deepseek-proxy -- start
pm2 save
pm2 startup
```

查看日志：

```bash
pm2 logs codex-deepseek-proxy
```

重启：

```bash
pm2 restart codex-deepseek-proxy
```

停止：

```bash
pm2 stop codex-deepseek-proxy
```

## 常见问题

### 1. `Cannot convert argument to a ByteString...`

通常是 `.env` 里的 `DEEPSEEK_API_KEY` 仍然是占位符，例如：

```env
DEEPSEEK_API_KEY=sk-你的DeepSeek官方APIKey
```

请替换成真实 API Key，并确保同一行没有中文注释。

### 2. `tools[0]: missing field function`

这是 Responses 工具格式没有转换成 Chat Completions 工具格式导致的。本仓库已处理：

```json
{"type":"function","name":"...","parameters":{}}
```

会被转换为：

```json
{"type":"function","function":{"name":"...","parameters":{}}}
```

### 3. `ResponseCompleted: missing field input_tokens`

这是 Codex 解析 Responses `usage` 时需要 `input_tokens` 字段。本仓库会把 Chat Completions 的 `prompt_tokens / completion_tokens` 规范化为 Responses 的 `input_tokens / output_tokens`。

### 4. `reasoning_content must be passed back`

DeepSeek V4 thinking 模式下，多轮工具调用需要回传上一轮的 `reasoning_content`。本工具会尽量在本地保存并回放该字段。不过由于不同 Codex app / CLI 版本对 Responses 历史的回放方式可能不同，这部分仍属于兼容性逻辑。

如果你更重视稳定性，可以在 `.env` 中关闭 thinking：

```env
THINKING=disabled
```

## 与其他项目的关系 / 参考项目

本项目是一个面向个人使用场景的极简实现，代码为重新编写，不是以下项目的拷贝。设计上参考或对照过这些类似项目：

- [jazzenchen/VibeAround](https://github.com/jazzenchen/VibeAround)：桌面端 AI API 路由工具，支持 Codex、DeepSeek provider、Responses/Chat/Anthropic 多协议转换，并关注 DeepSeek thinking 的 `reasoning_content` replay。
- [jazzenchen/va-ai-api-proxy](https://github.com/jazzenchen/va-ai-api-proxy)：VibeAround 相关的协议转换库，提供 OpenAI Responses、OpenAI Chat、Anthropic Messages 之间的 translator 思路。
- [wang-h/chat2response](https://github.com/wang-h/chat2response)：面向 Codex 0.118+ 的 Responses API 到 Chat Completions 转换代理。
- [labiium/routiium](https://github.com/labiium/routiium)：OpenAI-compatible API gateway，支持 `/v1/responses`、`/v1/chat/completions` 等接口转换。
- [looplj/axonhub](https://github.com/looplj/axonhub)：AI gateway，包含 DeepSeek reasoning content 相关兼容处理。

## 免责声明

- 本工具不是 DeepSeek、OpenAI 或 Codex 官方项目。
- 请自行保管 API Key，不要将 `.env` 提交到公开仓库。
- DeepSeek、Codex、Responses API 的协议细节可能变化，如果后续出现解析报错，需要根据实际返回继续适配。

## License

本项目使用 **GNU General Public License v3.0**。详见 [LICENSE](./LICENSE)。
