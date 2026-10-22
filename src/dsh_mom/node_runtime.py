"""Use the official Node ``dsh`` CLI on Windows.

The Python wheel's single-file runtime keeps ``node-pty`` inside a pkg snapshot.
``require()`` from that snapshot cannot see ``prebuilds/win32-x64/conpty.node``,
so shell commands never execute. ``@deepseek-ai/dsh`` is the same official CLI
the SDK packages, pinned to the matching 0.2.1-rc.2 release, with the native
addon stored as a normal file. The SDK selects this carrier when
``DSH_RUNTIME_MODE=node``.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from dsh_mom.config import SettingsError

DSH_CLI_VERSION = "0.2.1-rc.2"
_BOOTSTRAP = """\
import { pathToFileURL } from "node:url";

const entry = process.env.DSH_NODE_ENTRY;
if (!entry) {
  console.error("DSH_NODE_ENTRY is not set");
  process.exit(1);
}
const cli = await import(pathToFileURL(entry).href);
await cli.runCli();
"""


def cli_root(project_root: Path) -> Path:
    return project_root / "vendor" / "dsh"


def cli_entry(project_root: Path) -> Path:
    return cli_root(project_root) / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"


def conpty_addon(project_root: Path) -> Path:
    return (
        cli_root(project_root)
        / "node_modules"
        / "node-pty"
        / "prebuilds"
        / "win32-x64"
        / "conpty.node"
    )


def activate_node_runtime(project_root: Path, bootstrap_path: Path) -> Path:
    """Point the SDK at the on-disk official CLI. Return the CLI entry path."""
    entry = cli_entry(project_root)
    if not entry.is_file():
        raise SettingsError(
            "未安装官方 dsh CLI。在项目根目录执行: "
            f"npm install --prefix vendor/dsh @deepseek-ai/dsh@{DSH_CLI_VERSION}"
        )
    node = shutil.which("node")
    if node is None:
        raise SettingsError("运行官方 dsh CLI 需要 Node.js 22.19 或更高版本，且 node 在 PATH 中。")
    if os.name == "nt" and not conpty_addon(project_root).is_file():
        raise SettingsError(
            "官方 dsh CLI 已安装，但缺少 Windows 终端模块 node-pty/prebuilds/win32-x64/conpty.node。"
            "请在项目根目录重新执行 npm install --prefix vendor/dsh。"
        )
    bootstrap_path.parent.mkdir(parents=True, exist_ok=True)
    bootstrap_path.write_text(_BOOTSTRAP, encoding="utf-8")
    os.environ["DSH_RUNTIME_MODE"] = "node"
    os.environ["DSH_NODE_ENTRY"] = str(entry.resolve())
    return entry


def bundled_bootstrap_path() -> Path:
    from deepseek_harness_runtime import bundled_package_dir

    return Path(bundled_package_dir()) / "runtime" / "node" / "runtime-bootstrap.mjs"
