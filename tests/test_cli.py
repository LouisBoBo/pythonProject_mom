import json
from pathlib import Path

import pytest

from dsh_mom.agent import TaskResult
from dsh_mom.cli import main, parse_batch_file
from dsh_mom.config import SettingsError, load_settings


class RecordingAgent:
    def __init__(self, settings: object) -> None:
        self.settings = settings
        self.single: tuple[str, str] | None = None
        self.batch: list[tuple[str, str]] | None = None

    def run(self, prompt: str, session_id: str) -> TaskResult:
        self.single = (prompt, session_id)
        return TaskResult(session_id=session_id, final_response="已完成", finish_reason="completed")

    def run_many(self, tasks: list[tuple[str, str]]) -> list[TaskResult]:
        self.batch = tasks
        return [
            TaskResult(session_id=session_id, final_response=f"ok:{prompt}", finish_reason="completed")
            for prompt, session_id in tasks
        ]


def _settings(tmp_path: Path):
    return load_settings(
        environ={"DEEPSEEK_API_KEY": "sk-test"},
        project_root=tmp_path,
        use_dotenv=False,
    )


def test_run_command_prints_final_response(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    created: list[RecordingAgent] = []

    def factory(settings: object) -> RecordingAgent:
        agent = RecordingAgent(settings)
        created.append(agent)
        return agent

    code = main(
        ["run", "检查仓库并修复失败的测试", "--session-id", "my-task-001"],
        settings=_settings(tmp_path),
        agent_factory=factory,
    )

    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == "已完成\n"
    assert "my-task-001" in captured.err
    assert "completed" in captured.err
    assert created[0].single == ("检查仓库并修复失败的测试", "my-task-001")


def test_run_command_exits_nonzero_when_turn_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    class ErrorAgent(RecordingAgent):
        def run(self, prompt: str, session_id: str) -> TaskResult:
            return TaskResult(session_id=session_id, final_response="失败", finish_reason="error")

    code = main(
        ["run", "做一件事", "--session-id", "bad-1"],
        settings=_settings(tmp_path),
        agent_factory=ErrorAgent,
    )

    assert code == 1
    assert capsys.readouterr().out == "失败\n"


def test_batch_command_reads_jsonl(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    batch_file = tmp_path / "tasks.jsonl"
    batch_file.write_text(
        "\n".join(
            [
                json.dumps({"session_id": "my-task-001", "prompt": "检查仓库并修复失败的测试"}, ensure_ascii=False),
                json.dumps({"session_id": "my-task-002", "prompt": "总结修改"}, ensure_ascii=False),
            ]
        ),
        encoding="utf-8",
    )
    created: list[RecordingAgent] = []

    def factory(settings: object) -> RecordingAgent:
        agent = RecordingAgent(settings)
        created.append(agent)
        return agent

    code = main(
        ["batch", str(batch_file)],
        settings=_settings(tmp_path),
        agent_factory=factory,
    )

    captured = capsys.readouterr()
    assert code == 0
    lines = [json.loads(line) for line in captured.out.splitlines()]
    assert lines[0]["session_id"] == "my-task-001"
    assert lines[0]["final_response"] == "ok:检查仓库并修复失败的测试"
    assert created[0].batch == [
        ("检查仓库并修复失败的测试", "my-task-001"),
        ("总结修改", "my-task-002"),
    ]


def test_parse_batch_file_rejects_bad_line(tmp_path: Path) -> None:
    batch_file = tmp_path / "tasks.jsonl"
    batch_file.write_text("{}\n", encoding="utf-8")

    with pytest.raises(SettingsError, match="第 1 行"):
        parse_batch_file(batch_file)


def test_config_command_hides_api_key(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["config"], settings=_settings(tmp_path))

    captured = capsys.readouterr()
    assert code == 0
    assert "sk-test" not in captured.out
    assert "sdk-minimal" in captured.out
    assert str((tmp_path / "workspace").resolve()) in captured.out


def test_batch_missing_file_returns_config_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        ["batch", str(tmp_path / "missing.jsonl")],
        settings=_settings(tmp_path),
        agent_factory=RecordingAgent,
    )

    assert code == 2
    assert "无法读取批处理文件" in capsys.readouterr().err
