# 对话写码功能移植方案：dsh-mom → dsh-cursor-chat 插件

> 状态：规划完成，未实施  
> 日期：2026-10-29  
> 源仓库：`pythonProject_dsh_mom/apps/zr-workbuddy/engine/app/code_dev/`（Python FastAPI 写码引擎）  
> 目标插件：`pythonProject_dsh_plugin/plugins/dsh-cursor-chat/`（TypeScript DSH Cordis 插件）  
> 宿主工程：`pythonProject_mom`（Electron 桌面壳 + Node.js DSH Host）  
> 结论：**可行。mom 只需机械性安装，全部写码业务逻辑落在插件内。**

---

## 0. 核心决策

| 决策 | 内容 |
|---|---|
| 移植方向 | 把 **dsh-mom Python code_dev 模块**的独有功能（删除流水线、挂载验尸、围栏解析、脱敏）移植到 **dsh-cursor-chat TypeScript 插件** |
| AI 引擎 | 继续使用 `@cursor/sdk@1.0.31`（npm，Cursor 官方 Local Agent），**不换**公司模型网关 |
| mom 壳职责 | 零写码业务逻辑，仅负责：装 npm 依赖 → 拷插件产物 → `cordis.patch.yml` 声明 → `shell-manifest.txt` 注册 |
| mom 壳零业务 | 不嵌 Python 子进程、不写 HTTP 路由、不管理 Job、不处理沙箱 |
| 写码功能归属 | **100% 在 dsh-cursor-chat 插件内部完成** |
| 交付形态 | mom 用户安装 dsh-cursor-chat 插件 → Host 自动加载 → 对话写码立即可用 |

---

## 1. 三项目架构对比

| 维度 | dsh-mom（源） | dsh-cursor-chat 插件（目标） | mom（宿主） |
|---|---|---|---|
| 语言 | Python | **TypeScript** | TypeScript |
| 框架 | FastAPI 独立服务 | **DSH Cordis 插件** | **DSH Cordis Host** |
| AI 引擎 | `from cursor_sdk import Agent`（pip） | `import { Agent } from '@cursor/sdk'`（npm） | 公司模型网关（仅用于对话/Agent，写码走 Cursor） |
| HTTP 路由 | `main.py` 手写 | 插件 `server.ts` 自动挂载 | Host 路由自动合并 |
| Job 管理 | SQLite + JSONL | **已有** jobs.ts + diskStore.ts | 无 |
| 沙箱 | Python `shutil` + `filecmp` | **已有** sandbox.ts（更完善） | 无 |
| HITL | nonce 签名 | **已有** hitl.ts | 无 |
| 插件格式 | 无 | `cordis.patch.yml` + `package.json dsh.bundle.patch` | **同样格式** |

**关键洞察**：dsh-cursor-chat 插件**本身就是一个 DSH Cordis 插件**——它的目录结构、`cordis.patch.yml` 声明、package.json、npm 依赖风格，和 mom Host 加载的所有其他插件完全一致。移植不是"把 Python 重写成 TS"，而是"把 mom Python 里独有的几个模块写进已有的 TS 插件"。

---

## 2. mom 壳 vs 插件职责边界

```
┌─────────────────────────────────────────────┐
│  mom Electron 壳                            │
│                                              │
│  ✅ 装 npm 依赖（@cursor/sdk + 传递依赖）     │
│  ✅ 拷插件编译产物进打包目录                  │
│  ✅ cordis.patch.yml 声明插件存在             │
│  ✅ shell-manifest.txt 注册新增文件           │
│                                              │
│  ❌ 没有任何写码业务逻辑                      │
│  ❌ 没有 Python 子进程                       │
│  ❌ 没有 HTTP 路由挂载逻辑                   │
│  ❌ 不管理 Job / 沙箱 / HITL                 │
└─────────────────────────────────────────────┘
          │ Host 启动时 runProfile() 自动加载插件
          ▼
┌─────────────────────────────────────────────┐
│  dsh-cursor-chat 插件（全部写码功能）         │
│                                              │
│  • HTTP 路由  /api/cursor-chat/*             │
│              /api/hitl/*                    │
│  • 意图识别（写码 / 删除）                    │
│  • 需求讨论 + 多轮 Brief                      │
│  • 确认卡 + HITL nonce                        │
│  • 沙箱准备 + 父沙箱复用                      │
│  • Cursor Agent 调用（@cursor/sdk）          │
│  • 删除三路流水线（engine_first/cursor_plan/ │
│                  cursor_full）                │
│  • 快照 diff + 范围内/外 partition            │
│  • 删除后验尸（菜单/路由/orphan grep）        │
│  • API 挂载验尸 + 菜单挂载验尸                │
│  • 同步回原工程 + 同步验尸                    │
│  • Vite nudge + soft restart                 │
│  • SSE 流式进度 + 脱敏                        │
│  • Jobs 持久化 + cancel + steer               │
│  • 前端 client bundle（工具卡 UI）            │
│  • 图片多模态输入（插件独有，mom 没有）        │
└─────────────────────────────────────────────┘
```

---

## 3. 完整功能 Diff（mom 有 vs 插件有）

### 3.1 插件已具备（不移植）

| # | 功能 | mom 模块 | 插件等价模块 |
|---|---|---|---|
| 1 | 沙箱稀疏拷贝 + 父沙箱复用 | `sandbox.py` | `src/sandbox.ts`（prepareSandboxForJob + prepareSandboxReuse）**更完善** |
| 2 | 快照 diff + changed/deleted 提取 | `fs_snapshot.py` | `src/sandbox.ts`（snapshotSandbox） |
| 3 | 范围内/外 partition + scopeCompanions | `path_scope.py` | `src/pathScope.ts` + `src/scopeCompanions.ts` |
| 4 | HITL nonce issue/consume | `hitl/` + `main.py` | `src/hitl.ts` |
| 5 | Jobs 持久化 + cancel + steer + claim | `jobs.py` | `src/jobs.ts` + `src/diskStore.ts` |
| 6 | Config 加载/保存/脱敏 | `config.py` | `src/config.ts` |
| 7 | Workspace 校验 | `workspace.py` | `src/localAccess.ts` |
| 8 | 需求讨论 + 多轮 Brief | `brief.py` + `discuss.py` | `src/requirementGate.ts` + `src/clarifyFlow.ts` |
| 9 | Cursor SDK Agent 调用 + Prompt 构造 | `cursor_agent.py` | `src/cursor/runner.ts`（同名同思路） |
| 10 | Vite 热更新触发 | `vite_reload.py` | `src/viteNudge.ts` |
| 11 | 流式 DialogBus + transcript | 无 | `src/cursor/runner.ts DialogBus`（插件独有） |
| 12 | 图片多模态输入 | 无 | `src/images.ts`（插件独有） |

### 3.2 插件缺失（必须移植）

| # | 功能 | mom 模块 | 插件新模块 | 难度 | 阶段 |
|---|---|---|---|---|---|
| A | **删除意图识别**（is_delete_intent + extract_delete_features） | `brief.py` + `delete_verify.py` | `src/deleteIntent.ts`（新建） | 🟡 中 | 1 |
| B | **删除预检**（Cursor 启动前扫描目标工程） | `delete_preflight.py` | `src/deletePreflight.ts`（新建） | 🟡 中 | 1 |
| C | **Cursor 删除清单解析**（parse_delete_plan_from_text + 高置信校验） | `delete_enforce.py` | `src/cursor/runner.ts`（新增函数） | 🟠 大 | 1 |
| D | **引擎兜底删除**（Cursor 清单为空时用规则匹配：Vue 页标题 token + API 路由名 + 菜单 config key） | `delete_enforce.py plan_delete_file_targets + reconcile_delete_artifacts` | `src/deleteEnforce.ts`（新建） | 🔴 最大缺口 | 1 |
| E | **删除后置验尸**（grep 菜单/路由/orphan/探针路径） | `delete_verify.py verify_delete_on_target` | `src/deleteVerify.ts`（新建） | 🔴 最大缺口 | 1 |
| F | **删除专属三路流水线**（engine_first / cursor_plan / cursor_full） | `service.py` delete 分支 527-913 行 | `orchestrator/runJob.ts` 重写 executeJob | 🔴 大 | 1 |
| G | **API Router 挂载验尸**（新路由文件必须被 import 进 main.py） | `api_verify.py verify_api_mounted_on_target` | `src/apiVerify.ts`（新建） | 🟡 中 | 2 |
| H | **菜单/报表挂载验尸**（deferred wiring blockers） | `menu_verify.py verify_add_menu_on_target + deferred_wiring_blockers` | `src/menuVerify.ts`（新建） | 🟠 大 | 2 |
| I | **围栏解析**（:::cursor_dev_options / :::cursor_dev_propose） | `fence.py parse_machine_blocks` | `src/fence.ts`（新建） | 🟢 小 | 3 |
| J | **SSE payload 脱敏**（隐藏 stream_token / 压缩文本） | `public_redact.py redact_job_public + redact_sse_payload` | `server.ts` 中间件 | 🟢 小 | 3 |
| K | **Vite soft restart**（比 nudge 更彻底的热更新） | `vite_reload.py soft_restart_vite` | `viteNudge.ts` 扩展 | 🟢 小 | 3 |

---

## 4. 分阶段实施计划

### 阶段 0：装插件到 mom（机械性，0.5 天）

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| 0.1 | mom 的 pnpm workspace 里装 `@cursor/sdk@1.0.31` + 传递依赖 | `desktop/shell/package.json` 或 Host package.json |
| 0.2 | `pnpm build` dsh-cursor-chat → 把 `lib/` + `package.json` + `cordis.patch.yml` + `compat-matrix.json` 拷进 mom 的插件目录 | 待定（先确认 mom 打包时插件目录在哪） |
| 0.3 | mom 的 `cordis.patch.yml` 加一行插件声明 | mom 运行时 profile 的 `cordis.patch.yml` |
| 0.4 | `shell-manifest.txt` 注册所有新增文件 | `desktop/shell-manifest.txt` |
| 0.5 | `package-macos.sh` 打包 → 启动验证 Host 加载插件 + `/api/cursor-chat/*` 路由可访问 | 验证步骤 |

**前置验证（动手前必须跑，30 分钟）**：
- [ ] mom node_modules 能装 `@cursor/sdk@1.0.31` 吗？（pnpm install 试一下）
- [ ] 包从哪个 registry 拉？（插件 publishConfig 是 `http://175.178.238.31/dsh-plugins/npm/`）
- [ ] `apply-product-overlay.mjs` 会不会把新 npm 依赖带进 asar？

### 阶段 1：删除流水线（最大缺口，1.5 天）

插件目前的"删除"只是普通写码 diff 同步的副产品（`sandbox.applyDeletesToTarget`），没有 mom 完整的**删除专属流水线**。这是最值钱的能力。

| 新建文件 | 内容 | 移植来源 |
|---|---|---|
| `src/deleteIntent.ts` | 删除意图识别（is_delete_intent）+ 功能名提取（extract_delete_features）：从"报表中心菜单删除设备维修、设备保养报表"里抽出待删功能名列表 | mom `brief.py` + `delete_verify.py` |
| `src/deletePreflight.ts` | Cursor 启动前先扫描目标工程：目标文件是否已消失？菜单 key 是否还在？已消失则跳过 Cursor 调用 | mom `delete_preflight.py audit_delete_target` |
| `src/deleteEnforce.ts` | **引擎兜底删除核心**：<br>① 规则匹配待删文件（Vue 页：文件名 token + 页标题双重命中；API：import 语句 grep；菜单：config key + catalog grep）<br>② 自动修补 AppLayout.vue 删除菜单引用<br>③ 自动修补 router/index.js 删除路由 import<br>④ reconcile_delete_artifacts 清理删除残留 | mom `delete_enforce.py` 全文 |
| `src/deleteVerify.ts` | **删除后置验尸**：<br>① 菜单 config grep 是否还有待删功能 key<br>② router 文件 import 了待删路由模块吗<br>③ orphan 页面文件还残留吗<br>④ 探针路径（如 `/api/设备维修`）是否还命中<br>⑤ 不通过则 raise 阻断删除成功 | mom `delete_verify.py verify_delete_on_target` |

| 修改文件 | 改什么 |
|---|---|
| `src/cursor/runner.ts` | 新增 `parseDeletePlanFromText()` + `validateDeletePlan()`：从 Cursor 输出里提取删除清单，校验高置信（Vue 页面需文件名 token + 页标题双重命中） |
| `orchestrator/runJob.ts` | **重写 executeJob 入口**：<br>① 判断 delete intent<br>② delete_mode 分支配置（cursor_plan / engine_first / cursor_full）<br>③ 每路 preflight → agent → reconcile → verify → sync → final_delivery |

### 阶段 2：挂载验尸 + deferred 阻断（1 天）

**这两个验尸是 mom 写码流水线的硬门禁**：Cursor 写完说"我加了个新 API / 新菜单"，但如果没在 `main.py` import 路由、没在 `AppLayout.vue` 加菜单 key、没在 catalog 注册——Cursor 认为成功，用户看不到。mom 会在 sync 之后**自动 grep 原工程确认**，不通过就 raise。

| 新建文件 | 内容 | 移植来源 |
|---|---|---|
| `src/apiVerify.ts` | **API Router 挂载验尸**：<br>① 新 backend router 文件是否真的被 import 进 `main.py` 或 `api/__init__.py`<br>② 正则 grep import 语句 + AST 风格匹配<br>③ 未注册则阻断 | mom `api_verify.py verify_api_mounted_on_target` |
| `src/menuVerify.ts` | **菜单/报表挂载验尸**：<br>① deferred scope 里的 router/layout/config 文件必须提升为同步<br>② catalog 注册检查<br>③ `menu: false` 等不可见条件<br>④ 失败条件汇总为 deferred_wiring_blockers | mom `menu_verify.py verify_add_menu_on_target + deferred_wiring_blockers` |

### 阶段 3：围栏 + 脱敏 + 小改进（0.5 天）

| 新建/修改 | 内容 | 来源 |
|---|---|---|
| `src/fence.ts`（新建） | `parseMachineBlocks()` 解析 `:::cursor_dev_options` / `:::cursor_dev_propose` 围栏语法，提取 options/propose + 清理残留围栏文本 | mom `fence.py parse_machine_blocks` |
| `server.ts`（修改） | SSE 输出前脱敏中间件：隐藏 stream_token、压缩 message 字段长度 | mom `public_redact.py redact_sse_payload` |
| `src/viteNudge.ts`（扩展） | `softRestartVite()`：比 nudge 更彻底的 Vite 热更新（kill + restart dev server） | mom `vite_reload.py soft_restart_vite` |

### 阶段 4：端到端验证 + bug 修复（0.5 天）

| 测试用例 | 预期 |
|---|---|
| 非删除写码：新增 Vue 页面 + API | Cursor Agent 在沙箱写文件 → diff → sync 回原工程 → vite nudge → 页面可见 |
| 删除写码：删除报表菜单 + 关联 API | preflight → Cursor / 引擎 → 删除验尸 grep → sync → 菜单消失 |
| 新增 API Router | apiVerify 验尸 → 未注册则阻断 → 提示需要 import |
| 新增菜单 | menuVerify 验尸 → deferred wiring 阻断 → 提示需要提升路由文件 |
| 多轮续改 | 父沙箱复用 → 增量 diff → 验尸 |

---

## 5. 工作量汇总

| 阶段 | 内容 | 预估 |
|---|---|---|
| 0 | 装插件到 mom（npm 依赖 + patch + manifest + 打包验证） | **0.5 天** |
| 1 | 删除流水线（6 个新建/重写文件，最大缺口） | **1.5 天** |
| 2 | 挂载验尸（2 个新建文件 + deferred 阻断集成） | **1 天** |
| 3 | 围栏 + 脱敏 + soft-restart | **0.5 天** |
| 4 | 端到端验证 + bug 修复 | **0.5 天** |
| **合计** | | **~4.5 天** |

---

## 6. 风险与前置条件

| 风险 | 严重度 | 对策 |
|---|---|---|
| mom 的 node_modules 能装 `@cursor/sdk@1.0.31` 吗？ | 🔴 必须先验证 | 阶段 0 前置验证，pnpm install 试一下 |
| `@cursor/sdk` registry 来源？（Cursor 官方 vs 公司内网） | 🔴 必须先验证 | mom 有没有 `.npmrc`？插件 publishConfig 是 `http://175.178.238.31/dsh-plugins/npm/` |
| 打包后 Host 会丢失新 npm 包吗？ | 🔴 必须先验证 | `apply-product-overlay.mjs` 怎么处理 node_modules？asar 打包策略？ |
| 插件 Cordis 版本（^4.0.2）与 mom Host Cordis 版本兼容吗？ | 🟡 | 查 mom Host 的 `@deepseek-ai/cordis` 版本 |
| 删除流水线里 Python AST 解析（api_verify 用了 Python AST grep main.py）→ 移植到 TS 用什么？ | 🟡 | TS 里用正则 grep import 语句即可（不需要完整 AST），足够覆盖 99% 场景 |
| mom 工程既有 `shell-manifest.txt` 注册新文件时漏了？ | 🟢 机械性 | 写个 checklist：插件 lib/ 下每个文件都要进 manifest |

---

## 7. mom 壳改动最小清单（阶段 0 之后不再改）

**阶段 0 改完后，mom 壳再也不动**——后续所有功能迭代都只改插件。

| 文件 | 改动 | 阶段 |
|---|---|---|
| `desktop/shell/package.json` 或 Host package.json | 加 `@cursor/sdk@1.0.31` dependencies | 0 |
| `cordis.patch.yml`（mom runtime profile） | 加一行插件声明 | 0 |
| `desktop/shell-manifest.txt` | 注册所有插件产物文件 | 0 |
| mom 运行时插件目录 | 拷入插件编译产物 | 0 |

---

## 8. 插件改动清单（全部业务逻辑）

### 新建文件

| 文件 | 阶段 | 行数估计 | 移植来源 |
|---|---|---|---|
| `src/deleteIntent.ts` | 1 | ~150 | mom brief.py + delete_verify.py |
| `src/deletePreflight.ts` | 1 | ~120 | mom delete_preflight.py |
| `src/deleteEnforce.ts` | 1 | ~400 | mom delete_enforce.py |
| `src/deleteVerify.ts` | 1 | ~350 | mom delete_verify.py |
| `src/apiVerify.ts` | 2 | ~120 | mom api_verify.py |
| `src/menuVerify.ts` | 2 | ~200 | mom menu_verify.py |
| `src/fence.ts` | 3 | ~80 | mom fence.py |

### 修改文件

| 文件 | 阶段 | 改动内容 |
|---|---|---|
| `src/cursor/runner.ts` | 1 | 新增 parseDeletePlanFromText + validateDeletePlan 函数 |
| `orchestrator/runJob.ts` | 1 | executeJob 入口重写：delete intent 判断 + delete_mode 三路分支 |
| `server.ts` | 3 | SSE 脱敏中间件 |
| `src/viteNudge.ts` | 3 | 新增 softRestartVite 函数 |

---

## 9. 参考资料

| 文档 | 路径 |
|---|---|
| mom 模型网关接入方案 | `docs/superpowers/plans/2026-10-28-model-gateway-integration.md` |
| mom 登录方案 | `docs/superpowers/plans/2026-10-23-platform-login.md` |
| mom 源码 code_dev 模块 | `pythonProject_dsh_mom/apps/zr-workbuddy/engine/app/code_dev/` |
| dsh-cursor-chat 插件源码 | `pythonProject_dsh_plugin/plugins/dsh-cursor-chat/src/` |
| 功能实现设计文档 | `Framework/docs/功能实现/P0-1-本机写码功能实现.md` |
| Cursor SDK | npm `@cursor/sdk@1.0.31` |
