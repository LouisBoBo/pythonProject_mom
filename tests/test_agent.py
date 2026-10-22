from pathlib import Path

from dsh_mom.agent import DshAgent, build_harness_options
from dsh_mom.config import load_settings


class FakeResult:
    def __init__(self, prompt: str, session_id: str) -> None:
        self.final_response = f"done:{prompt}"
        self.finish_reason = "completed"
        self.session_id = session_id


class FakeHarness:
    instances: list["FakeHarness"] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.calls: list[tuple[str, str]] = []
        FakeHarness.instances.append(self)

    def __enter__(self) -> "FakeHarness":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def run(self, prompt: str, session_id: str | None = None) -> FakeResult:
        assert session_id is not None
        self.calls.append((prompt, session_id))
        return FakeResult(prompt, session_id)


def _settings(tmp_path: Path, **extra: str):
    environ = {"DEEPSEEK_API_KEY": "sk-test-key-1234", **extra}
    return load_settings(environ=environ, project_root=tmp_path, use_dotenv=False)


def test_harness_options_match_sdk_example(tmp_path: Path) -> None:
    settings = _settings(
        tmp_path,
        DEEPSEEK_BASE_URL="http://127.0.0.1:8000/v1",
        DSH_MAX_TOKENS="2048",
        DSH_SYSTEM_PROMPT="Be brief.",
    )

    options = build_harness_options(settings)

    assert options == {
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "cwd": str(settings.workspace),
        "dsh_home": str(settings.dsh_home),
        "profile": "sdk-minimal",
        "api_key": "sk-test-key-1234",
        "base_url": "http://127.0.0.1:8000/v1",
        "max_tokens": 2048,
        "initialize_timeout_seconds": 120,
        "env": {"DSH_SYSTEM_PROMPT": "Be brief."},
    }


def test_run_creates_isolated_dirs_and_returns_response(tmp_path: Path) -> None:
    FakeHarness.instances.clear()
    settings = _settings(tmp_path)
    agent = DshAgent(settings, harness_factory=FakeHarness)

    result = agent.run("检查仓库并修复失败的测试", session_id="my-task-001")

    assert result.session_id == "my-task-001"
    assert result.final_response == "done:检查仓库并修复失败的测试"
    assert result.finish_reason == "completed"
    assert settings.workspace.is_dir()
    assert settings.dsh_home.is_dir()
    assert FakeHarness.instances[0].kwargs["profile"] == "sdk-minimal"
    assert FakeHarness.instances[0].kwargs["cwd"] == str(settings.workspace)
    assert FakeHarness.instances[0].kwargs["dsh_home"] == str(settings.dsh_home)


def test_run_many_reuses_one_harness(tmp_path: Path) -> None:
    FakeHarness.instances.clear()
    agent = DshAgent(_settings(tmp_path), harness_factory=FakeHarness)

    results = agent.run_many(
        [
            ("检查仓库并修复失败的测试", "my-task-001"),
            ("总结修改", "my-task-002"),
        ]
    )

    assert len(FakeHarness.instances) == 1
    assert FakeHarness.instances[0].calls == [
        ("检查仓库并修复失败的测试", "my-task-001"),
        ("总结修改", "my-task-002"),
    ]
    assert [item.session_id for item in results] == ["my-task-001", "my-task-002"]
