# MOM 服务端对接接口 — 第二期规划

> 这份文档给服务端 / 运维看。桌面端（Electron）与本地桥接**已经按下列契约在跑**；第二期目标是把「安装包升级、插件市场、写码用量」落到**公司服务器**，对接时以**最少客户端改动**为准。
>
> 对照第一期理想稿 [`2026-11-01-mom-server-integration-api.md`](./2026-11-01-mom-server-integration-api.md)：那份用的是 `/api/auth/*`、`/api/usage/*`。**现网与客户端已落地的是** `/api/sys/*`、`/api/ai/*`（见 [`接口文档.md`](./接口文档.md)）。第二期**一律跟现网与已写死的客户端路径**，不再引入另一套 REST 前缀。

| 项 | 内容 |
| --- | --- |
| 产品 | 江西中软工作助手（桌面壳 + Host + 公司 MOM） |
| 规划日 | 2026-11-11 |
| 范围 | ① 安装包发布与版本升级 ② 公司插件市场 ③ Cursor 写码用量上报 |
| 原则 | 能静态托管就不新开业务 API；能复用 `Usage/Report` 就不新开用量路径；客户端只补「现网缺口」 |

---

## 零、总原则（对接前先读）

| # | 原则 | 含义 |
| --- | --- | --- |
| 1 | 跟客户端，不跟第一期理想稿 | 升级看 feed JSON；插件看 `plugins.json` + npm；用量看 `/api/ai/Usage/*` |
| 2 | 鉴权边界分开 | 安装包与插件目录对**终端用户只读、免登录**；用量必须 `Authorization: Bearer <登录令牌>` |
| 3 | 信封不要混用 | 用量走 MOM `FunctionResult`（`Success` / `Content` / `Datas`）。强制升级策略若启用，走既有 WorkBuddy 风格 `code` 信封（见附录 B），**不要**硬套成 `FunctionResult`，否则要改客户端 |
| 4 | 第二期服务端「必做」与「可选」 | 见各章末「客户端改动量」；优先勾必做 |
| 5 | 测试 / 正式 | 仅切换静态根与网关 `baseUrl`（环境变量），**不要**拆登录到公司、对话到另一台（会话权威必须同源） |

**现网默认主机（可被环境变量覆盖）：**

| 用途 | 默认 |
| --- | --- |
| 模型 / 登录 / 用量网关 | `ZR_MODEL_GATEWAY_URL` → 现网如 `http://113.90.149.166:6680` |
| 安装包 feed | `ZR_MOM_UPDATE_FEED_BASE` → `https://175.178.238.31:8443/dsh-mom-desktop/` |
| 插件目录根 | `ZR_DSH_MARKET_BASE` → `https://175.178.238.31:8443/dsh-plugins/` |

---

## 一、安装包上传与版本升级

### 1.1 现状（客户端已实现，服务端只需托管）

桌面端**不走** electron-updater 的 `latest.yml` 生产路径。配置了 feed 基址后走 `DesktopMomUpdateCoordinator`：

1. `GET {feedBase}latest-windows.json` 或 `latest-macos.json`（**无鉴权**）
2. 校验 `version`（semver）> 本地版本
3. `GET {feedBase}{artifact.file}` 下载安装包，校验 `sha256` / `size`
4. Windows 拉起 `.exe`；macOS 解压 `.zip` 后交给 Finder

源码：`desktop/shell/apps/desktop/src/mom-update-feed.ts`、`mom-update-coordinator.ts`。  
发布脚本：`desktop/update-feed.mjs` + `desktop/update-upload.env`（当前是 **SSH/scp** 推静态目录，**没有** HTTP 上传 API）。

### 1.2 终端只读契约（服务端必做 · 零客户端改动）

在公司机提供 HTTPS 静态目录（建议继续挂在网关 8443 的 TLS 下，与客户端已信任的 CA 一致）。

**目录约定：**

```
{feedBase}/
  latest-windows.json
  latest-macos.json
  zr-dsh-{version}-win-x64-unsigned.exe   # 示例名，以 feed 内 file 为准
  zr-dsh-{version}-mac-….zip
```

**GET** `{feedBase}latest-windows.json`（macOS 同理换文件名）

响应 200，`Content-Type: application/json`：

```json
{
  "product": "MOM",
  "platform": "windows",
  "version": "0.2.1-rc.2.20261102.1",
  "publishedAt": "2026-11-11",
  "notes": "修复若干问题。",
  "artifact": {
    "file": "zr-dsh-0.2.1-rc.2.20261102.1-win-x64-unsigned.exe",
    "sha256": "<64 位小写十六进制>",
    "size": 123456789
  }
}
```

| 字段 | 要求 |
| --- | --- |
| product | 可选；若出现建议为 `"MOM"` |
| platform | `windows` / `macos`，与文件名对应 |
| version | 合法 semver；**必须大于**用户已安装的产品版本，否则客户端认为无更新 |
| artifact.file | 仅 `[A-Za-z0-9][A-Za-z0-9._-]*`，与同目录真实文件名一致 |
| artifact.sha256 | 文件内容 SHA-256 |
| artifact.size | 字节数；单包上限客户端按 3GB 截断 |

**行为约定（勿改，否则客户端行为变怪）：**

| HTTP | 客户端 |
| --- | --- |
| 200 + 合法 JSON | 比版本 → 提示升级 / 下载 |
| 404 / 网络失败 | 视为「暂无更新」（idle），**不当成致命错误** |
| 校验失败 / 非同主机跳转过多 | error 态 |

下载：**GET** `{feedBase}{artifact.file}`，200，完整 body，禁止换主机外链（客户端限制同主机 redirect ≤ 5）。

### 1.3 发布侧：继续 SCP（推荐）还是补上传 API

| 方案 | 谁改 | 说明 |
| --- | --- | --- |
| **A. 维持 SCP（推荐本期）** | 运维 / 打包脚本 | `update-feed.mjs` 已写 feed + 上传 + 保留最近 N 个包。服务端只要 nginx/静态目录可写。**客户端 0 行改动。** |
| **B. 管理端 HTTP 上传（可选）** | 仅服务端 + 运维工具 | 给 CI / 无 SSH 场景用；**桌面终端仍只读 1.2**，不必改。 |

若做方案 B，建议管理端（需管理员鉴权，**不要**复用普通用户 token 权限模型除非已有 RBAC）：

| 方法 | 路径（建议挂在现有管理前缀下，名称可按框架调整） | 用途 |
| --- | --- | --- |
| POST | `/api/sys/desktop/Package/Upload` | `multipart`：`platform` + `file`；服务端算 sha256/size，落盘到 feed 目录 |
| POST | `/api/sys/desktop/Package/Publish` | body：`platform`、`version`、`notes?`、`file`（已上传文件名）；原子写 `latest-*.json` |
| GET | `/api/sys/desktop/Package/List` | 管理端列历史包（终端不用） |

> 路径名可按公司 API 惯例微调，但**不要**让桌面去调这些接口。桌面永远只认静态 feed。

### 1.4 强制升级策略（可选，与 feed 独立）

客户端已有 `dshMandatoryUpdatePolicy` / `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG`。策略 HTTP 与 JSON feed **不是同一条链路**。若本期要启用，服务端按附录 B 实现；未配置则桌面不拦。

### 1.5 本章客户端改动量

| 项 | 改动量 |
| --- | --- |
| 公司机托管 feed + 安装包 | **0**（配 `ZR_MOM_UPDATE_FEED_BASE`） |
| 打包上传 | **0**（继续用 `update-feed.mjs` + SSH） |
| 新增管理上传 API | **0**（仅运维工具） |

---

## 二、公司服务器插件市场

### 2.1 现状（客户端已实现，服务端只需目录 + npm）

打包后的桌面会拉起本地桥 `company-market-bridge.mjs`：

1. 拉取公司 **`plugins.json`**
2. 按包名读公司 npm 元数据，生成 DSH **format 1** 的 `index.json`
3. 在 `http://127.0.0.1:13090` 提供 index，并把 `/npm/*` 代理到公司 npm（`@zhongruan/*`）或公网 npmmirror
4. Host 插件市场 UI 只认本地 index；**终端不直连业务 REST 装插件**

源码：`scripts/company-market-bridge.mjs`、`desktop/shell/apps/desktop/src/company-market.ts`。

### 2.2 公司侧只读契约（服务端必做 · 零客户端改动）

在 `{ZR_DSH_MARKET_BASE}`（默认 `https://175.178.238.31:8443/dsh-plugins/`）提供：

| 资源 | 方法 | 说明 |
| --- | --- | --- |
| `plugins.json` | GET | 公司目录清单（见下） |
| `npm/` | GET | **兼容 npm registry** 的只读镜像（至少支持包元数据与 tarball） |

**GET** `{marketBase}plugins.json`

```json
{
  "categories": {
    "tools": { "en": "Tools", "zh": "工具与能力" },
    "coding": "写码"
  },
  "plugins": [
    {
      "npm": "@zhongruan/dsh-cursor-chat",
      "version": "1.2.3",
      "description": { "en": "Cursor coding", "zh": "对话写码" },
      "owner": "中软",
      "category": "coding",
      "url": "https://example.com/docs/dsh-cursor-chat"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| plugins[].npm 或 name | ✅ | npm 包名；桥接用它去 `{marketBase}npm/` 拉元数据 |
| version | ❌ | 缺省则用 registry 的 `dist-tags.latest` |
| description | ❌ | 字符串或 `{en,zh}` |
| owner | ❌ | 展示作者，默认「中软」 |
| category | ❌ | 须落在 `categories` 的 key，否则归入 `tools` |
| url | ❌ | 文档 / 仓库主页（须 http/https，无账号密码） |

**npm 要求：**

- 公司私有包放在 `@zhongruan/`（或你们约定的 scope）；桥接把该 scope 指到公司 `npm/`
- 其它依赖走公网 mirror（桥接已处理），公司侧不必镜像整个 npm
- 包的 `engines.dsh` 或 peer `@deepseek-ai/dsh` 建议写好，否则 index 里会变成 `*`

### 2.3 不建议本期做的事

| 做法 | 原因 |
| --- | --- |
| 新开 `/api/sys/plugin/Market/*` 给桌面搜插件 | Host 市场协议已是 format 1 index；改协议 = 大改 UI/Host |
| 去掉本地桥、让 profile 直连公司 `index.json` | 可行但要改 profile 种子与 CORS/证书路径；**不是最少改动** |
| 把插件 tarball 改成自定义下载 API | 安装链路绑 npm registry；自定义要改 Host 安装器 |

### 2.4 运维发布流程（无新 API 也可）

1. `npm publish` 到公司 `dsh-plugins/npm/`（或私服再 rsync）
2. 更新 `plugins.json` 增加/改版本
3. 客户端下次刷新桥接缓存（约 60s TTL）即可看见

若以后要管理端可视化，可另做**后台改 `plugins.json` + 触发 publish**；终端契约仍是 2.2。

### 2.5 本章客户端改动量

| 项 | 改动量 |
| --- | --- |
| 托管 `plugins.json` + `@zhongruan` npm | **0** |
| 发现 / 安装 UI | **0**（已有插件市场 bundle + 桥） |

---

## 三、Cursor 写码用量上传公司服务器

### 3.1 现状与缺口

| 路径 | 现状 |
| --- | --- |
| 公司模型网关对话 | 已配置 `usageReportUrl` → `POST {gateway}/api/ai/Usage/Report`；失败入本地队列，成功后可 `Usage/Batch` 补报 |
| Cursor 写码（`dsh-cursor-chat` / `@cursor/sdk`） | **不走**公司网关补全；**今天不会**自动打到 `Usage/Report` |

因此：「写码用量上传公司服务器」= **复用现有用量接口** + **在写码插件侧补一次上报**（服务端尽量不改契约）。

权威字段与信封见 [`接口文档.md` §7](./接口文档.md)（以下与客户端 `UsageRecord` 对齐）。

### 3.2 服务端必做（多数已实现则只需验收）

**POST** `/api/ai/Usage/Report`  
**POST** `/api/ai/Usage/Batch`

请求头：

```
Authorization: Bearer <登录令牌>
Content-Type: application/json
Accept: application/json
```

若令牌含非 0 企业 CID，客户端还会在 `Accept` 追加 `enterprisecode$$<CID>`（段分隔按现网约定）。用户 ID **只信令牌**，不信 body 里的用户字段。

单条 body（Report）与 Batch 的 `records[]` 元素相同：

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "modelAlias": "cursor-agent",
  "inputTokens": 12000,
  "outputTokens": 3400,
  "costYuan": 0,
  "latencyMs": 58000,
  "status": "ok",
  "clientTs": 1760000000000
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| requestId | ✅ | 幂等键，≤64；重复不覆盖 |
| modelAlias | ✅ | ≤64；**不校验是否在模型目录**（写码用约定别名即可） |
| inputTokens / outputTokens | ✅ | ≥0 |
| costYuan | ✅ | ≥0；产品口径桌面侧固定 **0** |
| status | ✅ | `ok` / `error` / `aborted` |
| clientTs | ✅ | 毫秒时间戳 > 0 |
| latencyMs | ❌ | ≥0 |
| errorMessage | ❌ | ≤1000 |

成功：`FunctionResult`，`Success=true`；Report 的 `Datas` 为 `{ "ok": true }`；Batch 的 `Datas` 为 `{ "accepted": n, "duplicates": n }`。  
Batch：最多 500 条；有一条非法则整批不写。

> 文档旧评（2026-11-04）写 Batch「不对接」；**客户端现已实现队列 + Batch**（2026-11-11）。服务端 **Batch 必须可用**，否则离线补报清不掉队列。

### 3.3 写码用量约定（零服务端字段扩展的最少方案）

**不新增 URL。** 用 `modelAlias` 区分来源，后台报表按前缀过滤即可：

| modelAlias | 含义 |
| --- | --- |
| `standard` / `deep` 等 | 公司网关对话（现有） |
| `cursor-agent` | Cursor 本地 Agent 一轮写码 |
| `cursor-plan` | 若有独立 plan 调用可单列；否则并入 `cursor-agent` |

Token 取 Cursor / SDK 能拿到的 usage；拿不到且成功完成时：插件侧**不要**报全 0 的 ok（与网关侧「成功无 usage 则丢弃」一致）；失败可报 `status=error`、token 0。

鉴权：必须用**同一套公司登录令牌**（与网关会话同源）。插件进程若拿不到 Bearer，则本条不报（只打本地日志），避免匿名灌库。

### 3.4 可选增强（仅当报表强需求时）

若运营必须在库表区分「对话 / 写码」且不愿解析 `modelAlias` 前缀，再增加**可选**字段（客户端有则传，无则空）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| channel | string | 建议枚举：`gateway` \| `cursor`；缺省视为 `gateway` |

服务端：列可空；老客户端不传仍写入。这是**唯一**建议的 schema 增量；不要为此新开 `/api/ai/Usage/CursorReport`。

### 3.5 客户端 / 插件最小改动清单（本章唯一需要改代码的部分）

| 位置 | 改动 |
| --- | --- |
| `dsh-cursor-chat`（或写码完成钩子） | 任务结束构造与 `UsageRecord` 同形的 JSON，`POST` 到 `{ZR_MODEL_GATEWAY_URL}/api/ai/Usage/Report` |
| 令牌来源 | 复用 Host/桌面已存的网关 session（与 `GATEWAY_CREDENTIAL_REF` 同源）；禁止把厂商 Cursor Key 当 Bearer |
| 失败策略 | 401/403/400 不入队；网络/5xx 可复用 `%DSH_HOME%/usage-queue` + Batch（可直接依赖已有 `usage-report` 工具函数，避免再写一套） |
| 公司网关对话 | **不改** |

预估：插件侧一小段上报胶水即可；**MOM 服务端以验收 Report/Batch 为主**。

### 3.6 明确不做（减少噪音）

| 接口 | 本期 |
| --- | --- |
| `GET /api/ai/Usage/My` | 可选后台；桌面无面板则不接 |
| `Usage/Summary`、`GetUsageList` | 管理端专用；须先有角色校验，**不要**对普通桌面开放 |

---

## 四、接口 / 资源清单速览

### 4.1 终端已依赖（公司侧提供即可）

| # | 方法 | 资源 | 鉴权 | 用途 |
| --- | --- | --- | --- | --- |
| 1 | GET | `{feedBase}latest-windows.json` / `latest-macos.json` | ❌ | 查版本 |
| 2 | GET | `{feedBase}{artifact.file}` | ❌ | 下安装包 |
| 3 | GET | `{marketBase}plugins.json` | ❌ | 插件目录 |
| 4 | GET | `{marketBase}npm/**` | ❌ | 公司 npm 只读 |
| 5 | POST | `/api/ai/Usage/Report` | ✅ Bearer | 单条用量（含未来写码） |
| 6 | POST | `/api/ai/Usage/Batch` | ✅ Bearer | 批量补报 |

### 4.2 可选（运维 / 管理，终端不调用）

| # | 方法 | 路径建议 | 用途 |
| --- | --- | --- | --- |
| 7 | POST | `/api/sys/desktop/Package/Upload` | 无 SSH 时传安装包 |
| 8 | POST | `/api/sys/desktop/Package/Publish` | 写 latest JSON |
| 9 | GET | `/api/sys/desktop/Package/List` | 管理端列表 |
| 10 | （策略） | 强制升级 origin（附录 B） | 拦截过旧客户端 |

### 4.3 与第一期文档的差异（避免对接错）

| 第一期理想 | 第二期 / 现网 |
| --- | --- |
| `POST /api/usage/report` | `POST /api/ai/Usage/Report` |
| `POST /api/auth/login` | `POST /api/sys/user/UserLogin`（本期不改登录） |
| 升级未规划 | **静态 feed**，不是业务 REST |
| 插件市场未规划 | **`plugins.json` + npm`**，不是搜插件 REST |

---

## 五、验收清单（按章勾选）

### 升级

- [ ] `latest-windows.json` / `latest-macos.json` 可公网或内网 HTTPS 拉取
- [ ] `version` 抬高后，已装旧版客户端出现更新提示并能下完、校验 sha256
- [ ] 404 feed 时客户端不弹致命错
- [ ] 打包脚本 SCP（或可选 Upload/Publish）后 feed 与文件一致

### 插件市场

- [ ] `plugins.json` 合法；列出的 `@zhongruan/...` 在 `npm/` 可取 meta + tarball
- [ ] 打包客户端桥 `/health` 正常；Discover 能搜到并安装至少一个公司插件
- [ ] 非 `@zhongruan` 依赖仍可经桥走公网 mirror

### 写码用量

- [ ] 网关对话一条：`Usage/Report` 落库，`requestId` 可查
- [ ] `Usage/Batch` 接受合法数组；重复 `requestId` 计 `duplicates`
- [ ] 写码插件上报 `modelAlias=cursor-agent` 一条落库，用户/企业取自令牌
- [ ] 无令牌时不写匿名用量

---

## 附录 A：相关代码与文档

| 路径 | 用途 |
| --- | --- |
| `desktop/shell/apps/desktop/src/mom-update-feed.ts` | feed URL / 校验 / 比版本 |
| `desktop/shell/apps/desktop/src/mom-update-coordinator.ts` | 检查 / 下载 / 安装 |
| `desktop/update-feed.mjs` | 生成 feed + SCP |
| `desktop/update-upload.env.example` | 上传环境变量模板 |
| `scripts/company-market-bridge.mjs` | plugins.json → index + npm 代理 |
| `desktop/shell/apps/desktop/src/company-market.ts` | 启动桥、写 profile index |
| `desktop/shell/packages/llm/llm-pi-ai/src/usage-report.ts` | Report/Batch/队列 |
| `desktop/shell/apps/desktop/src/model-gateway.ts` | 写入 `usageReportUrl` |
| [`接口文档.md`](./接口文档.md) | 现网 sys/ai 契约 |
| [`2026-11-01-mom-server-integration-api.md`](./2026-11-01-mom-server-integration-api.md) | 第一期理想稿（路径勿再跟） |
| [`2026-10-29-cursor-chat-plugin-migration.md`](./2026-10-29-cursor-chat-plugin-migration.md) | 写码走 Cursor SDK、不经网关补全 |

## 附录 B：强制升级策略响应形（若启用）

与 JSON feed **分离**。客户端测例约定的业务形大致为：

- 不拦截：`{ "code": 0, "data": { "biz_code": 0, "biz_data": null } }`
- 拦截升级：`{ "code": 40005, "data": { "show_content": { "title", "detail" }, "desktop_app_link": "<https>" } }`
- 未登录策略源：HTTP 401 + `{ "error": { "code": "UNAUTHENTICATED" } }`

具体请求 URL 由安装包内 `dshMandatoryUpdatePolicy.origin` 决定；未配则整链关闭。

---

## 附录 C：推荐落地顺序

1. **静态升级目录 + 一次真机升版**（验证 feed，零代码）
2. **插件 `plugins.json` + 公司 npm**（验证市场，零代码）
3. **确认 `Usage/Report` + `Usage/Batch` 真机落库**（对话路径）
4. **插件补 Cursor 上报胶水**（本期唯一预期的产品代码改动）
5. （可选）管理端 Package Upload/Publish、强制升级策略、`channel` 字段
