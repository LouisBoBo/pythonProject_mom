from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dsh_mom.config import Settings, SettingsError

Task = tuple[str, str]
HarnessFactory = Callable[..., Any]

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass(frozen=True)
class TaskResult:
    session_id: str
    final_response: str
    finish_reason: str | None


def build_harness_options(settings: Settings) -> dict[str, Any]:
    """Build the keyword arguments for ``DeepSeekHarness``.

    The required fields follow the programmatic embedding example:
    official provider, flash model, isolated workspace, explicit home, and
    the ``sdk-minimal`` profile.
    """
    options: dict[str, Any] = {
        "provider": settings.provider,
        "model": settings.model,
        "cwd": str(settings.workspace),
        "dsh_home": str(settings.dsh_home),
        "profile": settings.profile,
        "initialize_timeout_seconds": settings.initialize_timeout_seconds,
    }
    if settings.api_key is not None:
        options["api_key"] = settings.api_key
    if settings.base_url is not None:
        options["base_url"] = settings.base_url
    if settings.max_tokens is not None:
        options["max_tokens"] = settings.max_tokens
    if settings.system_prompt is not None:
        options["env"] = {"DSH_SYSTEM_PROMPT": settings.system_prompt}
    return options


def default_harness_factory(**options: Any) -> Any:
    from deepseek_harness import DeepSeekHarness

    from dsh_mom.node_runtime import activate_node_runtime, bundled_bootstrap_path

    if os.name == "nt":
        application_root = Path(__file__).resolve().parents[2]
        if not (application_root / "pyproject.toml").is_file():
            application_root = Path.cwd()
        activate_node_runtime(application_root, bundled_bootstrap_path())
    return DeepSeekHarness(**options)


class DshAgent:
    """Runs tasks on one DeepSeek Harness process."""

    def __init__(self, settings: Settings, harness_factory: HarnessFactory | None = None) -> None:
        self.settings = settings.require_api_key()
        self._factory = harness_factory or default_harness_factory

    def run(self, prompt: str, session_id: str) -> TaskResult:
        return self.run_many([(prompt, session_id)])[0]

    def run_many(self, tasks: Sequence[Task]) -> list[TaskResult]:
        checked = [_check_task(prompt, session_id) for prompt, session_id in tasks]
        if not checked:
            raise SettingsError("没有可执行的任务。")
        self.settings.workspace.mkdir(parents=True, exist_ok=True)
        self.settings.dsh_home.mkdir(parents=True, exist_ok=True)
        results: list[TaskResult] = []
        with self._factory(**build_harness_options(self.settings)) as harness:
            for prompt, session_id in checked:
                raw = harness.run(prompt, session_id=session_id)
                results.append(
                    TaskResult(
                        session_id=getattr(raw, "session_id", session_id),
                        final_response=raw.final_response,
                        finish_reason=getattr(raw, "finish_reason", None),
                    )
                )
        return results


def _check_task(prompt: str, session_id: str) -> Task:
    if not isinstance(prompt, str) or not prompt.strip():
        raise SettingsError("prompt 不能为空。")
    if not isinstance(session_id, str) or _SESSION_ID.fullmatch(session_id) is None:
        raise SettingsError(
            "session_id 只能包含字母、数字、点、下划线和连字符，且不能为空。"
        )
    return prompt, session_id
