# 企业差距客户端可改项 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。每完成一条必须跑指定测试并通过后才能进入下一条。

**目标：** 按《企业应用架构差距评估》中仍可动手的客户端项逐条落地，不碰服务端阻塞项，不引入新的启动/登录回归。

**架构：** 用量补报落在 Host 侧 `llm-pi-ai`（与现有 `Usage/Report` 同层）；弱 ValidateToken 仅做旁路探测不挡 admit；强制升级沿用现有 policy 模块补齐验收；Agent 工具策略只做最小白名单配置钩子。每条独立可测、可回滚。

**技术栈：** TypeScript、Vitest、Electron 桌面壳、`@deepseek-ai/dsh` Host、`llm-pi-ai`

**不做：** SSO、口令 MD5、默认强制 HTTPS（现网无 TLS）、服务端 UserLogout 修复、按企业裁剪模型集、SIEM。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `desktop/shell/packages/llm/llm-pi-ai/src/usage-queue.ts` | 本地用量失败队列的读写与裁剪（原子写） |
| `desktop/shell/packages/llm/llm-pi-ai/src/usage-report.ts` | 单条/批量上报；失败分类；带队列的 report+flush |
| `desktop/shell/packages/llm/llm-pi-ai/src/adapter.ts` | 调用带队列的上报；队列目录取自 `DSH_HOME` |
| `desktop/shell/packages/llm/llm-pi-ai/tests/usage-queue.spec.ts` | 队列单测 |
| `desktop/shell/packages/llm/llm-pi-ai/tests/usage-report.spec.ts` | 上报与 Batch/入队单测 |
| `desktop/shell/packages/llm/llm-pi-ai/tests/usage-report-adapter.spec.ts` | 适配器回归 |
| `desktop/shell/apps/desktop/src/main.ts` / `model-gateway.ts` | 弱 ValidateToken（可选旁路） |
| `docs/企业应用架构差距评估.md` | 勾选与状态更新 |

---

### 任务 1：用量失败入队 + Batch 补报

**文件：**
- 创建：`desktop/shell/packages/llm/llm-pi-ai/src/usage-queue.ts`
- 修改：`desktop/shell/packages/llm/llm-pi-ai/src/usage-report.ts`
- 修改：`desktop/shell/packages/llm/llm-pi-ai/src/adapter.ts`
- 测试：`desktop/shell/packages/llm/llm-pi-ai/tests/usage-queue.spec.ts`
- 测试：`desktop/shell/packages/llm/llm-pi-ai/tests/usage-report.spec.ts`
- 测试：`desktop/shell/packages/llm/llm-pi-ai/tests/usage-report-adapter.spec.ts`

**约束（必须遵守）：**
- 上报失败不得影响对话流（永不 throw 到 adapter 调用方）
- 队列只存 `UsageRecord`，**禁止**落盘 token
- 网络/5xx/超时 → 入队；鉴权类业务拒绝（如「当前登录用户无效」）→ **不入队**
- Batch 上限 500；队列上限 1000，超限丢最旧并打日志
- `accepted` 与 `duplicates` 的 `requestId` 都从队列移除
- 队列目录：`join(process.env.DSH_HOME, 'usage-queue')`；无 `DSH_HOME` 则不做落盘（仅内存可选，本任务直接跳过队列）

- [x] **步骤 1–8：用量队列 + Batch 补报**（2026-11-11 完成，相关 vitest 51/51）

---

### 任务 2：弱 ValidateToken（不挡进工作区）

**文件：**
- 修改：`desktop/shell/apps/desktop/src/main.ts`（admit 附近）
- 修改/测试：`desktop/shell/apps/desktop/tests/main-startup.spec.ts` 或现有 gateway 测

**约束：**
- admit 条件仍是：`localSessionActive && gatewayCredentialStored`
- ValidateToken 失败只打日志 / 可选清坏 token，**绝不**因此把用户拦回登录卡
- 成功路径零行为变化

- [ ] **步骤 1：写失败测试** — admit 在 token 校验失败时仍 resolve true（或现有 admit 语义）
- [ ] **步骤 2：实现旁路探测**
- [ ] **步骤 3：跑 `main-startup` / `welcome` / `model-gateway` 相关测**
- [ ] **步骤 4：Commit**

---

### 任务 3：强制升级策略可配置验收

**文件：** 现有 `mandatory-update-policy.ts` / 测试；必要时补文档说明

**约束：** 不改默认升级行为；只补齐「策略配置可读、测试覆盖、差距文档勾选」。

- [ ] **步骤 1：盘点现有 policy 测试是否已覆盖强制/可选**
- [ ] **步骤 2：缺口补测，不改生产默认**
- [ ] **步骤 3：Commit**

---

### 任务 4：Agent 工具策略（最小钩子）

**范围收紧：** 仅增加只读配置项与默认「不改变现网行为」的钩子；不做完整策略中心 UI。

- [ ] **步骤 1：确认现有工具/skill 入口是否已有 deny/allow 点**
- [ ] **步骤 2：若无低风险挂点则本任务降级为文档「需插件侧配合」并跳过代码**
- [ ] **步骤 3：有挂点则加默认放行的配置解析 + 单测**
- [ ] **步骤 4：Commit**

---

### 任务 5：更新差距评估文档

- [ ] 勾选清单 #5；刷新「本仓库现在就能改」表；注明验证命令与日期
- [ ] Commit

---

## 每条完成后的总验证门槛

1. 本条相关 vitest 全绿  
2. `git diff` 无无关文件  
3. 不修改默认网关 URL、不强制 HTTPS、不改登录成功路径语义  
4. 提交信息引用任务编号，例如 `fix(desktop): 用量失败入队与 Batch 补报 (gap-task-1)`
