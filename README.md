# dsh-mom

把 DeepSeek Harness 嵌进这个 Python 应用，作为 Agent 后端。程序通过官方 SDK 启动 `sdk-minimal` 配置，在隔离的工作目录里执行单条或批量任务。

## 环境

- Python 3.10 或更高版本
- `DEEPSEEK_API_KEY`

## 安装

```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]" -i https://pypi.tuna.tsinghua.edu.cn/simple
copy .env.example .env
```

把 `.env` 里的 `DEEPSEEK_API_KEY` 换成你自己的密钥。兼容端点可以再设置 `DEEPSEEK_BASE_URL`。

## 目录

| 路径 | 作用 |
| --- | --- |
| `workspace/` | Agent 的工作目录，对应 SDK 的 `cwd` |
| `var/dsh_home/` | 配置和会话存储，对应 SDK 的 `dsh_home`。程序不会读取 `~/.dsh` |

`sdk-minimal` 的 shell 能修改当前进程可见的任意路径。请在可以丢弃的目录中运行任务。

Windows 上，Python 轮子里的单文件运行时无法从虚拟目录加载 `conpty.node`，终端命令不会执行。本项目在 Windows 上改用与 SDK 同版本的官方 CLI `@deepseek-ai/dsh@0.2.1-rc.2`，原生模块放在真实磁盘路径上。安装：

```powershell
npm install --prefix vendor/dsh
```

这仍然通过 `DeepSeekHarness(profile="sdk-minimal")` 启动，只是 SDK 的 `DSH_RUNTIME_MODE=node` 会转到这个 CLI。程序不监听端口。

下面的命令都在项目根目录执行。

## 运行一条任务

```powershell
dsh-mom run "检查仓库并修复失败的测试" --session-id my-task-001
```

标准输出是 Agent 的最终回复。标准错误输出会话标识和结束原因。结束原因不是 `completed` 时，进程退出码为 1。

先确认配置，这一步不会请求模型：

```powershell
dsh-mom config
```

## 批量任务

`examples/tasks.jsonl` 每一行是一个任务：

```json
{"session_id":"my-task-001","prompt":"检查仓库并修复失败的测试"}
```

同一轮批量任务复用一个 Harness 进程：

```powershell
dsh-mom batch examples/tasks.jsonl
```

每条结果输出一行 JSON，包含 `session_id`、`finish_reason` 和 `final_response`。

## 在其他 Python 程序中调用

```python
from dsh_mom.agent import DshAgent
from dsh_mom.config import load_settings

agent = DshAgent(load_settings())
result = agent.run("检查仓库并修复失败的测试", session_id="my-task-001")
print(result.final_response)
```

`DshAgent` 内部按下面的方式创建 SDK 客户端：

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    cwd=str(workspace),
    dsh_home=str(dsh_home),
    profile="sdk-minimal",
) as harness:
    result = harness.run("检查仓库并修复失败的测试", session_id="my-task-001")
```

可继续用同一个 `session_id` 接着上一轮会话。换一件独立的事时，使用新的 `session_id`。

## 测试

```powershell
python -m pytest
```

单元测试使用假的 Harness，不会请求模型，也不会启动 `dsh`。
