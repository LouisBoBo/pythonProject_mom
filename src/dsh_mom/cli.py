from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Protocol

from dsh_mom.agent import DshAgent, TaskResult
from dsh_mom.config import Settings, SettingsError, load_settings


class Agent(Protocol):
    def run(self, prompt: str, session_id: str) -> TaskResult: ...

    def run_many(self, tasks: list[tuple[str, str]]) -> list[TaskResult]: ...


AgentFactory = Callable[[Settings], Agent]


def main(
    argv: Sequence[str] | None = None,
    *,
    settings: Settings | None = None,
    agent_factory: AgentFactory | None = None,
) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    resolved = settings if settings is not None else load_settings()

    if args.command == "config":
        _print_config(resolved)
        return 0

    try:
        resolved.require_api_key()
        agent = (agent_factory or DshAgent)(resolved)
        if args.command == "run":
            result = agent.run(args.prompt, session_id=args.session_id)
            return _emit_single(result)
        try:
            tasks = parse_batch_file(Path(args.file))
        except OSError as exc:
            print(f"无法读取批处理文件：{exc.filename or args.file}", file=sys.stderr)
            return 2
        return _emit_batch(agent.run_many(tasks))
    except SettingsError as exc:
        print(str(exc), file=sys.stderr)
        return 2


def parse_batch_file(path: Path) -> list[tuple[str, str]]:
    """Read JSONL tasks shaped as ``{"session_id": "...", "prompt": "..."}``."""
    tasks: list[tuple[str, str]] = []
    for index, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SettingsError(f"第 {index} 行不是合法 JSON。") from exc
        if not isinstance(item, dict):
            raise SettingsError(f"第 {index} 行必须是 JSON 对象。")
        prompt = item.get("prompt")
        session_id = item.get("session_id")
        if not isinstance(prompt, str) or not prompt.strip():
            raise SettingsError(f"第 {index} 行缺少 prompt。")
        if not isinstance(session_id, str) or not session_id.strip():
            raise SettingsError(f"第 {index} 行缺少 session_id。")
        tasks.append((prompt, session_id))
    if not tasks:
        raise SettingsError("批处理文件没有任务。")
    return tasks


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsh-mom",
        description="把 DeepSeek Harness 作为 Agent 后端，执行单条或批量任务。",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="运行一条任务")
    run.add_argument("prompt", help="交给 Agent 的任务说明")
    run.add_argument("--session-id", required=True, help="可复用的会话标识")

    batch = commands.add_parser("batch", help="从 JSONL 文件批量运行任务")
    batch.add_argument("file", help="每行一个 {session_id, prompt} 对象")

    commands.add_parser("config", help="打印当前配置，API Key 会脱敏")
    return parser


def _print_config(settings: Settings) -> None:
    rows = {
        "provider": settings.provider,
        "model": settings.model,
        "profile": settings.profile,
        "workspace": str(settings.workspace),
        "dsh_home": str(settings.dsh_home),
        "base_url": settings.base_url or "未设置",
        "max_tokens": "未设置" if settings.max_tokens is None else str(settings.max_tokens),
        "api_key": settings.masked_api_key(),
    }
    for key, value in rows.items():
        print(f"{key}: {value}")


def _emit_single(result: TaskResult) -> int:
    print(result.final_response)
    print(
        f"session_id={result.session_id} finish_reason={result.finish_reason}",
        file=sys.stderr,
    )
    return 0 if result.finish_reason == "completed" else 1


def _emit_batch(results: Sequence[TaskResult]) -> int:
    for result in results:
        print(
            json.dumps(
                {
                    "session_id": result.session_id,
                    "finish_reason": result.finish_reason,
                    "final_response": result.final_response,
                },
                ensure_ascii=False,
            )
        )
    return 0 if results and all(item.finish_reason == "completed" for item in results) else 1
