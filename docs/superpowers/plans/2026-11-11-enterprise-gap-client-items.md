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

- [x] 2026-11-11 完成：`softValidateStoredGatewayToken` + admit 旁路；welcome/gateway 相关 40/40

### 任务 3：强制升级策略可配置验收

- [x] 2026-11-11 完成：现有 policy 测试 69/69 通过；不改生产默认；差距文档勾选

### 任务 4：Agent 工具策略（最小钩子）

- [x] 2026-11-11 降级：已有 permission preset；企业白名单待产品定策，本轮不改默认工具权限

### 任务 5：更新差距评估文档

- [x] 2026-11-11：清单 #5/#8–#11 与「可改」表已更新

---

## 每条完成后的总验证门槛

1. 本条相关 vitest 全绿  
2. `git diff` 无无关文件  
3. 不修改默认网关 URL、不强制 HTTPS、不改登录成功路径语义  
4. 提交信息引用任务编号，例如 `fix(desktop): 用量失败入队与 Batch 补报 (gap-task-1)`
