import os
from pathlib import Path

import pytest

from dsh_mom.config import SettingsError
from dsh_mom.node_runtime import activate_node_runtime


def _install_fake_cli(root: Path, *, with_conpty: bool) -> None:
    entry = root / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("export {}\n", encoding="utf-8")
    if with_conpty:
        addon = root / "node_modules" / "node-pty" / "prebuilds" / "win32-x64" / "conpty.node"
        addon.parent.mkdir(parents=True)
        addon.write_bytes(b"node")


def test_activate_points_sdk_at_official_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_cli(tmp_path / "vendor" / "dsh", with_conpty=True)
    monkeypatch.setattr("dsh_mom.node_runtime.shutil.which", lambda _name: r"C:\node\node.exe")
    bootstrap = tmp_path / "runtime" / "node" / "runtime-bootstrap.mjs"

    entry = activate_node_runtime(tmp_path, bootstrap)

    assert entry.is_file()
    assert os.environ["DSH_RUNTIME_MODE"] == "node"
    assert os.environ["DSH_NODE_ENTRY"] == str(entry.resolve())
    assert "DSH_NODE_ENTRY" in bootstrap.read_text(encoding="utf-8")


def test_activate_reports_missing_cli(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="npm install --prefix vendor/dsh"):
        activate_node_runtime(tmp_path, tmp_path / "runtime-bootstrap.mjs")
