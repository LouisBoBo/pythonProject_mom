from pathlib import Path

import pytest

from dsh_mom.config import SettingsError, load_settings


def test_defaults_match_programmatic_sdk_integration(tmp_path: Path) -> None:
    settings = load_settings(
        environ={"DEEPSEEK_API_KEY": "sk-test-key-1234"},
        project_root=tmp_path,
        use_dotenv=False,
    )

    assert settings.provider == "deepseek-official"
    assert settings.model == "deepseek-v4-flash"
    assert settings.profile == "sdk-minimal"
    assert settings.workspace == (tmp_path / "workspace").resolve()
    assert settings.dsh_home == (tmp_path / "var" / "dsh_home").resolve()
    assert settings.api_key == "sk-test-key-1234"
    assert settings.base_url is None
    assert settings.max_tokens is None
    assert settings.system_prompt is None
    assert settings.initialize_timeout_seconds == 120


def test_environment_overrides_paths_model_and_endpoint(tmp_path: Path) -> None:
    settings = load_settings(
        environ={
            "DEEPSEEK_API_KEY": "sk-abc",
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:8000/v1",
            "DSH_PROVIDER": "deepseek-official",
            "DSH_MODEL": "deepseek-v4-pro",
            "DSH_PROFILE": "sdk-minimal",
            "DSH_WORKSPACE": "custom-ws",
            "DSH_HOME": str(tmp_path / "home"),
            "DSH_MAX_TOKENS": "1024",
            "DSH_SYSTEM_PROMPT": "Be brief.",
            "DSH_INITIALIZE_TIMEOUT_SECONDS": "45",
        },
        project_root=tmp_path,
        use_dotenv=False,
    )

    assert settings.model == "deepseek-v4-pro"
    assert settings.workspace == (tmp_path / "custom-ws").resolve()
    assert settings.dsh_home == (tmp_path / "home").resolve()
    assert settings.base_url == "http://127.0.0.1:8000/v1"
    assert settings.max_tokens == 1024
    assert settings.system_prompt == "Be brief."
    assert settings.initialize_timeout_seconds == 45


def test_dotenv_fills_missing_keys_without_overriding_environment(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "# comment",
                "DEEPSEEK_API_KEY=from-file",
                "DSH_MODEL=from-file",
                'DSH_SYSTEM_PROMPT="quoted prompt"',
            ]
        ),
        encoding="utf-8",
    )

    settings = load_settings(
        environ={"DEEPSEEK_API_KEY": "from-env"},
        project_root=tmp_path,
    )

    assert settings.api_key == "from-env"
    assert settings.model == "from-file"
    assert settings.system_prompt == "quoted prompt"


def test_require_api_key_rejects_blank_key(tmp_path: Path) -> None:
    settings = load_settings(environ={}, project_root=tmp_path, use_dotenv=False)

    with pytest.raises(SettingsError, match="DEEPSEEK_API_KEY"):
        settings.require_api_key()


def test_invalid_max_tokens_raises(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="DSH_MAX_TOKENS"):
        load_settings(
            environ={"DEEPSEEK_API_KEY": "sk", "DSH_MAX_TOKENS": "nope"},
            project_root=tmp_path,
            use_dotenv=False,
        )


def test_non_finite_timeout_and_unsafe_base_url_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="DSH_INITIALIZE_TIMEOUT_SECONDS"):
        load_settings(
            environ={"DSH_INITIALIZE_TIMEOUT_SECONDS": "nan"},
            project_root=tmp_path,
            use_dotenv=False,
        )
    with pytest.raises(SettingsError, match="DEEPSEEK_BASE_URL"):
        load_settings(
            environ={"DEEPSEEK_BASE_URL": "file:///tmp/secret"},
            project_root=tmp_path,
            use_dotenv=False,
        )
    with pytest.raises(SettingsError, match="账号或密码"):
        load_settings(
            environ={"DEEPSEEK_BASE_URL": "https://user:secret@example.com/v1"},
            project_root=tmp_path,
            use_dotenv=False,
        )


def test_dotenv_accepts_export_prefix(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("export DEEPSEEK_API_KEY=from-file\n", encoding="utf-8")

    settings = load_settings(environ={}, project_root=tmp_path)

    assert settings.api_key == "from-file"
