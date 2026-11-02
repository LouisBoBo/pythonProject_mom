# `/v1/chat/completions` 对接实例（按桌面端真实协议整理）

> 这份文档是 [2026-11-01-mom-server-integration-api.md](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/docs/superpowers/plans/2026-11-01-mom-server-integration-api.md) 第 2.2 节的补充：给出**客户端实际会发出的请求**和**网关必须返回的响应**的完整实例。
>
> 请求体不是手写的，是用桌面端同款协议实现（`@earendil-works/pi-ai` 1.1.0，`openai-completions`）实际生成并抓取的；工具定义取自桌面端真实注册的工具；响应示例也用该协议实现跑过解析，确认能还原出 `thinking` 和完整的 `tool_calls`。

---

## 先讲清楚链路：这些参数是谁、在什么时候产生的

先消除一个容易产生的误解：**下面的 `tools`、`system`、`messages` 不是服务端提前准备好的，也不是我事先“知道”用户会问什么。**

这条链路上只有三个角色：

1. **桌面端客户端**（Electron + Agent 运行时）——真正组装请求的一方。用户点发送的那一刻，它在本地把四样东西拼成一个 JSON：
   - `system`：内置的系统提示词；
   - `messages`：这次会话到目前为止的完整历史（用户消息、模型回复、工具结果）；
   - `tools`：当前可用的工具清单（`grep`、`read`、`edit`、`write`、`bash`……），由客户端注册的工具生成；
   - `model`：模型别名 `standard` / `deep`。
2. **公司网关**（你的服务端）——只做四件事：鉴权、alias 映射、注入厂商 Key、原样转发。它不组装 messages，不定义工具，也不跑模型。
3. **上游模型厂商**（DeepSeek）——真正做推理的一方。

时序是这样的：

```text
用户输入
  → 客户端组装请求（system + 历史 + tools + alias）
  → POST /v1/chat/completions 到网关
  → 网关换 model、换 Authorization、原样转发
  → 上游模型流式返回
  → 客户端边收边渲染；模型要调工具时，客户端在本地执行
  → 客户端把“工具调用 + 工具结果”追加进历史，再发第二轮
  → …直到模型给出最终回答
```

所以：

- **服务端不需要预先知道有哪些工具。** 它第一次看到工具清单，就是请求到达的时候；看到什么就转发什么。
- **模型本身是无状态的。** 它之所以“记得”上一轮，是因为客户端每轮都把完整历史重新发了一遍。
- **“不在服务器调用 LLM”指的是服务器不跑模型**，不是说客户端不经过服务器。示例里的 `POST /v1/chat/completions` 就是客户端发给网关的请求，网关再转给 DeepSeek。

关于示例取材，避免误解：

| 部分 | 来源 | 说明 |
|------|------|------|
| 请求字段结构（`stream_options`、`max_completion_tokens`、`content` 数组、`tool_calls` 形状） | 用项目同款协议库 pi-ai 1.1.0 实际生成/抓取 | 与真实客户端发出的结构一致 |
| 工具定义（`grep`） | 取自桌面端真实注册的工具 | 名称、参数、描述都是项目里的原文 |
| 对话内容、响应内容 | 示意 | 真实运行时由用户输入和上游模型决定 |

换句话说：**示例的“格式”是真的，“剧情”是演示用的。**

---

## 零、先看结论

服务端同事实现 `/v1/chat/completions` 时，只要守住下面 8 条，Cursor 生成代码的常见问题都能避开：

1. `model` 里是 **alias**（`standard` / `deep`），不是厂商真实模型名。
2. **请求体的字段一律原样转发**，不要按自己的模型去反序列化再重新拼；客户端会发 `tools`、`stream_options`、`store`、`max_completion_tokens` 等你文档里没列的字段。
3. `messages[].content` 可能是**数组**（`[{"type":"text","text":"..."}]`），也可能是字符串或 `null`；不要假设一定是字符串。
4. 客户端**永远发 `stream: true`**；流式响应必须是 `text/event-stream`，**逐块 flush，不能先聚合再一次性返回**。
5. `tool_calls` 在响应里是**分片**的：第一片带 `index/id/type/name`，后续片只带 `index/arguments` 片段；**不要累加后重组成一整条再发**。
6. `reasoning_content`（深度思考内容）必须原样透传，不能丢。
7. 上游错误必须在**开始推流之前**用 HTTP 状态码返回；一旦返回了 `200 text/event-stream`，就无法再改状态码。
8. 厂商的 401（例如上游 Key 失效）**不能原样返回 401**，要映射成 502；否则客户端会误判为“用户登录过期”并踢用户下线。

---

## 一、请求实例 1：首轮对话（带工具定义）

### 1.1 请求行与请求头

```http
POST /v1/chat/completions HTTP/1.1
Host: 175.178.238.31:8443
Authorization: Bearer <登录接口返回的 token>
Content-Type: application/json
Accept: application/json
```

> 注意两点：
> - `Accept` 是 `application/json`（OpenAI SDK 默认值），**不代表客户端不要流**。是否流式只看 body 里的 `"stream": true`，服务端不要根据 `Accept` 决定返回 JSON。
> - 客户端还会带 `user-agent: pi (...)`、`x-stainless-*` 等头，全部可以忽略。

### 1.2 请求体（完整）

```json
{
  "model": "standard",
  "messages": [
    {
      "role": "system",
      "content": "你是江西中软工作助手，回答简洁准确。"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "帮我找一下模型网关的默认地址配置在哪个文件。"
        }
      ]
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "store": false,
  "max_completion_tokens": 8192,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "grep",
        "description": "Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns up to 250 matches; a larger result reports where the complete match list was saved.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Regular expression to search for (ripgrep syntax)."
            },
            "path": {
              "type": "string",
              "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
            },
            "include": {
              "type": "string",
              "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
            }
          },
          "required": [
            "pattern"
          ]
        }
      }
    }
  ]
}
```

> 真实的请求里，`system` 提示词和工具数量都远比这里多（工具清单通常有十几个），这里为了可读性只保留了最小集合。示例里的 `system` 文案只是占位，真实内容由客户端内置提示词和插件段落拼成，网关**不要解析或改写它**。除内容之外，**字段结构完全一致**。

### 1.3 网关应该怎么处理这个 body

| 字段 | 客户端实际值 | 网关处理 |
|------|--------------|----------|
| `model` | `standard` | 查 alias 映射表，例如 `standard → deepseek-chat`，替换成真实模型名 |
| `messages` | 数组，item 里 `content` 可能是字符串/数组/`null` | **原样转发**；不要统一改写成字符串 |
| `stream` | 永远是 `true` | 按流式处理 |
| `stream_options` | `{"include_usage": true}` | **保留**；上游不支持时再自行补一个 usage 事件（见第三节） |
| `store` | `false` | OpenAI 专有字段；DeepSeek 不认时可以丢弃 |
| `max_completion_tokens` | `8192` | DeepSeek 上游只认 `max_tokens`，建议改名为 `max_tokens` 再转发（见下方代码） |
| `tools` | OpenAI function 工具定义 | **原样转发**，不要裁剪 |
| `temperature`、`top_p` 等 | 有就带 | 原样转发 |
| `tool_choice` | 有就带 | 原样转发 |

替换成上游请求时，建议做这几件事：

```
alias 映射          standard → deepseek-chat / deep → deepseek-reasoner
max_completion_tokens → max_tokens    （DeepSeek 兼容）
删掉 store、prompt_cache_key 等 OpenAI 专有字段（没有就跳过）
强制 stream_options.include_usage = true
Authorization 换成厂商 Key
加一个 x-request-id 便于排查
```

**不要**动 `messages`、`tools`、`tool_choice`、`temperature`。

---

## 二、请求实例 2：工具结果回传（第二轮）

客户端拿到工具调用结果后，会把“上一轮带 `tool_calls` 的 assistant 消息 + `role: "tool"` 的结果 + 新的用户消息”一起发回来。这是 Agent 场景最常见的第二轮请求。

```json
{
  "model": "standard",
  "messages": [
    {
      "role": "system",
      "content": "你是江西中软工作助手，回答简洁准确。"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "帮我找一下模型网关的默认地址配置在哪个文件。"
        }
      ]
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_00_abc",
          "type": "function",
          "function": {
            "name": "grep",
            "arguments": "{\"pattern\":\"DEFAULT_GATEWAY_BASE_URL\",\"include\":\"*.ts\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "content": "Found 1 match\n\ndesktop/shell/apps/desktop/src/model-gateway.ts\nLine 18: export const DEFAULT_GATEWAY_BASE_URL = 'https://175.178.238.31:8443'",
      "tool_call_id": "call_00_abc"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "把那一行的内容贴出来。"
        }
      ]
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "store": false,
  "max_completion_tokens": 8192,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "grep",
        "description": "Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns up to 250 matches; a larger result reports where the complete match list was saved.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Regular expression to search for (ripgrep syntax)."
            },
            "path": {
              "type": "string",
              "description": "File or directory to search. Defaults to the session workspace; a relative path resolves against it."
            },
            "include": {
              "type": "string",
              "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
            }
          },
          "required": [
            "pattern"
          ]
        }
      }
    }
  ]
}
```

第二轮有三个容易写错的点：

1. `assistant.content` 可以是 `null`，工具调用放在 `tool_calls` 里。
2. `tool_calls[].function.arguments` 是**字符串**（JSON 序列化后的文本），不是对象。
3. 工具结果消息是 `role: "tool"`，并且必须带 `tool_call_id` 指回调用 id；顺序必须是 `assistant(tool_calls) → tool → 下一条 user`，不能打乱。

---

## 三、流式响应实例（对应请求 1）

### 3.1 响应头

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
x-request-id: 6f1c0f2a9d8e4b7c9a1d2e3f4a5b6c7d
```

- 不要带 `Content-Length`，让传输层用 chunked。
- 如果前面有 nginx，`X-Accel-Buffering: no` 必须加，否则 nginx 会缓冲，客户端看起来像“卡住很久然后一次性出结果”。

### 3.2 完整的 SSE 响应体

下面 8 个事件依次发出（每个事件之间是一个空行）：

```text
data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"用户想定位模型网关默认地址，"},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":"先在桌面端源码里搜常量名。"},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_00_abc","type":"function","function":{"name":"grep","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pattern\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"DEFAULT_GATEWAY_BASE_URL\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"chatcmpl-mom-1","object":"chat.completion.chunk","created":1762041600,"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":1520,"completion_tokens":38,"total_tokens":1558}}

data: [DONE]

```

### 3.3 逐个事件解释

| # | 内容 | 作用 |
|---|------|------|
| 1 | `delta.role` + 第一段 `reasoning_content` | 告诉客户端这一轮是 assistant；`reasoning_content` 是“深度思考”内容，界面上折叠展示 |
| 2 | 后续 `reasoning_content` | 思考内容继续追加 |
| 3 | `tool_calls` 第一片：`index/id/type/name`，`arguments` 为空串 | 客户端据此创建工具调用占位 |
| 4 | `arguments` 片段 `{"pattern":` | 参数按字符串分片到达 |
| 5 | `arguments` 片段 `"DEFAULT_GATEWAY_BASE_URL"}` | 参数拼完；客户端拼起来后解析为 `{"pattern":"DEFAULT_GATEWAY_BASE_URL"}` |
| 6 | `delta: {}` + `finish_reason: "tool_calls"` | 表示本轮以工具调用结束 |
| 7 | `choices: []` + `usage` | token 用量；客户端靠这一条做统计 |
| 8 | `data: [DONE]` | 流结束标记，必须发 |

### 3.4 关键约束

- 每个事件以 `data: ` 开头，以**两个换行**（`\n\n`）结束；不要少了空行。
- `id`、`created`、`model` 在同一个响应的所有 chunk 里保持一致。
- `tool_calls` 的 `index` 从 0 开始；同一轮有多个工具调用时，**每个 index 各自分片**。`id` 和 `name` 只在每个 index 的第一片出现。
- `finish_reason` 只出现一次，取值是 `stop` / `tool_calls` / `length`。
- `usage` 事件里的 `choices` 是空数组 `[]`，这是 OpenAI 规范；不要顺手填一条假 choice。
- `[DONE]` 是纯文本，不是 JSON；不要写成 `data: {"done":true}`。

---

## 四、流式响应实例（对应请求 2，最终回答）

工具执行完后，模型输出最终文本。响应结构相同，只是没有 `tool_calls`：

```text
data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"默认地址在 "},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"`desktop/shell/apps/desktop/src/model-gateway.ts` "},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"第 18 行：\n\n```ts\nexport const DEFAULT_GATEWAY_BASE_URL = 'https://175.178.238.31:8443'\n```"},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"\n\n未设置 `ZR_MODEL_GATEWAY_URL` 时，客户端就回退到这个地址。"},"finish_reason":null}]}

data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-mom-2","object":"chat.completion.chunk","created":1762041604,"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":1638,"completion_tokens":96,"total_tokens":1734}}

data: [DONE]

```

> 这里为了可读性把回答拆成了 4 个 `content` 片段；真实上游怎么拆就怎么透传，**片段边界不影响客户端**，客户端会按顺序拼接。但**字段不能被改写**（例如不能把 `content` 拼成一条再发，也不能丢掉 `usage`）。

---

## 五、非流式响应（只用于 curl 自测）

客户端正式请求永远是 `stream: true`，但服务端最好也支持 `stream: false`，方便你用 curl / Postman 排查。请求：

```json
{
  "model": "standard",
  "messages": [
    { "role": "user", "content": "只回复 OK" }
  ],
  "stream": false
}
```

响应 `200 application/json`：

```json
{
  "id": "chatcmpl-mom-3",
  "object": "chat.completion",
  "created": 1762041608,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "OK"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 7,
    "completion_tokens": 2,
    "total_tokens": 9
  }
}
```

带工具调用时，非流式的 `message` 结构是：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_00_abc",
      "type": "function",
      "function": {
        "name": "grep",
        "arguments": "{\"pattern\":\"DEFAULT_GATEWAY_BASE_URL\",\"include\":\"*.ts\"}"
      }
    }
  ]
}
```

---

## 六、错误响应

### 6.1 格式

所有非 2xx 响应都用 JSON（不要用 SSE）：

```json
{
  "error": {
    "code": "model_not_allowed",
    "message": "模型不在授权范围",
    "type": "permission_error"
  }
}
```

`code` 用稳定英文枚举，`message` 给用户看。建议同时返回 `x-request-id`。

### 6.2 状态码映射

| 状态码 | 场景 | 客户端行为 | `code` 示例 |
|--------|------|------------|-------------|
| 401 | token 无效/过期 | 清会话，弹登录卡 | `session_expired` |
| 403 | alias 不在该用户授权范围 | 提示无权限 | `model_not_allowed` |
| 429 | 用户或全局限流 | 提示稍后重试 | `rate_limited` |
| 400 | 请求体不合法 | 提示请求错误 | `invalid_body` |
| 502 | 上游不可达 / 上游 5xx / **上游 401** | 提示模型服务异常 | `upstream_unavailable` |

**重点：上游厂商返回 401（Key 失效）时必须映射为 502。** 如果原样回 401，客户端会认为用户登录过期并把用户踢下线。

### 6.3 流已经开始后出错怎么办

一旦已经返回 `200 text/event-stream` 并开始推 chunk，就**不能再改状态码**。此时只能：

- 直接结束连接（客户端会显示“响应中断/模型服务异常”）；
- 或者按 OpenAI 约定发一个错误事件（部分客户端支持）：

```text
data: {"error":{"code":"upstream_error","message":"模型服务中断"}}

data: [DONE]

```

不要把错误 JSON 当成普通 chunk 混在正常内容里。

---

## 七、参考实现（FastAPI + httpx）

这段代码只做“鉴权 → alias 映射 → 字段兼容 → 注入 Key → 原样透传 SSE”，和现网网关的行为一致：

```python
import json
import uuid

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

UPSTREAM = "https://api.deepseek.com/v1"
UPSTREAM_KEY = "sk-..."                      # 只放服务端
ALIASES = {"standard": "deepseek-chat", "deep": "deepseek-reasoner"}

app = FastAPI()
client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))


def error(status: int, code: str, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        headers={"x-request-id": request_id},
        content={"error": {"code": code, "message": message, "type": "api_error"}},
    )


@app.post("/v1/chat/completions")
async def chat(request: Request):
    request_id = uuid.uuid4().hex

    # 1. 鉴权：换成你自己的会话校验
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    user = verify_session(token)
    if user is None:
        return error(401, "session_expired", "登录已过期，请重新登录", request_id)

    # 2. 读原始 body，不要反序列化成固定模型
    try:
        body = await request.json()
    except Exception:
        return error(400, "invalid_body", "请求体不是合法 JSON", request_id)
    if not isinstance(body, dict):
        return error(400, "invalid_body", "请求体必须是对象", request_id)

    # 3. alias → 真实模型
    alias = body.get("model")
    real = ALIASES.get(alias) if isinstance(alias, str) else None
    if real is None:
        return error(403, "model_not_allowed", "模型不在授权范围", request_id)

    # 4. 字段兼容：客户端的 max_completion_tokens 改成 DeepSeek 认的 max_tokens
    payload = {**body, "model": real}
    if "max_completion_tokens" in payload:
        payload["max_tokens"] = payload.pop("max_completion_tokens")
    payload.pop("store", None)
    if payload.get("stream"):
        options = payload.get("stream_options")
        payload["stream_options"] = {
            **(options if isinstance(options, dict) else {}),
            "include_usage": True,
        }

    # 5. 转发
    upstream_request = client.build_request(
        "POST",
        f"{UPSTREAM}/chat/completions",
        json=payload,
        headers={
            "Authorization": f"Bearer {UPSTREAM_KEY}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
            "Accept-Encoding": "identity",   # 保证 aiter_raw() 拿到的是明文 SSE
            "x-request-id": request_id,
        },
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError:
        return error(502, "upstream_unavailable", "模型服务暂不可用，请稍后重试", request_id)

    # 6. 上游错误必须在推流前返回；厂商 401 不能透传成 401
    if upstream.status_code >= 400:
        await upstream.aread()
        await upstream.aclose()
        if upstream.status_code in (401, 403):
            return error(502, "upstream_unavailable", "模型服务配置异常，请联系管理员", request_id)
        if upstream.status_code == 429:
            return error(429, "rate_limited", "请求过于频繁，请稍后重试", request_id)
        return error(502, "upstream_error", "模型服务返回错误", request_id)

    # 7. 非流式：直接透传 JSON
    if not payload.get("stream"):
        raw = await upstream.aread()
        await upstream.aclose()
        return JSONResponse(content=json.loads(raw), headers={"x-request-id": request_id})

    # 8. 流式：逐块透传，不解析、不重组
    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "x-request-id": request_id,
        },
    )
```

> 如果要**在网关侧统计用量**：在 `relay()` 里把每个 chunk 追加到一个缓冲区，按行找 `data: ` 后 JSON 解析，遇到 `usage` 字段就记下来，流结束后落库。**透传给客户端的字节不要因此改变**。现网网关就是这么做的，并且用 `x-request-id` 做同一次调用的幂等键。

---

## 八、上线前自测

### 8.1 非流式（最快确认链路通）

```bash
TOKEN='<登录拿到的 token>'
curl -sS https://175.178.238.31:8443/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "standard",
    "messages": [{"role": "user", "content": "只回复 OK"}],
    "stream": false
  }'
```

预期：`200`，JSON 里有 `choices[0].message.content == "OK"` 和 `usage`。

### 8.2 流式（确认是逐块返回，不是憋到最后）

```bash
TOKEN='<登录拿到的 token>'
curl -N https://175.178.238.31:8443/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "model": "standard",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "从 1 数到 20，每个数字单独一行"}]}],
    "stream": true,
    "stream_options": {"include_usage": true},
    "store": false,
    "max_completion_tokens": 1024
  }'
```

预期：

- 终端里内容**陆续出现**，不是停几秒后整段出现；
- 能看到多条 `data: {...}`；
- 最后一条 `data: [DONE]`；
- `usage` 事件在 `[DONE]` 之前。

### 8.3 自带工具调用（确认分片没被重组坏）

用 8.2 的 curl，但把 `tools` 换成文档第 1.2 节里的 `grep`，用户消息改成“帮我找一下模型网关的默认地址配置在哪个文件，用 grep 工具”。预期返回里出现 `tool_calls` 分片、`finish_reason: "tool_calls"`，客户端（或你的解析脚本）能拼出 `{"pattern":"DEFAULT_GATEWAY_BASE_URL"}`。

### 8.4 验收清单

- [ ] 首轮带 `tools` 的请求能正常返回工具调用
- [ ] 第二轮带 `role: "tool"` 的请求能继续回答
- [ ] `reasoning_content` 出现在 `deep` 模型响应里且没有被丢弃
- [ ] `usage` 事件存在，数字能落库
- [ ] `401 / 403 / 429 / 502` 按第六节映射
- [ ] 上游 401 没有透传成客户端 401
- [ ] nginx 没缓冲（内容逐块出现）
- [ ] `[DONE]` 之后没有多余字节

---

## 九、Cursor 生成代码最容易犯的错（对照检查）

| 错误写法 | 后果 | 正确做法 |
|----------|------|----------|
| `resp = requests.post(..., json=body)` 然后 `return resp.json()` | 客户端要的是 SSE，收到 JSON 直接报错 | 用流式客户端（httpx `stream=True` / requests `stream=True`） |
| 把整个 SSE 读完再 `yield` | 界面长时间无输出，像卡死 | 收到一块 yield 一块 |
| 自己 `json.loads` 每个 chunk 再 `json.dumps` | 丢掉 `reasoning_content`、`tool_calls` 分片、未知字段 | 原样转发字节 |
| 把 `tool_calls` 累加成完整一条再发 | 部分客户端解析不到工具调用 | 按上游分片透传 |
| 不返回 `usage` chunk | 网关侧/客户端侧都无法统计 token | 保留 `stream_options.include_usage`，并透传 usage 事件 |
| 把 `messages[].content` 强制转成字符串 | 多模态/多段文本结构被破坏 | 原样转发 |
| 把 `max_completion_tokens` 原样发给 DeepSeek | 输出长度可能不受限 | 转成 `max_tokens` |
| 忘了发 `[DONE]` | 客户端一直等，直到超时 | 最后补 `data: [DONE]\n\n` |
| 流开始后返回 JSON 错误 | 客户端收到非法 chunk | 流开始前返回 HTTP 错误；流中直接断开 |
| 上游 401 原样返回 | 用户被误踢下线 | 映射成 502 |
| 网关开了 gzip / nginx 缓冲 | SSE 不实时 | `Accept-Encoding: identity`、`X-Accel-Buffering: no`、`proxy_buffering off` |
| 用 `Accept` 判断是否流式 | 客户端 `Accept` 是 JSON，被误判成非流式 | 只看 body 的 `stream` 字段 |

---

## 附：字段对照速查

| 客户端发来的字段 | 类型 | 服务端要不要动 |
|------------------|------|----------------|
| `model` | string | 必须：alias → 真实模型名 |
| `messages` | array | 不动 |
| `messages[].content` | string / array / null | 不动 |
| `stream` | bool | 不动（恒为 true） |
| `stream_options.include_usage` | bool | 保留/强制 true |
| `max_completion_tokens` | int | 建议改名为 `max_tokens` |
| `store` | bool | 建议丢弃 |
| `tools` | array | 不动 |
| `tool_choice` | string/object | 不动 |
| `temperature` / `top_p` | number | 不动 |
| `tool_calls[].function.arguments` | string | 不动（响应里分片到达） |
| `reasoning_content` | string | 不动（响应里透传） |
| `usage` | object | 不动（同时可用于网关侧统计） |
