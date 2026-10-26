"""Read database settings from files in one workspace.

Print a single JSON object to stdout. Passwords stay in that JSON so the
caller can connect; this script does not open a database.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "vendor",
    "__pycache__",
    ".desktop-build",
    ".pnpm-store",
    "var",
}
TEXT_SUFFIXES = {
    ".py",
    ".pyi",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".vue",
    ".java",
    ".kt",
    ".go",
    ".php",
    ".rb",
    ".cs",
    ".yml",
    ".yaml",
    ".json",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".env",
    ".xml",
    ".md",
    ".txt",
    ".sh",
    ".ps1",
}
MAX_DEPTH = 16
MAX_FILES = 8000
MAX_BYTES = 512_000
DEFAULT_ENGINE_BY_PORT = {3306: "mysql", 5432: "postgres", 1433: "sqlserver", 1521: "oracle"}

URL_KEYS = {
    "database_url",
    "db_url",
    "jdbc_url",
    "sqlalchemy_database_uri",
    "spring_datasource_url",
    "spring_datasource_jdbc_url",
    "datasource_url",
    "datasource_jdbc_url",
}
HOST_KEYS = {
    "db_host",
    "database_host",
    "mysql_host",
    "postgres_host",
    "pghost",
    "spring_datasource_host",
    "datasource_host",
}
PORT_KEYS = {
    "db_port",
    "database_port",
    "mysql_port",
    "postgres_port",
    "pgport",
    "spring_datasource_port",
    "datasource_port",
}
NAME_KEYS = {
    "db_name",
    "database_name",
    "mysql_database",
    "postgres_db",
    "pgdatabase",
    "spring_datasource_database",
    "spring_datasource_name",
    "datasource_database",
    "datasource_name",
}
USER_KEYS = {
    "db_user",
    "db_username",
    "database_user",
    "database_username",
    "mysql_user",
    "mysql_username",
    "postgres_user",
    "pguser",
    "spring_datasource_username",
    "spring_datasource_user",
    "datasource_username",
    "datasource_user",
}
PASSWORD_KEYS = {
    "db_password",
    "database_password",
    "mysql_password",
    "postgres_password",
    "pgpassword",
    "spring_datasource_password",
    "datasource_password",
}
BARE_KEYS = {
    "host": "host",
    "hostname": "host",
    "port": "port",
    "database": "database",
    "dbname": "database",
    "username": "username",
    "user": "username",
    "password": "password",
    "url": "url",
    "jdbc_url": "url",
}
JDBC_RE = re.compile(
    r"jdbc:(mysql|mariadb|postgresql|postgres|sqlserver|oracle|sqlite):([^\s'\"<>]+)",
    re.IGNORECASE,
)
GENERIC_URL_RE = re.compile(
    r"\b((?:mysql|mariadb|postgresql|postgres|sqlite)(?:\+\w+)?://[^\s'\"<>]+)",
    re.IGNORECASE,
)
ENV_LINE_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$")
YAML_LINE_RE = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$")
PROP_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$")


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "local", "host.docker.internal"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Find workspace database settings")
    parser.add_argument("--workspace", default=".", help="Workspace directory to scan")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    if not workspace.is_dir():
        print(f"工作区不存在：{workspace}", file=sys.stderr)
        return 2
    payload = find_configs(workspace)
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


def find_configs(workspace: Path) -> dict[str, object]:
    found: list[dict[str, object]] = []
    deploys: list[dict[str, object]] = []
    scanned = 0
    for path in iter_candidate_files(workspace):
        scanned += 1
        if scanned > MAX_FILES:
            break
        text, values = read_file(workspace, path)
        if text is None or values is None:
            continue
        found.extend(configs_from_text(workspace, path, text, values))
        target = deploy_target(workspace, path, values)
        if target is not None:
            deploys.append(target)
    real = [item for item in found if not item.pop("_example")]
    chosen = real if real else found
    servers: list[dict[str, object]] = []
    locals_: list[dict[str, object]] = []
    skipped_local = 0
    for item in chosen:
        kind = connection_kind(item)
        if kind == "server":
            servers.append(item)
        else:
            if kind == "local":
                skipped_local += 1
                locals_.append(item)
            else:
                item.pop("_rank", None)
    if not servers:
        servers.extend(remote_sqlite_configs(workspace, locals_, deploys))
    servers.sort(key=lambda item: (int(item.pop("_rank")), str(item["source"])))
    for item in locals_:
        item.pop("_rank", None)
    return {"configs": servers, "skipped_local": skipped_local}


def iter_candidate_files(workspace: Path):
    for directory, dir_names, file_names in os.walk(workspace):
        current = Path(directory)
        depth = len(current.relative_to(workspace).parts)
        dir_names[:] = [name for name in dir_names if name not in SKIP_DIRS]
        if depth > MAX_DEPTH:
            dir_names[:] = []
            continue
        for name in file_names:
            path = current / name
            if is_candidate(path):
                yield path


def is_candidate(path: Path) -> bool:
    name = path.name.lower()
    if name.startswith(".env"):
        return True
    return path.suffix.lower() in TEXT_SUFFIXES


def read_file(workspace: Path, path: Path) -> tuple[str | None, dict[str, str] | None]:
    try:
        resolved = path.resolve()
        resolved.relative_to(workspace)
        if resolved.stat().st_size > MAX_BYTES:
            return None, None
        text = resolved.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError, ValueError):
        return None, None
    return text, parse_values(path, text)


def configs_from_text(
    workspace: Path,
    path: Path,
    text: str,
    values: dict[str, str],
) -> list[dict[str, object]]:
    configs: list[dict[str, object]] = []
    urls = collect_urls(text, values)
    if urls:
        for raw_url in urls:
            configs.append(config_from_url(workspace, path, raw_url, values))
    else:
        built = config_from_fields(workspace, path, values)
        if built is not None:
            configs.append(built)
    return [item for item in configs if item.get("engine") or item.get("host") or item.get("database")]


def deploy_target(workspace: Path, path: Path, values: dict[str, str]) -> dict[str, object] | None:
    host = values.get("ssh_host") or values.get("deploy_host")
    app_path = values.get("ssh_app_path") or values.get("app_path") or values.get("remote_path") or ""
    entry = values.get("entry_url") or values.get("health_url") or ""
    if not host and entry.startswith("http"):
        host = urlparse(entry).hostname
    if not isinstance(host, str) or not safe_server_host(host) or not safe_ssh_user(values.get("ssh_user")):
        return None
    relative = path.relative_to(workspace).as_posix()
    lowered = relative.lower()
    if not app_path and "deploy" not in lowered and "workbuddy" not in lowered:
        return None
    return {
        "source": relative,
        "host": host,
        "port": parse_port(values.get("ssh_port")) or 22,
        "user": values.get("ssh_user"),
        "app_path": app_path.rstrip("/"),
        "rank": len(path.relative_to(workspace).parts),
    }


def remote_sqlite_configs(
    workspace: Path,
    locals_: list[dict[str, object]],
    deploys: list[dict[str, object]],
) -> list[dict[str, object]]:
    if not deploys:
        return []
    deploy = min(deploys, key=lambda item: (int(item["rank"]), str(item["source"])))
    chosen: dict[str, dict[str, object]] = {}
    for item in sorted(locals_, key=source_rank):
        if str(item.get("engine") or "") != "sqlite":
            continue
        relative = locate_sqlite(workspace, item)
        if relative is None or relative in chosen:
            continue
        if "/tests/" in f"/{relative}/" or relative.startswith("tests/"):
            continue
        app_path = str(deploy["app_path"])
        remote_path = f"{app_path}/{relative}" if app_path else relative
        if not safe_remote_path(remote_path):
            continue
        chosen[relative] = {
            "source": f"{deploy['source']} + {item['source']}",
            "engine": "sqlite",
            "host": deploy["host"],
            "port": deploy["port"],
            "database": remote_path,
            "username": deploy["user"],
            "password": None,
            "url": None,
            "via": "ssh",
            "_rank": int(deploy["rank"]) - 30,
        }
    return list(chosen.values())


def locate_sqlite(workspace: Path, item: dict[str, object]) -> str | None:
    raw = str(item.get("database") or "").replace("\\", "/")
    name = Path(raw).name
    if not name or name.startswith(":memory"):
        return None
    matches: list[str] = []
    for directory, dir_names, file_names in os.walk(workspace):
        current = Path(directory)
        depth = len(current.relative_to(workspace).parts)
        dir_names[:] = [dir_name for dir_name in dir_names if dir_name not in SKIP_DIRS]
        if depth > MAX_DEPTH:
            dir_names[:] = []
            continue
        if name in file_names:
            relative = (current / name).relative_to(workspace).as_posix()
            if "/tests/" in f"/{relative}/" or relative.startswith("tests/"):
                continue
            matches.append(relative)
    if not matches:
        return None
    source = str(item.get("source") or "")
    matches.sort(key=lambda relative: (0 if source.startswith(str(Path(relative).parent)) else 1, len(relative)))
    return matches[0]


def source_rank(item: dict[str, object]) -> tuple[int, str]:
    source = str(item.get("source") or "").lower()
    rank = int(item.get("_rank") or 0)
    if source.endswith(".md") or source.startswith("docs/") or "/docs/" in source:
        rank += 50
    if "/tests/" in source or source.startswith("tests/"):
        rank += 40
    if source.endswith(("config.py", "config.yml", "config.yaml", ".env")):
        rank -= 15
    return rank, source


def is_local_host(host: str) -> bool:
    lowered = host.strip().lower()
    return not lowered or lowered in LOCAL_HOSTS or lowered.endswith(".local")


_HOST_RE = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)
_USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9._-]{0,31}$")


def safe_server_host(host: str) -> bool:
    host = host.strip()
    if not host or len(host) > 253 or is_local_host(host):
        return False
    if re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", host):
        return all(0 <= int(part) <= 255 for part in host.split("."))
    return _HOST_RE.fullmatch(host) is not None


def safe_ssh_user(user: object) -> bool:
    if user is None:
        return True
    return isinstance(user, str) and _USER_RE.fullmatch(user) is not None


def safe_remote_path(path: str) -> bool:
    if not path or path.startswith("-") or ".." in path.split("/"):
        return False
    return re.fullmatch(r"[A-Za-z0-9._/-]+", path) is not None


def collect_urls(text: str, values: dict[str, str]) -> list[str]:
    found: list[str] = []
    for key, value in values.items():
        if key in URL_KEYS or key.endswith("_url") or key.endswith("_jdbc_url"):
            if looks_like_db_url(value):
                found.append(value)
    for matched in JDBC_RE.finditer(text):
        found.append(f"jdbc:{matched.group(1)}:{matched.group(2)}")
    for matched in GENERIC_URL_RE.finditer(text):
        found.append(matched.group(1))
    unique: list[str] = []
    seen: set[str] = set()
    for raw_url in found:
        cleaned = raw_url.strip().strip("'\"")
        key = cleaned[5:] if cleaned.lower().startswith("jdbc:") else cleaned
        if not cleaned or key in seen:
            continue
        seen.add(key)
        unique.append(cleaned)
    return unique


def looks_like_db_url(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith("jdbc:") or GENERIC_URL_RE.search(value) is not None


def connection_kind(item: dict[str, object]) -> str:
    host = str(item.get("host") or "").strip()
    database = str(item.get("database") or "").strip()
    engine = str(item.get("engine") or "").lower()
    if "${" in host or "${" in database:
        return "skip"
    if engine == "sqlite" and is_local_host(host):
        return "local"
    if is_local_host(host):
        return "local"
    if not safe_server_host(host):
        return "skip"
    return "server"


def parse_values(path: Path, text: str) -> dict[str, str]:
    if path.suffix.lower() == ".json":
        return parse_json(text)
    if path.suffix.lower() in {".yml", ".yaml"}:
        return parse_indented(text, YAML_LINE_RE)
    values = parse_dotenv(text)
    values.update(parse_properties(text))
    return values


def parse_dotenv(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        matched = ENV_LINE_RE.match(line)
        if matched is None:
            continue
        values[normalize_key(matched.group(1))] = strip_quotes(matched.group(2).strip())
    return values


def parse_properties(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        matched = PROP_LINE_RE.match(line)
        if matched is None:
            continue
        values[normalize_key(matched.group(1))] = strip_quotes(matched.group(2).strip())
    return values


def parse_indented(text: str, pattern: re.Pattern[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    stack: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        matched = pattern.match(raw_line)
        if matched is None:
            continue
        indent = len(matched.group(1).replace("\t", "  "))
        key = matched.group(2)
        raw_value = matched.group(3).strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        full_key = ".".join([item[1] for item in stack] + [key])
        if raw_value and raw_value not in {"|", ">", "|-", ">-"}:
            values[normalize_key(full_key)] = strip_quotes(raw_value)
        else:
            stack.append((indent, key))
    return values


def parse_json(text: str) -> dict[str, str]:
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        return {}
    values: dict[str, str] = {}

    def walk(node: object, prefix: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                child = f"{prefix}.{key}" if prefix else str(key)
                walk(value, child)
            return
        if isinstance(node, (str, int, float)) and not isinstance(node, bool):
            values[normalize_key(prefix)] = str(node)

    walk(loaded, "")
    return values


def config_from_fields(workspace: Path, path: Path, values: dict[str, str]) -> dict[str, object] | None:
    host = first_value(values, HOST_KEYS)
    database = first_value(values, NAME_KEYS)
    username = first_value(values, USER_KEYS)
    password = first_value(values, PASSWORD_KEYS)
    port = first_value(values, PORT_KEYS)
    if file_allows_bare_keys(path):
        host = host or values.get("host")
        database = database or values.get("database")
        username = username or values.get("username")
        password = password or values.get("password")
        port = port or values.get("port")
    if not any((host, database, username)):
        return None
    engine = engine_from_keys(values) or engine_from_name(path.name)
    return record(
        workspace,
        path,
        engine=engine,
        host=host,
        port=parse_port(port),
        database=database,
        username=username,
        password=password,
        url=None,
    )


def config_from_url(workspace: Path, path: Path, raw_url: str, values: dict[str, str]) -> dict[str, object]:
    cleaned = raw_url.strip().strip("'\"")
    engine, host, port, database, username, password = parse_url(cleaned)
    return record(
        workspace,
        path,
        engine=engine or engine_from_keys(values) or engine_from_name(path.name),
        host=host,
        port=port if port is not None else parse_port(first_value(values, PORT_KEYS)),
        database=database or first_value(values, NAME_KEYS),
        username=username or first_value(values, USER_KEYS),
        password=password if password is not None else first_value(values, PASSWORD_KEYS),
        url=cleaned,
    )


def parse_url(raw_url: str) -> tuple[str | None, str | None, int | None, str | None, str | None, str | None]:
    jdbc = JDBC_RE.fullmatch(raw_url)
    if jdbc and jdbc.group(1).lower() == "sqlserver":
        return parse_sqlserver(jdbc.group(2))
    if jdbc and jdbc.group(1).lower() == "sqlite":
        return "sqlite", None, None, sqlite_database(raw_url), None, None
    remainder = raw_url
    engine = None
    if remainder.lower().startswith("jdbc:"):
        remainder = remainder[5:]
    scheme, separator, after_scheme = remainder.partition("://")
    if separator:
        engine = scheme.split("+", 1)[0].lower()
        if engine == "postgresql":
            engine = "postgres"
        parsed = urlparse(f"{scheme}://{after_scheme}")
        database = parsed.path.lstrip("/") or None
        if engine == "sqlite":
            return "sqlite", None, None, sqlite_database(raw_url), None, None
        return (
            engine,
            parsed.hostname,
            parsed.port,
            None if database is None else unquote(database.split("?", 1)[0]),
            None if parsed.username is None else unquote(parsed.username),
            None if parsed.password is None else unquote(parsed.password),
        )
    return engine, None, None, None, None, None


def sqlite_database(raw_url: str) -> str:
    matched = re.search(r"sqlite:(.*)$", raw_url, re.IGNORECASE)
    body = matched.group(1) if matched else raw_url
    if body.startswith("///"):
        return unquote(body[3:])
    if body.startswith("//"):
        return unquote(body[2:])
    return unquote(body)


def parse_sqlserver(payload: str) -> tuple[str, str | None, int | None, str | None, str | None, str | None]:
    host_part, _, options = payload.partition(";")
    host_part = host_part.removeprefix("//")
    host, _, port_text = host_part.partition(":")
    database = None
    username = None
    password = None
    for item in options.split(";"):
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        lowered = key.strip().lower()
        if lowered == "databasename":
            database = value.strip()
        elif lowered in {"user", "username", "uid"}:
            username = value.strip()
        elif lowered in {"password", "pwd"}:
            password = value.strip()
    return "sqlserver", host or None, parse_port(port_text), database, username, password


def record(
    workspace: Path,
    path: Path,
    *,
    engine: str | None,
    host: str | None,
    port: int | None,
    database: str | None,
    username: str | None,
    password: str | None,
    url: str | None,
) -> dict[str, object]:
    if engine is None and port in DEFAULT_ENGINE_BY_PORT:
        engine = DEFAULT_ENGINE_BY_PORT[port]
    relative = path.relative_to(workspace).as_posix()
    depth = len(path.relative_to(workspace).parts)
    rank = depth
    if path.name.lower() in {".env", "application.yml", "application.yaml", "application.properties"}:
        rank -= 10
    return {
        "source": relative,
        "engine": engine,
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "password": password,
        "url": url,
        "_example": is_example(path),
        "_rank": rank,
    }


def first_value(values: dict[str, str], keys: set[str]) -> str | None:
    for key in keys:
        value = values.get(key)
        if value:
            return value
    return None


def engine_from_keys(values: dict[str, str]) -> str | None:
    joined = " ".join(values)
    if "mysql" in joined or "mariadb" in joined:
        return "mysql" if "mariadb" not in joined else "mariadb"
    if "postgres" in joined or "pghost" in joined:
        return "postgres"
    if "sqlserver" in joined or "mssql" in joined:
        return "sqlserver"
    if "oracle" in joined:
        return "oracle"
    if "sqlite" in joined:
        return "sqlite"
    return None


def engine_from_name(name: str) -> str | None:
    lowered = name.lower()
    for engine in ("mysql", "mariadb", "postgres", "sqlserver", "oracle", "sqlite"):
        if engine in lowered:
            return "postgres" if engine == "postgres" else engine
    return None


def file_allows_bare_keys(path: Path) -> bool:
    lowered = path.name.lower()
    return any(token in lowered for token in ("database", "datasource", "jdbc", "mysql", "postgres", "sqlserver"))


def is_example(path: Path) -> bool:
    lowered = path.name.lower()
    return any(token in lowered for token in (".example", ".sample", ".template", ".dist"))


def normalize_key(key: str) -> str:
    return key.strip().lower().replace("-", "_").replace(".", "_")


def strip_quotes(value: str) -> str:
    value = value.split(" #", 1)[0].strip().rstrip(",")
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_port(value: str | None) -> int | None:
    if value is None or not value.strip():
        return None
    try:
        port = int(value.strip())
    except ValueError:
        return None
    if 0 < port <= 65535:
        return port
    return None


if __name__ == "__main__":
    raise SystemExit(main())
