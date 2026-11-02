# MOM 服务端对接接口 — 服务端实现清单

> 这份文档给服务端开发看。意思是：我的客户端（Electron 桌面应用）已经准备好了，会按下面的方式请求你的服务端。你需要实现这些接口，数据最终落在你的服务器上。
>
> 涉及三个功能：**用户登录对接 MOM 平台、模型下发（用户不用配 Key）、token 用量统计上报**。

---

## 零、通用约定（所有接口都要遵守）

| 项 | 要求 |
|----|------|
| 协议 | HTTPS |
| 认证方式 | 登录接口免鉴权，其余接口请求头带 `Authorization: Bearer <token>` |
| 时间戳 | 全部毫秒级 Unix 时间戳（`Date.now()` 格式） |
| 错误格式 | 所有非 2xx 响应 body 用 `{"error": {"code": "ERROR_CODE", "message": "可读描述"}}` |

---

## 一、用户登录

客户端启动后弹出登录卡，用户输入账号、密码、选择企业，提交到这里。

### 1.1 登录接口

**POST** `/api/auth/login`

请求体：

```json
{
  "username": "zhangsan",
  "password": "******",
  "enterpriseKey": "jiangxi"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | ✅ | 用户账号 |
| password | string | ✅ | 密码 |
| enterpriseKey | string | ✅ | 企业标识，枚举：`jiangxi` / `jiangning` / `qianhai` |

成功响应 200：

```json
{
  "token": "eyJhbGciOi...",
  "expiresAt": 1760000000000,
  "userId": "u_10086",
  "username": "zhangsan",
  "displayName": "张三",
  "role": "user"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| token | string | 会话令牌，后续所有接口用它鉴权 |
| expiresAt | number | 令牌过期时间（毫秒时间戳），建议 7 天 |
| userId | string | 用户唯一 ID，服务端生成 |
| username | string | 登录账号 |
| displayName | string | 展示名，客户端界面显示用 |
| role | string | `admin` 或 `user` |

失败响应：

| 状态码 | 场景 | 说明 |
|--------|------|------|
| 401 | 账号或密码错误 | 不要区分"账号不存在"和"密码错"，统一返回 |
| 403 | 该账号没有登录权限 | 账号存在但被禁用或未分配企业 |
| 429 | 登录过于频繁 | 触发限流 |
| 500 | 服务端内部错误 | —— |

### 1.2 会话校验

客户端启动时会调一次确认令牌还有效；模型网关返回 401 时也会调。

**GET** `/api/auth/me`

请求头：`Authorization: Bearer <token>`

响应 200：

```json
{
  "userId": "u_10086",
  "username": "zhangsan",
  "displayName": "张三",
  "role": "user"
}
```

401 = 令牌无效或过期，客户端收到后会弹出登录卡让用户重新登录。

### 1.3 登出

用户主动退出登录时调用。

**POST** `/api/auth/logout`

请求头：`Authorization: Bearer <token>`

响应 200：`{ "ok": true }`

---

## 二、模型下发（用户不用配 Key）

登录成功后客户端调这个接口拿到当前用户可以用的模型列表，然后直接开始用模型完成任务——**用户端永远看不到厂商 API Key，Key 只在你的服务端**。

### 2.1 获取可用模型列表

**GET** `/api/models`

请求头：`Authorization: Bearer <token>`

响应 200：

```json
{
  "models": [
    {
      "alias": "standard",
      "displayName": "DeepSeek-V4.1-Flash",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "hint": "日常任务首选"
    },
    {
      "alias": "deep",
      "displayName": "DeepSeek-V4-Pro",
      "contextWindow": 128000,
      "maxTokens": 16384,
      "hint": "复杂推理任务"
    }
  ],
  "defaultAlias": "standard"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| models[].alias | string | **关键**：客户端发模型请求时用这个别名，不用真实模型名 |
| models[].displayName | string | 客户端界面模型选择器显示的名字 |
| models[].contextWindow | number | 模型上下文窗口大小 |
| models[].maxTokens | number | 单次请求最大输出 token |
| models[].hint | string | 可选，模型说明 |
| defaultAlias | string | 默认选中的模型别名 |

**业务含义：** 不同用户/不同企业可以返回不同的模型列表。比如 A 企业只给 standard，B 企业给 standard + deep。客户端只认 alias，不管 alias 后面映射的是哪家厂商什么型号——映射关系在你的服务端做。

### 2.2 模型调用网关

客户端发过来的请求是 OpenAI Chat Completions 格式，`model` 字段填上面返回的 alias。你的网关负责：鉴权 → alias 映射到真实模型 → 注入厂商 API Key → 转发到上游。

**POST** `/v1/chat/completions`

请求头：

```
Authorization: Bearer <token>
Content-Type: application/json
```

请求体（标准 OpenAI 格式）：

```json
{
  "model": "standard",
  "messages": [{"role": "user", "content": "你好"}],
  "stream": true,
  "tools": [...]
}
```

| 字段 | 说明 |
|------|------|
| model | 填 2.1 返回的 alias，**不是厂商真实模型名** |
| 其余所有字段 | 原样透传给上游（messages、tools、stream、temperature 等） |

响应：`text/event-stream`，标准 OpenAI SSE 格式，**原样透传上游**，不能自己重组。

错误响应：

| 状态码 | 场景 | 客户端行为 |
|--------|------|------------|
| 401 | 令牌过期 | 客户端清会话弹登录卡 |
| 403 | alias 不在该用户授权范围 | 提示无权限 |
| 429 | 限流 | 提示稍后重试 |
| 500 / 502 | 上游模型异常 | 提示模型服务异常 |

**重要：** 上游厂商的 API Key 只在你的网关里出现，客户端、日志、安装包里都不能有。

---

## 三、用量统计上报

客户端每次模型调用结束后上报 token 用量，数据落在你的服务器 MOM 后台，管理员可以查看。

### 3.1 单条用量上报

**POST** `/api/usage/report`

请求头：`Authorization: Bearer <token>`

请求体：

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "modelAlias": "standard",
  "inputTokens": 1520,
  "outputTokens": 380,
  "costYuan": 0.0123,
  "latencyMs": 4200,
  "status": "ok",
  "clientTs": 1760000000000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| requestId | string | ✅ | UUID，**幂等去重用**——客户端可能因为网络重试发两次，你只写一条 |
| modelAlias | string | ✅ | 请求时用的模型别名 |
| inputTokens | number | ✅ | 输入 token 数 |
| outputTokens | number | ✅ | 输出 token 数 |
| costYuan | number | ✅ | 费用，单位元。客户端按你在后台配置的单价算好传过来 |
| latencyMs | number | ❌ | 端到端耗时毫秒 |
| status | string | ✅ | `ok` / `error` / `aborted` |
| errorMessage | string | ❌ | status 不是 ok 时填 |
| clientTs | number | ✅ | 这条记录对应的实际发生时间（毫秒时间戳） |

响应 200：`{ "ok": true }`

**幂等：** `requestId` 是唯一键。收到重复的 `requestId`，返回 200 也可以，返回 409 也可以——客户端两种都能处理，不会重复计数。

### 3.2 批量补报（离线补偿）

客户端网络断了的时候本地暂存，恢复后一次性批量补发。

**POST** `/api/usage/batch`

请求头：`Authorization: Bearer <token>`

请求体：

```json
{
  "records": [
    {
      "requestId": "550e8400-e29b-41d4-a716-446655440001",
      "modelAlias": "standard",
      "inputTokens": 100,
      "outputTokens": 50,
      "costYuan": 0.001,
      "status": "ok",
      "clientTs": 1760000000000
    },
    {
      "requestId": "550e8400-e29b-41d4-a716-446655440002",
      "modelAlias": "deep",
      "inputTokens": 500,
      "outputTokens": 200,
      "costYuan": 0.008,
      "status": "ok",
      "clientTs": 1760000001000
    }
  ]
}
```

records 里每条结构和 3.1 完全一样。

响应 200：

```json
{
  "accepted": 2,
  "duplicates": 0
}
```

### 3.3 查询自身用量（客户端展示用）

客户端"个人中心"里显示自己的 token 用量统计时调用。

**GET** `/api/usage/my`

请求头：`Authorization: Bearer <token>`

Query 参数（都可选）：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| from | number | 当天 0 点 | 起始时间戳（毫秒） |
| to | number | 当前时间 | 结束时间戳（毫秒） |
| groupBy | string | `day` | 分组方式：`day` 按天 / `model` 按模型 |

响应 200：

```json
{
  "totalInputTokens": 128000,
  "totalOutputTokens": 32000,
  "totalCostYuan": 1.23,
  "breakdown": [
    { "date": "2026-11-01", "inputTokens": 48000, "outputTokens": 12000, "costYuan": 0.46 },
    { "date": "2026-10-31", "inputTokens": 80000, "outputTokens": 20000, "costYuan": 0.77 }
  ]
}
```

---

## 四、接口清单速览

| # | 方法 | 路径 | 用途 | 鉴权 |
|---|------|------|------|------|
| 1 | POST | `/api/auth/login` | 账号密码登录 | ❌ |
| 2 | GET | `/api/auth/me` | 校验当前令牌是否有效 | ✅ |
| 3 | POST | `/api/auth/logout` | 主动登出 | ✅ |
| 4 | GET | `/api/models` | 下发当前用户可用的模型列表（含 alias） | ✅ |
| 5 | POST | `/v1/chat/completions` | 模型调用网关，alias → 真实模型 → 上游厂商 | ✅ |
| 6 | POST | `/api/usage/report` | 单条 token 用量上报（幂等） | ✅ |
| 7 | POST | `/api/usage/batch` | 批量 token 用量补报（离线恢复用） | ✅ |
| 8 | GET | `/api/usage/my` | 客户端查自己的用量统计 | ✅ |

**数据流向：** 登录 → 拿到 token → 拉模型列表 → 用户正常使用模型（网关代持厂商 Key）→ 每次调用结束上报 token 用量 → 所有数据落在 MOM 服务器。

---

## 附录：架构说明与常见疑问

### Q1：模型调用是不是要在服务端进行？DeepSeek 的返回给谁？

**不是。你的服务端不跑模型，只做透明代理。DeepSeek 返回给网关，网关再透传回客户端。**

为什么不能让 DeepSeek 直接返回给客户端？因为客户端不知道 DeepSeek 的 API 地址，也没有厂商 Key——它只知道你的网关地址和自己的登录 token。

完整链路：

```
客户端（Electron 工作助手）
    │  POST /v1/chat/completions
    │  model: "standard"   ← 只发 alias
    │  Authorization: Bearer <token>
    ▼
你的服务端网关（中转层，不跑模型）
    │  ① 鉴权：token 是否有效
    │  ② alias 映射：standard → 真实模型名（如 deepseek-v4.1-flash）
    │  ③ 注入厂商 API Key（Key 只在这里出现）
    │  ④ 透传请求体（messages、tools、stream 全不动）
    ▼
上游厂商模型 API（真正跑模型的地方）
    │  推理 → 生成 SSE 流 → 推给网关
    ▼
你的服务端网关（边收边转，原样透传每个 chunk）
    │  DeepSeek 推第 1 个 token → 网关立刻写给客户端
    │  DeepSeek 推第 2 个 token → 网关立刻写给客户端
    │  ...
    │  DeepSeek 推 finish_reason + usage → 网关写给客户端 → 关闭连接
    ▼
客户端看到打字机效果（一个字一个字蹦出来）
```

网关**不跑模型、不处理语义**，只做 4 件事：鉴权 → alias 映射 → 注入厂商 Key → SSE 流透传。真正的推理在上游厂商（DeepSeek 等）那边完成。

**流式透传的硬要求：** 网关必须边收边转，不能缓存完整结果再一次性吐给客户端——否则用户就会看到"卡几秒然后全出来"，打字机效果就没了。网关必须原样透传上游的 SSE chunk（包括 `tool_calls` 分片、`reasoning_content`、`finish_reason`、`usage`），不能自己重组内容——客户端 Agent 层靠这些字段执行工具调用和链式推理。

### Q2：这是主流做法吗？

**是。企业级 AI 应用几乎全是这个架构，业内叫"模型网关（Model Gateway）"或"AI 代理层"。**

大厂的做法：

| 产品 | 架构 |
|------|------|
| OpenAI 企业版 | 官方不允许客户端硬编码 Key，企业客户全走后端代理 |
| Microsoft Copilot | Office / GitHub Copilot：客户端 → Azure AI Foundry 网关 → 上游模型 |
| 字节 / 阿里 / 百度 | 内部 AI 助手统一网关代持 Key，按部门/项目配额管控 |
| Cursor / Windsurf | IDE AI 插件的客户端请求也经过自家网关，Key 从不落地客户端 |

为什么不让客户端直连厂商：

| 方案 | Key 放哪 | 谁管控 | 用量统计 | 切换模型 |
|------|----------|--------|----------|----------|
| 客户端直连厂商 | 每个用户的安装包里 | 用户自己 | 只能让用户自己查 | 用户自己配 |
| 网关代理（我们的方案） | 你的服务端 | 管理员统一管控 | 服务端自动记账 | 管理员统一切换 |

### Q3：上下文和调用信息都经过服务端，合理吗？

**合理，而且必须这样做。** 三个关键事实：

**1. 上游厂商本身就会收到这些信息**

不管加不加网关，客户端请求里的 `messages`（对话上下文）、`tools`（工具定义）、`files`（上传的文件）最终都会发到厂商 API 那边。加网关只是多了一跳中转，信息内容没变。

**2. 网关是透明代理，不存储上下文**

网关只做"收 → 换 Header → 转发"，**不持久化对话内容**。厂商 API 也只在推理期间持有上下文，推理完就释放。"服务器存了所有用户的聊天记录"这件事在当前架构里不会发生——除非主动要存（比如做审计），那也是可选功能。

**3. Agent 场景下，客户端必须发送完整上下文**

工作助手不是简单聊天，它有工具调用（查库、改文件、执行命令）。模型需要看到完整的对话历史才能决定下一步调什么工具、传什么参数。这部分数据是推理必需的，不发过去模型就没法工作。

**隐私注意事项（当前架构的边界）：**

- 对话里可能包含**公司内部代码、数据库数据、敏感业务信息** → 这些数据本来就会到厂商那边，网关只是过路费
- 用量上报里的字段（`clientTs`、`requestId`、`modelAlias`、token 数、费用）是元数据，不涉及对话内容 → 已经和对话体隔离
- 如果未来要做更严的数据隔离，可以加一层**网关对 messages 做脱敏后再转发厂商**（比如把客户名替换、把 SQL 里的敏感字段抹掉），这是可选增强项，基础网关先跑通再说
