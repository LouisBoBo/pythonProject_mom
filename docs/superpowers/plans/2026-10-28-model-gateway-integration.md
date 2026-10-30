# 模型网关接入方案（路线 A）

> 状态：客户端与服务端均已实施（`desktop/shell/apps/desktop/src/model-gateway.ts`、兄弟仓库 `pythonProject_zr_aicoding/gateway/`），上游暂定 DeepSeek，登录复用 MES 账号。剩余是部署项：网关子域名、HTTPS 证书、上游 Key。
> 日期：2026-10-28  
> 范围：把《用户登录即用模型》的服务端代持 Key 方案接入当前桌面应用与 Python CLI。  
> 结论：可行。DSH 已有 OpenAI 兼容网关的接入点，桌面侧以配置和登录入口改动为主，不需要改 DSH 源码。

## 0. 当前实现状态

已落地（默认关闭，配置 `ZR_MODEL_GATEWAY_URL` 或 `DEFAULT_GATEWAY_BASE_URL` 后生效）：

| 文件 | 作用 |
| --- | --- |
| `desktop/shell/apps/desktop/src/model-gateway.ts` | 配置解析、`POST /api/login` 调用、profile 补丁生成与幂等写入 |
| `desktop/shell/apps/desktop/src/local-login.ts` | `recordGatewaySession()`：只记身份与过期时间，令牌不进这个文件 |
| `desktop/shell/apps/desktop/src/main.ts` | 启动时注入路由；`loginGate` / `submitLogin` 分支；令牌经 `welcomeBackend.save()` 进凭据库 |
| `desktop/shell/apps/desktop/tests/model-gateway.spec.ts` | 13 项单元测试 |
| `pythonProject_zr_aicoding/gateway/zr_gateway/` | 网关服务：MES 登录转发、会话、别名路由、流式透传、用量流水 |
| `pythonProject_zr_aicoding/gateway/tests/test_gateway.py` | 18 项网关测试（MES、上游均为假实现） |

未做：配额强制扣费（`usage_records` 已记账，不拦截）；令牌续期（超过 7 天只能重新登录）；令牌被撤销的主动推送（下次请求即 401，桌面端会回到登录卡）；多上游/灰度；登录响应里的 `models[]` 动态写入 profile（本期固定别名清单）。

## 1. 目标与非目标

目标：

- 厂商密钥只存在于网关，客户端、安装包、日志里不出现 `sk-`。
- 用户登录后拿到会话令牌和模型别名，模型请求统一经过网关。
- 网关负责鉴权、模型别名映射、配额、用量记账。
- 桌面应用保持现有 Agent 能力：工具调用、流式输出、查库技能。

非目标（本阶段不做）：

- 多租户隔离、按套餐动态下发模型清单。
- 内容审核、OAuth/SSO、账单结算。
- 替换查库技能，模型网关与数据库连接是两条独立链路。

## 2. 架构

```
桌面应用 / Python CLI
   │  ① 登录（企业 + 账号 + 密码）
   ▼
网关 /api/login ──► 会话令牌 + 模型别名清单
   │
   │  ② POST /v1/chat/completions
   │     Authorization: Bearer <会话令牌>
   │     model: "standard"（别名）
   ▼
网关 ── 验签 → 配额预扣 → 别名映射 → 注入厂商 Key → 转发
   │
   ▼
厂商模型 API（SSE 流式）
```

责任边界：

| 角色 | 负责 | 不接触 |
| --- | --- | --- |
| 客户端 | 身份、会话、模型别名 | 厂商 Key、真实模型名 |
| 网关 | 鉴权、配额、别名映射、记账 | 业务语义 |
| 厂商 | 校验 Key、生成结果 | 用户身份 |

## 3. 为什么不能直接接原方案的 `/api/chat`

原方案的网关契约是自定义 SSE：

```
data: {"delta":"..."}
```

DSH 的模型层不是这个协议：

- 官方路由 `deepseek-official` 请求 `POST {baseURL}/v1/messages`，认证头是 `x-api-key`（[adapter.ts:138](file:///Users/hebo/dsh-src/packages/llm/llm-deepseek/src/adapter.ts#L138)）。
- DSH 是 Agent，请求体带 `tools`，响应流必须包含 `tool_calls`、`finish_reason`、`usage`、`reasoning_content`。
- 只转发文本会让查库、改文件、执行命令全部失效。

因此网关必须实现成 **OpenAI 兼容的透明代理**，而不是只返回文本碎片的聊天接口。

## 4. 两条路线

| | 路线 A（推荐） | 路线 B |
| --- | --- | --- |
| 网关接口 | `/v1/chat/completions`（OpenAI 兼容） | `/v1/messages`（DeepSeek/Anthropic 兼容） |
| 客户端接入 | 新增 `llm-pi-ai` 路由 | 官方路由改 `baseURL` + `models` |
| 认证头 | `Authorization: Bearer <令牌>` | `x-api-key: <令牌>` |
| 网关工作量 | 小，直接透传 OpenAI | 大，要翻译 Messages 协议和 SSE 事件 |
| 桌面改动 | profile + 登录入口 | profile + 登录入口 |

本方案选路线 A。路线 B 保留为备选：如果以后必须走官方路由，再补 Messages 协议。

## 5. 桌面侧实施

### 5.1 新增 pi-ai 路由

`llm-pi-ai` 支持 OpenAI 兼容网关，每个路由可配置 `baseURL`、`apiKeyEnv`、协议和模型清单（[README](file:///Users/hebo/dsh-src/packages/llm/llm-pi-ai/README.md)）。

已核实：`dsh-base` bundle 里就有 `id: llm-pi-ai` 这一行，默认零路由挂载（[cordis.patch.yml:128](file:///Users/hebo/dsh-src/packages/bundle/base/cordis.patch.yml#L128)），打包运行时 `node_modules/@deepseek-ai/dsh-llm-pi-ai` 也在。所以**不需要加依赖、不需要重做运行时**，只要在 profile 补丁里给这一行补 config。

在桌面 profile 的 `cordis.patch.yml` 追加（按 id 覆盖，不是 `insert` 新行）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      zr-gateway:
        displayName: 中软模型网关
        baseURL: https://gateway.internal/v1
        api: openai-completions
        apiKeyEnv: DEEPSEEK_API_KEY   # 凭据引用名，值存凭据库
        compat:
          thinkingFormat: deepseek    # 上游是 DeepSeek 系时保留 reasoning_content
        models:
          - id: standard
            contextWindow: 128000
            maxTokens: 8192
          - id: deep
            contextWindow: 128000
            maxTokens: 16384
```

`- id: llm-pi-ai` 这种写法与公司插件市场追加 `- id: plugin-market` 完全一致，补丁是按 id 覆盖行的，不是插入新插件。注意补丁**替换整段 config**而不是合并，所以 `providers` 要一次写全。

说明：

- `zr-gateway` 是路由名，请求时 `provider` 选它；模型 `id` 就是网关别名。
- `contextWindow` / `maxTokens` 必须和真实模型一致，否则 DSH 可能发超长上下文或被截断。
- `apiKeyEnv` 不是 `process.env` 变量，而是**凭据引用**（`^[A-Za-z_][A-Za-z0-9_]*$`），每次请求时由 `dsh-credentials` 解析；配置里永远看不到令牌本身。
- 复用 `DEEPSEEK_API_KEY` 的收益：现有 `welcomeBackend.save()` 写的就是这个 ref（[welcome-backend.ts:137](file:///Users/hebo/dsh-src/apps/desktop/src/welcome-backend.ts#L137)），登录成功后直接 `save(token)` 即可，**不用改 `welcome-backend.ts`**（它在覆盖层之外，改了要新增 manifest 条目）。
- 代价：`llm-deepseek` 这一行不能禁用，否则 `save()` 找不到 `llm-deepseek` 设置命名空间而返回 `ok:false`；模型选择器里会残留官方 DeepSeek 模型（用令牌打 api.deepseek.com 会失败）。内部版可接受，后续要干净的话再用独立 ref `ZR_GATEWAY_TOKEN` 并同时改保存入口。
- 桌面安装包里的 profile 由 Host 创建，写入方式参考公司插件市场的 profile 补丁（[company-market.ts:39](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/desktop/shell/apps/desktop/src/company-market.ts#L39)），幂等追加。

### 5.2 登录与会话

现有流程：

- 欢迎卡提交账号密码，`submitLocalLogin` 校验本地 `users.json`（[local-login.ts:162](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/desktop/shell/apps/desktop/src/local-login.ts#L162)）。
- 成功后写本地会话，7 天有效。
- 模型密钥由壳写入 `DEEPSEEK_API_KEY` 凭据。

改为：

1. 欢迎卡调用网关 `POST /api/login`，提交企业、账号、密码。
2. 成功返回 `token`、`expiresAt`、用户信息、模型别名清单。
3. 壳调用现有的 `welcomeBackend.save(token)` 把令牌写进 `DEEPSEEK_API_KEY` 凭据，然后 `finishLogin()`。
4. 本地 `session.json` 只保留身份和过期时间，作为启动时的缓存，权威仍在网关。
5. `needsWelcome` 逻辑不变：本地会话不存在或过期就显示登录卡；网关返回 401 时清会话并重新打开登录卡。
6. 本地 `users.json` 建议停用，避免“本地密码”和“网关账号”两套权威。网关不可达时明确提示，不回退本地登录。

注意：DSH 目前没有“网关鉴权失败”的专用回调，401 只会显示在对话里。需要在壳里补一个拦截：启动时用令牌调一次网关的会话校验接口，失败就清会话并 `showWelcome()`；运行中则监听模型错误上报做同样处理。

会话令牌要求：

- 用 Bearer，不用 Cookie（桌面 Host 是 Node 进程，不是浏览器页面）。
- 有效期与本地会话一致，或提供刷新接口；长时间 Agent 任务要避免中途过期。
- 令牌只存凭据库，不写日志、不进 session 文件。

### 5.3 默认模型

默认模型由 `agent-default-model` 这一行决定，base 里写的是 `deepseek-official / deepseek-flash`（[cordis.patch.yml:90](file:///Users/hebo/dsh-src/packages/bundle/base/cordis.patch.yml#L90)）。同一个 profile 补丁里覆盖：

```yaml
- id: agent-default-model
  config:
    provider: zr-gateway
    model: standard
```

注意：`provider` / `model` 是 volatile 配置，`settings` 里保存过选择时会在创建 Agent 时覆盖补丁值（[index.ts:16](file:///Users/hebo/dsh-src/packages/core/agent-default-model/src/index.ts#L16)）。所以首次安装生效，老用户如果自己换过模型仍以他的选择为准。

Python CLI 则显式传：

```python
DeepSeekHarness(provider="zr-gateway", model="standard", ...)
```

CLI 侧需要实测：`sdk-minimal` bundle 默认只带官方 DeepSeek 适配器，不包含 `llm-pi-ai`。如果 CLI 也要走网关，需要给该 profile 增加 `@deepseek-ai/dsh-llm-pi-ai` 依赖，并确认 `DeepSeekHarness(provider="zr-gateway")` 接受自定义路由名；否则 CLI 继续直连厂商，仅桌面应用走网关。

### 5.4 改动文件清单

已改动（都已列入 `desktop/shell-manifest.txt`）：

- 新增 `apps/desktop/src/model-gateway.ts`：`resolveGatewayConfig()` / `parseGatewayBaseUrl()` / `loginWithGateway()` / `ensureGatewayProfile()`。
- 新增 `apps/desktop/tests/model-gateway.spec.ts`。
- `apps/desktop/src/local-login.ts`：导出 `SESSION_TTL_MS`，新增 `recordGatewaySession()`；本地登录逻辑一字未改。
- `apps/desktop/src/main.ts`：启动回调里 `ensureGatewayProfile(paths.profile, gateway)`；`loginGate` 与 `submitLogin` 增加网关分支，未配置时走原来的 `submitLocalLogin`。

不需要改：

- `WelcomePage.tsx`：卡片只展示 `result.detail`，网关的错误文案直接复用现有渲染。
- `welcome-api.ts`：`WelcomeLoginResult` 的 `code` 本来就是 `string`。
- `welcome-backend.ts`：不在覆盖层；复用 `DEEPSEEK_API_KEY` 后现有 `save()` 可直接用。

补丁写法：生成块用 `# zr-model-gateway:begin/end` 包起来，每次启动整块重写，块外内容原样保留；只有模板那种"整份文档就是一个空数组"的情况才会替换 `[]`，行内的 `indexes: []` 不会被误伤。

## 6. 网关接口契约

### 6.1 `POST /api/login`

请求：

```json
{
  "enterprise": "jiangxi",
  "username": "louis",
  "password": "******"
}
```

响应 200：

```json
{
  "token": "opaque-or-jwt",
  "expiresAt": 1760000000000,
  "user": { "id": "u_1001", "name": "louis", "plan": "internal" },
  "models": [
    { "alias": "standard", "displayName": "标准", "hint": "日常够用" },
    { "alias": "deep", "displayName": "深度", "hint": "复杂分析" }
  ]
}
```

约束：

- 响应里不出现 `real_name`、`base_url`、`key_ref`。
- 密码走 HTTPS；账号由 MES 校验（bcrypt），网关不存密码，只存会话令牌摘要。
- 失败统一返回 401，不区分“用户不存在”和“密码错误”。
- 内部阶段模型清单可以所有人一致；按套餐过滤留到后续。

### 6.2 `POST /v1/chat/completions`

请求头：

```
Authorization: Bearer <token>
Content-Type: application/json
```

请求体：标准 OpenAI Chat Completions。除 `model` 外全部透传，包括：

- `messages`（含 content 数组、图片、工具结果）
- `tools`、`tool_choice`、`parallel_tool_calls`
- `stream`、`stream_options`
- `temperature`、`top_p`、`max_tokens` / `max_completion_tokens`
- `response_format`、`reasoning_effort`（如果上游支持）

`model` 只接受别名。网关负责：

1. 校验会话与别名权限。
2. 原子预扣配额。
3. 别名映射为真实模型名。
4. 注入厂商 Key，转发到上游。
5. 原样转发 SSE，不重组内容。
6. 记录用量并结算。

响应：`text/event-stream`，保持 OpenAI chunk 结构。非流式请求可同步支持，但 DSH 默认走流式。

### 6.3 流式与工具调用（P0）

网关必须原样透传以下字段，不能只拼接文本：

- `choices[0].delta.content`
- `choices[0].delta.reasoning_content`（DeepSeek 等模型）
- `choices[0].delta.tool_calls[]`：`index`、`id`、`function.name`、`function.arguments` 分片
- `choices[0].finish_reason`，尤其是 `tool_calls`
- 最后一个 chunk 的 `usage`（需要上游 `stream_options.include_usage`）

其他要求：

- 客户端断开时 abort 上游请求，避免继续计费。
- 不缓存完整回答，边收边转。
- 上游 5xx 可重试一次；流已经开始后不要重试，改为发送错误事件。
- 请求 ID 贯穿日志、用量流水和错误响应。

### 6.4 错误约定

统一返回 OpenAI 错误结构：

```json
{
  "error": {
    "message": "额度不足",
    "type": "insufficient_quota",
    "code": "quota_exceeded"
  }
}
```

| 状态码 | 场景 | 客户端表现 |
| --- | --- | --- |
| 401 | 未登录/令牌过期 | 清会话，重新登录 |
| 402 | 额度不足 | 提示联系管理员 |
| 403 | 模型不在授权范围 | 提示无权限 |
| 429 | 限流 | 提示稍后重试 |
| 502/500 | 上游异常 | 提示模型服务异常，不透传上游原文 |

### 6.5 配额与会话

配额：

- 进入 `/v1/chat/completions` 先原子预扣，不做事后追讨。
- 预扣额度按“输入估算 + `max_tokens` 上限”计算，结束后按 `usage` 结算退差。
- 并发请求不能同时通过检查后一起超支。

```sql
UPDATE users
SET quota_yuan = quota_yuan - :reserve
WHERE id = :user_id AND status = 1 AND quota_yuan >= :reserve;
-- 受影响行数为 0 即拒绝
```

会话：

- Bearer 令牌，服务端可撤销；Redis 黑名单支持强制下线。
- 令牌过期时间与本地会话对齐；长任务需要刷新机制或在任务期间续期。

## 7. 数据模型（修正版）

在原方案基础上修正以下问题：

1. `models.min_plan` 与 `plan_models` 两个授权来源冲突，只保留 `plan_models`。
2. 决策 3 声称同一别名可挂多个上游做灰度/故障转移，但原表只有单个 `provider_id`，增加 `alias_routes`。
3. 用量流水增加 `request_id` 唯一键，支持幂等和重试去重。
4. Key 轮换需要“当前/下一把”，`providers` 增加 `key_ref_next`。
5. 多租户暂不做；如果以后要做，所有业务表加 `tenant_id`，不要只在文档里承诺。

```sql
CREATE TABLE users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  plan          VARCHAR(32) NOT NULL DEFAULT 'internal',
  quota_yuan    DECIMAL(10,2) NOT NULL DEFAULT 0,
  status        TINYINT NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE providers (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  name         VARCHAR(64) NOT NULL,
  base_url     VARCHAR(255) NOT NULL,
  key_ref      VARCHAR(64) NOT NULL,        -- 环境变量名，不存 Key
  key_ref_next VARCHAR(64) NULL,            -- 轮换期的新 Key 名
  enabled      TINYINT NOT NULL DEFAULT 1
);

CREATE TABLE models (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  alias          VARCHAR(32) NOT NULL UNIQUE,
  real_name      VARCHAR(64) NOT NULL,
  provider_id    BIGINT NOT NULL,
  context_window INT NOT NULL,
  max_tokens     INT NOT NULL,
  price_in       DECIMAL(10,4) NOT NULL,    -- 元 / 百万 token
  price_out      DECIMAL(10,4) NOT NULL,
  enabled        TINYINT NOT NULL DEFAULT 1,
  FOREIGN KEY (provider_id) REFERENCES providers(id)
);

-- 别名的实际路由；灰度按 weight，故障转移按 priority
CREATE TABLE alias_routes (
  alias       VARCHAR(32) NOT NULL,
  provider_id BIGINT NOT NULL,
  priority    INT NOT NULL DEFAULT 0,
  weight      INT NOT NULL DEFAULT 100,
  enabled     TINYINT NOT NULL DEFAULT 1,
  PRIMARY KEY (alias, provider_id)
);

-- 唯一的模型授权来源
CREATE TABLE plan_models (
  plan  VARCHAR(32) NOT NULL,
  alias VARCHAR(32) NOT NULL,
  PRIMARY KEY (plan, alias)
);

CREATE TABLE usage_records (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  request_id    CHAR(36) NOT NULL UNIQUE,
  user_id       BIGINT NOT NULL,
  model_alias   VARCHAR(32) NOT NULL,
  real_name     VARCHAR(64) NOT NULL,
  input_tokens  INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_yuan     DECIMAL(10,6) NOT NULL,
  latency_ms    INT,
  status        VARCHAR(16) NOT NULL DEFAULT 'ok',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at),
  INDEX idx_time (created_at)
);
```

## 8. 分阶段实施

### 阶段 1：最小闭环

- 网关：MES 账号登录转发、DeepSeek 单上游、OpenAI 兼容流式、工具调用透传。**已完成**（`pythonProject_zr_aicoding/gateway/`）。
- 桌面：`zr-gateway` 路由、登录改调网关、令牌存凭据。**已完成**。
- 验收：本地假 MES + 假上游已跑通登录、别名改写、SSE 原样透传（`reasoning_content`、`tool_calls` 分片、`finish_reason`、`usage`）和客户端断连 abort。真实 DeepSeek 与真实 MES 需在服务器上验证。
- 部署：网关子域名 + 宝塔 Let's Encrypt 证书 + systemd 单元 `zr-gateway.service`（见 `pythonProject_zr_aicoding/gateway/README.md`）。**部署文件已就绪，尚未上线**。

### 阶段 2：控制面

- 别名映射、用量流水、错误码映射、令牌撤销、上游重试和断连 abort。**已完成**。
- 原子配额预扣与结算：未做。
- 验收：并发不超支；断连后上游停止；用量可按人按天汇总。

### 阶段 3：可选

- 按套餐下发模型清单。
- Key 轮换、备用上游、灰度。
- 内容审核、审计字段（IP/UA/request_id）。

## 9. 验收清单

1. 客户端配置、安装包、日志里检索不到 `sk-`。
2. 错误密码返回 401；登录成功后令牌可用。
3. DSH 发起带 `tools` 的请求，模型返回 `tool_calls`，工具执行成功。
4. 流式输出有打字机效果；`reasoning_content` 不丢。
5. 客户端中断，网关日志显示上游请求已 abort。
6. 低额度下并发 20 个请求，成功数不超过额度允许值。
7. 换厂商 Key 只改环境变量，客户端无感。
8. 402/403/429 在界面上有可读提示，且不透传上游原始错误。

## 10. 风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| ~~桌面 profile 未挂载 `llm-pi-ai`~~ | —— | 已核实：`dsh-base` 已挂载（默认零路由），无需改依赖 |
| 网关走 HTTP | 会话令牌在局域网明文可见 | 上线前必须上 HTTPS；内网自签证书可用，但不能用 HTTP |
| 网关只转发文本 | Agent 能力全失效 | 把工具调用透传列为 P0，先做联调 |
| 模型能力参数不准 | 上下文超限或输出被截断 | `contextWindow` / `maxTokens` 与真实模型对齐 |
| 令牌中途过期 | 长任务失败 | 刷新接口或任务期间续期 |
| 网关单点 | 全员无法用模型 | 健康检查、明确错误提示、内网高可用 |
| 上游协议差异 | reasoning/tool 格式不一致 | 优先透传，不自行重组；必要时做协议适配层 |
| CLI 仍直连 | 两套取 Key 方式 | 明确 CLI 仅开发用；需要时再给 sdk-minimal 加 pi-ai |

## 11. 参考

- 原始方案：[方案.md](file:///Users/hebo/Downloads/方案.md)
- pi-ai 网关配置：[llm-pi-ai/README.md](file:///Users/hebo/dsh-src/packages/llm/llm-pi-ai/README.md)
- 官方路由协议：[llm-deepseek/src/adapter.ts:138](file:///Users/hebo/dsh-src/packages/llm/llm-deepseek/src/adapter.ts#L138)
- 桌面凭据保存：[welcome-backend.ts:137](file:///Users/hebo/dsh-src/apps/desktop/src/welcome-backend.ts#L137)
- 本地登录实现：[local-login.ts:162](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/desktop/shell/apps/desktop/src/local-login.ts#L162)
- profile 补丁写法：[company-market.ts:39](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/desktop/shell/apps/desktop/src/company-market.ts#L39)
- 壳同步规则：[desktop-shell-sync.mdc](file:///Users/hebo/Desktop/中软项目/pythonProject_mom/.cursor/rules/desktop-shell-sync.mdc)
