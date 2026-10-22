from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


class SettingsError(ValueError):
    """Raised when application settings cannot be loaded or used."""


@dataclass(frozen=True)
class Settings:
    provider: str
    model: str
    profile: str
    workspace: Path
    dsh_home: Path
    api_key: str | None
    base_url: str | None
    max_tokens: int | None
    system_prompt: str | None
    initialize_timeout_seconds: float

    def require_api_key(self) -> Settings:
        if self.api_key is None or not self.api_key.strip():
            raise SettingsError("缺少 DEEPSEEK_API_KEY。请在环境变量或项目根目录的 .env 中设置。")
        return self

    def masked_api_key(self) -> str:
        if self.api_key is None or not self.api_key.strip():
            return "未设置"
        if len(self.api_key) <= 8:
            return "****"
        return f"{self.api_key[:4]}...{self.api_key[-4:]}"


def load_settings(
    environ: Mapping[str, str] | None = None,
    project_root: Path | None = None,
    *,
    use_dotenv: bool = True,
) -> Settings:
    """Load SDK launch settings.

    Existing environment variables win over the project ``.env`` file.
    Relative workspace and home paths resolve from ``project_root``.
    """
    root = (project_root or Path.cwd()).resolve()
    values = dict(os.environ if environ is None else environ)
    if use_dotenv:
        _apply_dotenv(root / ".env", values)

    timeout = _optional_positive_float(
        values.get("DSH_INITIALIZE_TIMEOUT_SECONDS"),
        "DSH_INITIALIZE_TIMEOUT_SECONDS",
    )
    return Settings(
        provider=_or_default(values.get("DSH_PROVIDER"), "deepseek-official"),
        model=_or_default(values.get("DSH_MODEL"), "deepseek-v4-flash"),
        profile=_or_default(values.get("DSH_PROFILE"), "sdk-minimal"),
        workspace=_resolve_path(values.get("DSH_WORKSPACE"), root, root / "workspace"),
        dsh_home=_resolve_path(values.get("DSH_HOME"), root, root / "var" / "dsh_home"),
        api_key=_blank_to_none(values.get("DEEPSEEK_API_KEY")),
        base_url=_optional_http_url(values.get("DEEPSEEK_BASE_URL"), "DEEPSEEK_BASE_URL"),
        max_tokens=_optional_positive_int(values.get("DSH_MAX_TOKENS"), "DSH_MAX_TOKENS"),
        system_prompt=_blank_to_none(values.get("DSH_SYSTEM_PROMPT")),
        initialize_timeout_seconds=120 if timeout is None else timeout,
    )


def _apply_dotenv(path: Path, values: dict[str, str]) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if not key or key in values:
            continue
        values[key] = _unquote(raw_value.strip())


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _or_default(value: str | None, default: str) -> str:
    text = "" if value is None else value.strip()
    return text or default


def _optional_http_url(raw: str | None, name: str) -> str | None:
    text = _blank_to_none(raw)
    if text is None:
        return None
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise SettingsError(f"{name} 必须是 http 或 https 地址，当前值是 {text!r}。")
    if parsed.username is not None or parsed.password is not None:
        raise SettingsError(f"{name} 不能在地址中携带账号或密码。")
    return text


def _blank_to_none(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value.strip()


def _resolve_path(raw: str | None, root: Path, default: Path) -> Path:
    text = "" if raw is None else raw.strip()
    if not text:
        return default.resolve()
    path = Path(text)
    if not path.is_absolute():
        path = root / path
    return path.resolve()


def _optional_positive_int(raw: str | None, name: str) -> int | None:
    number = _optional_number(raw, name, int)
    return None if number is None else int(number)


def _optional_positive_float(raw: str | None, name: str) -> float | None:
    return _optional_number(raw, name, float)


def _optional_number(raw: str | None, name: str, parser: type[int] | type[float]) -> int | float | None:
    if raw is None or not str(raw).strip():
        return None
    text = str(raw).strip()
    try:
        value = parser(text)
    except ValueError as exc:
        raise SettingsError(f"{name} 必须是正数，当前值是 {text!r}。") from exc
    if isinstance(value, float) and not math.isfinite(value):
        raise SettingsError(f"{name} 必须是正数，当前值是 {text!r}。")
    if value <= 0:
        raise SettingsError(f"{name} 必须是正数，当前值是 {text!r}。")
    return value
