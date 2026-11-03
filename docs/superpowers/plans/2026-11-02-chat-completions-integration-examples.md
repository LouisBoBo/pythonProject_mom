# `/v1/chat/completions` 网关对接 —— 大白话版

> **给谁看：** 公司后端同事，之前没做过模型网关也没关系
> **这页只讲一个东西：** 客户端调你这个接口时，你到底要干哪几件事，哪几件事绝对不能干
> **别慌：** 你不需要懂 AI，不需要懂 prompt engineering，不需要懂 token 怎么算。你只需要懂 HTTP 转发。

---

## 零、一句话先说清楚你要写的是什么

**你写的不是聊天机器人，也不是 AI 算法服务。你写的就是一个"带鉴权和换包的快递中转站"。**

客户端（工作助手桌面 app）把它要发给 DeepSeek 的请求先给你看一眼，你做 4 件事：

1. 检查客户端有没有登录（看 token）
2. 把客户端说的"standard 模型"翻译成 DeepSeek 听得懂的"deepseek-chat"
3. 把你手上的 DeepSeek API Key 塞进请求头
4. 原封不动转发给 DeepSeek，然后 DeepSeek 吐什么你就给客户端吐什么

没了。就这 4 件事。**你不需要跑模型，不需要理解对话内容，不需要拼 prompt。**

---

## 一、为什么要搞这个中转站？为什么不让客户端直接调 DeepSeek？

因为 DeepSeek 要收 Key。如果客户端直接调：
- 每个用户的安装包里都要嵌一个 DeepSeek Key → 不安全，Key 泄露了没法吊销
- 管理员管不了谁能用哪个模型、能用多少 → 用量统计也做不了
- DeepSeek 涨价了/换供应商了 → 每个用户的 app 都要改

中转站一搞：
- Key 只在你服务器上，客户端碰都碰不到
- 管理员在后台改一下"standard 映射到哪个模型"，所有用户下次请求自动生效
- 每个用户每次调了多少 token，你在中转站随手就能记下来
- 换供应商只改中转站，客户端一行代码不用改

---

## 二、整条链路长啥样

```
客户端 app（工作助手）
  │
  │  "我要调 standard 模型，这是我的 token，这是我要问的问题"
  │
  ▼
你的中转站（就是你要写的 /v1/chat/completions）
  │
  │  ① token 对不对？→ 不对直接 401 打回去
  │  ② standard → deepseek-chat（查你后台配的映射表）
  │  ③ 塞 DeepSeek Key 进请求头
  │  ④ 原封不动转发给 DeepSeek
  │
  ▼
DeepSeek 官方 API（https://api.deepseek.com/v1/chat/completions）
  │
  │  开始推理，一个 token 一个 token 往外吐（SSE 流）
  │
  ▼
你的中转站（边收边给客户端转，不缓存、不重组）
  │
  ▼
客户端 app（一个字一个字蹦出来，打字机效果）
```

**重点理解两件事：**

**1. DeepSeek 返回给谁？** 返回给你（中转站），中转站再转给客户端。
客户端根本不知道 DeepSeek 的地址，也没有 DeepSeek 的 Key。客户端只知道你的中转站地址。DeepSeek 也不知道你的客户端存在，它只认你中转站给它的 Key。

**2. 能不能让 DeepSeek 直接返回给客户端？** 不能。客户端没有 Key，DeepSeek 会拒接。而且 DeepSeek 的地址你也不想让客户端知道（万一被封了/换了，客户端不用改）。

---

## 三、你要写的这个接口，收到的请求长啥样

客户端会调：

```
POST https://你的服务器地址/v1/chat/completions
Header: Authorization: Bearer <用户登录后的 token>
Header: Content-Type: application/json
```

Body 长这样（简化版）：

```json
{
  "model": "standard",
  "messages": [
    {"role": "system", "content": "你是江西中软工作助手"},
    {"role": "user", "content": "帮我找一下配置文件"}
  ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "grep",
        "description": "搜文件内容",
        "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}}
      }
    }
  ],
  "max_completion_tokens": 8192
}
```

**你看到 `model: "standard"` 了吗？这个叫 alias（别名）。** 不是 DeepSeek 认识的模型名，是你们内部起的小名。

DeepSeek 认识的模型名是 `deepseek-chat`（标准版）和 `deepseek-reasoner`（深度思考版）。
以后可能换别的厂商，比如阿里千问，那 alias 还是 `standard`，但映射到的就是 `qwen-max` 了——这就是 alias 存在的意义：客户端永远说 standard，你决定 standard 到底是谁。

---

## 四、你要做的 4 件事，逐件讲

### 第 1 件：检查 token

请求头里有个 `Authorization: Bearer xxxxxxx`。这个 `xxxxxxx` 是用户登录时你（或你们的 auth 服务）发给他的。

你要做的：拿着这个 token 去 auth 服务查一下，这个 token 有没有效、有没有过期、对应用户是谁、这个用户能用哪些模型。

- token 无效/过期 → 直接返回 HTTP 401，body 随便写 `{"error": {"code": "session_expired", "message": "登录过期"}}`
- token 有效 → 继续往下

**这一步没通过，后面全部跳过。**

### 第 2 件：alias → 真实模型名

客户端给的 `model` 是 `standard`。你有一张映射表（存数据库里、存配置文件里都行）：

| alias | 真实模型名 | 厂商 |
|-------|-----------|------|
| standard | deepseek-chat | DeepSeek |
| deep | deepseek-reasoner | DeepSeek |

查一下：`standard` → `deepseek-chat`。把 body 里的 `"model": "standard"` 改成 `"model": "deepseek-chat"`。

如果 alias 不在映射表里，或者这个用户没被授权用这个 alias（比如他只用 standard 但请求了 deep），返回 HTTP 403。

### 第 3 件：塞 DeepSeek Key

你手上有一个 DeepSeek 官方给你的 API Key（比如 `sk-xxxxxxxxxxxxxxxx`）。这个 Key **只能在你服务器上出现**，绝对不能让客户端拿到。

转发请求时，把请求头改成：

```
Authorization: Bearer sk-xxxxxxxxxxxxxxxx
Content-Type: application/json
Accept: text/event-stream
```

就这一行换一下，原来客户端带的那个 token header 换成你的 DeepSeek Key。

### 第 4 件：原封不动转发 + 流式透传

这是最关键的一件事，也是最容易被做错的一件事。

**转发请求：** 用你最熟悉的 HTTP 客户端库（Python 用 httpx，Java 用 OkHttp，Node 用 got），把第 2、3 步处理好的 body 和 headers 发到 `https://api.deepseek.com/v1/chat/completions`。

**流式透传：** DeepSeek 返回的不是一次性 JSON，是 SSE 流（Server-Sent Events）。它会一个 token 一个 token 往外吐，每个 token 就是一行 `data: {...}`。

**你要做的：** DeepSeek 吐一个 chunk → 你立刻转给客户端一个 chunk。**绝对不能等 DeepSeek 全吐完了你再一次性给客户端。** 那样用户看到的就是"卡 5 秒然后全出来"，而不是打字机效果。

而且你**绝对不能解析、重组、丢弃任何 chunk**。DeepSeek 发什么你就给客户端发什么。`tool_calls` 在 SSE 里是分片的（第一片带 id 和 name，后面几片只带参数片段），你如果把分片拼起来再发，客户端的工具调用就会坏。

---

## 五、DeepSeek 返回的 SSE 流长啥样

你不用知道每条 chunk 具体什么意思，只要原样转过去就行。这里给你看一眼大概长啥样，有个印象：

```
data: {"choices":[{"delta":{"reasoning_content":"用户想找配置文件，"},"finish_reason":null}]}

data: {"choices":[{"delta":{"reasoning_content":"先搜一下 DEFAULT_GATEWAY"},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_001","type":"function","function":{"name":"grep","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pattern\":"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"DEFAULT_GATEWAY\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":1520,"completion_tokens":38,"total_tokens":1558}}

data: [DONE]
```

**你只需要知道：**
- 每一条以 `data: ` 开头，以一个空行结束
- 最后一条是 `data: [DONE]`，表示流结束，必须原样转过去
- `reasoning_content` 是深度思考内容，不能丢
- `tool_calls` 是工具调用，分片到达的，不能拼
- `usage` 是 token 用量，你可以自己解析了存数据库（做用量统计），但要先原样转给客户端

---

## 六、DeepSeek 报错怎么办

**在流开始之前报错**（比如 Key 过期了、模型名不存在）：
DeepSeek 会直接返回 401 / 404 / 429 这类 HTTP 状态码。你在自己这个中转站的 HTTP 响应里也返回错误。

但注意：**DeepSeek 返回 401 时你绝对不能返回 401。** 客户端看到 401 会以为"自己登录过期了"，然后把用户踢下线。DeepSeek 的 401 是"你的 API Key 不行"，跟用户没关系，你应该返回 502。

状态码对照表：

| DeepSeek 返回 | 你应该返回 | 含义 |
|--------------|-----------|------|
| 401 / 403 | 502 | 你的 API Key 有问题，服务端配置异常 |
| 429 | 429 | 请求太频繁了，限流了 |
| 500 / 502 | 502 | DeepSeek 那边炸了 |
| 其他 4xx | 400 | 请求体有问题 |

**流已经开始之后报错**（比如 DeepSeek 中途断了）：
你没法再改 HTTP 状态码了，直接断开连接就行，客户端会显示"响应中断"。

---

## 七、服务端写代码的最小骨架（Python FastAPI 版）

这段代码就是完整的中转站了。把它读懂，改改鉴权那块的逻辑，就能跑起来：

```python
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import httpx

app = FastAPI()

# 你自己的配置 —— 以后放数据库里
DEEPSEEK_KEY = "sk-xxxxxxxxxxxxxxxxxxxxx"   # DeepSeek 官方给你的 Key
ALIAS_MAP = {
    "standard": "deepseek-chat",
    "deep": "deepseek-reasoner",
}
UPSTREAM_URL = "https://api.deepseek.com/v1/chat/completions"
UPSTREAM = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))


@app.post("/v1/chat/completions")
async def chat(request: Request):

    # ========== 第 1 件：鉴权 ==========
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    user = verify_user_token(token)   # ← 你们自己的鉴权函数
    if not user:
        return JSONResponse(status_code=401, content={"error": {"code": "session_expired", "message": "登录过期"}})

    # ========== 读 body ==========
    body = await request.json()

    # ========== 第 2 件：alias 映射 ==========
    real_model = ALIAS_MAP.get(body["model"])
    if not real_model:
        return JSONResponse(status_code=403, content={"error": {"code": "model_not_allowed", "message": "这个模型没给你用"}})

    # 改 model 字段
    body["model"] = real_model
    body["max_tokens"] = body.pop("max_completion_tokens", 8192)  # DeepSeek 不认 max_completion_tokens
    body.pop("store", None)  # OpenAI 专有字段，DeepSeek 不认，删了

    # ========== 第 3 件 + 第 4 件：转发 ==========
    # 先拿个流式请求对象，但不真正发送
    upstream_req = UPSTREAM.build_request(
        "POST", UPSTREAM_URL,
        json=body,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_KEY}",
            "Accept": "text/event-stream",
            "Accept-Encoding": "identity",   # 关掉 gzip，保证 chunk 是明文 SSE
        },
    )

    # 真正发送，stream=True 表示流式读取
    upstream = await UPSTREAM.send(upstream_req, stream=True)

    # ========== DeepSeek 在推流之前报错了 ==========
    if upstream.status_code >= 400:
        await upstream.aread()  # 把错误 body 读完再关
        await upstream.aclose()
        if upstream.status_code in (401, 403):
            return JSONResponse(502, {"error": {"code": "upstream_auth_failed", "message": "模型服务配置异常"}})
        return JSONResponse(502, {"error": {"code": "upstream_error", "message": "模型服务报错了"}})

    # ========== 第 4 件：流式透传 ==========
    async def relay():
        """DeepSeek 吐一个字节，我就给客户端吐一个字节。不解析、不重组。"""
        async for chunk in upstream.aiter_raw():
            yield chunk
        await upstream.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # 如果前面有 nginx，必须加这个，否则 nginx 会缓冲
        },
    )


def verify_user_token(token: str):
    """你们自己的鉴权逻辑 —— 查数据库/Redis，返回用户信息或 None"""
    # 伪代码：
    # user = db.query("SELECT * FROM sessions WHERE token = ?", token)
    # return user
    pass
```

**如果你用 Java / Node / Go，逻辑完全一样：**
1. 读请求 → 查 token → 换 model → 换 Key → 流式转发 → 流式透传。没有别的。

---

## 八、用 curl 自测

### 最快确认通不通（非流式）

```bash
TOKEN="<用户登录拿到的 token>"

curl -sS http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "standard",
    "messages": [{"role": "user", "content": "只回复 OK"}],
    "stream": false
  }'
```

预期：返回一个 JSON，里面有 `choices[0].message.content` 是 `"OK"`，有 `usage`。

### 确认是流式不是憋大招

```bash
TOKEN="<用户登录拿到的 token>"

curl -N http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "standard",
    "messages": [{"role": "user", "content": "从 1 数到 20，每个数字单独一行"}],
    "stream": true
  }'
```

**`-N` 是关键！** 不加这个 curl 会缓冲。加上之后你应该看到数字一行一行蹦出来，不是停几秒后全出来。最后一条是 `data: [DONE]`。

---

## 九、绝对不能做的 8 件事（做了客户端就坏）

| # | 错误做法 | 后果 |
|---|---------|------|
| 1 | 把 DeepSeek 的请求体反序列化成你自己的 Python 模型再拼回去 | `messages[].content` 可能是数组不是字符串，你强制转字符串就坏了；`tools` 里可能有你不知道的字段被丢了 |
| 2 | 等 DeepSeek 全返回完再 `yield` | 用户看 5 秒白屏然后全出来，没打字机效果 |
| 3 | 把 `tool_calls` 分片拼起来再发 | 客户端解析不到工具调用，Agent 没法执行工具 |
| 4 | 丢了 `reasoning_content` | 深度思考模型的思考过程看不到 |
| 5 | 丢了 `usage` chunk | 你和客户端都没法统计 token 用量 |
| 6 | 丢了最后的 `data: [DONE]` | 客户端一直等，直到超时 |
| 7 | DeepSeek 401 你也返回 401 | 客户端把所有用户踢下线 |
| 8 | nginx 开了 proxy_buffering | SSE 不实时，看起来像卡死 |

---

## 十、跟之前那份详细文档的关系

之前那份 682 行的文档是协议规范，包含了完整的字段表、SSE 每个 chunk 的逐字解释、错误码对照表、上线前 checklist、字段对照速查表。

**这一份是"先跑起来再看"的入门版。** 你先用这份写个能转的中转，跑通了再去看那份详细版，对照着补边角（比如 `stream_options.include_usage` 强制开、`max_completion_tokens` 改 `max_tokens`、usage 解析存库、用量统计上报等）。

**先让它工作起来，再让它完美起来。**
