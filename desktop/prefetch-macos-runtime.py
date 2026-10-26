#!/usr/bin/env python3
"""Download pinned desktop runtime archives into the upstream SHA-256 cache.

Official packaging fetches these from nodejs.org, GitHub, and PyPI with a
short timeout. This step fills the same cache from mirrors before packaging.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

NODE_MIRRORS = (
    "https://npmmirror.com/mirrors/node/v{version}/{filename}",
    "https://nodejs.org/dist/v{version}/{filename}",
)
PYTHON_MIRRORS = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/{release}/{filename}",
    "https://mirror.ghproxy.com/https://github.com/astral-sh/python-build-standalone/releases/download/{release}/{filename}",
)
PYPI_MIRRORS = (
    "https://pypi.tuna.tsinghua.edu.cn/packages/{path}",
    "https://files.pythonhosted.org/packages/{path}",
)


def download(urls: list[str], destination: Path, expected: str) -> None:
    if destination.is_file():
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if digest == expected:
            print(f"cached {destination.name}")
            return
        destination.unlink()
    last_error: Exception | None = None
    for url in urls:
        print(f"fetch {url}")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "dsh-mom-package"})
            with urllib.request.urlopen(request, timeout=300) as response, tempfile.NamedTemporaryFile(delete=False) as handle:
                temporary = Path(handle.name)
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
        except Exception as exc:
            last_error = exc
            print(f"failed {url}: {exc}", file=sys.stderr)
            continue
        digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
        if digest != expected:
            temporary.unlink(missing_ok=True)
            last_error = RuntimeError(f"checksum mismatch for {url}")
            print(last_error, file=sys.stderr)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary.replace(destination)
        print(f"saved {destination.name}")
        return
    raise SystemExit(f"could not download {expected}: {last_error}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prefetch-macos-runtime.py <dsh-src> <mac-x64|mac-arm64>")
    build_root = Path(sys.argv[1])
    target = sys.argv[2]
    lock = json.loads((build_root / "scripts/primary-runtime/lock.json").read_text())
    cache = build_root / "apps/desktop/.desktop-build/downloads"
    cache.mkdir(parents=True, exist_ok=True)
    artifact = lock["targets"][target]
    node_filename = f"node-v{lock['nodeVersion']}-{artifact['nodeArchive']}"
    python_filename = urllib.parse.quote(
        f"cpython-{lock['pythonVersion']}+{lock['pythonRelease']}-{artifact['pythonTarget']}-install_only_stripped.tar.gz",
        safe="",
    )
    download(
        [template.format(version=lock["nodeVersion"], filename=node_filename) for template in NODE_MIRRORS],
        cache / artifact["nodeSha256"],
        artifact["nodeSha256"],
    )
    download(
        [
            template.format(release=lock["pythonRelease"], filename=python_filename)
            for template in PYTHON_MIRRORS
        ],
        cache / artifact["pythonSha256"],
        artifact["pythonSha256"],
    )
    for wheel in [*artifact["wheels"], *lock["wheels"]]:
        path = wheel["url"].split("/packages/", 1)[1]
        download(
            [template.format(path=path) for template in PYPI_MIRRORS],
            cache / wheel["sha256"],
            wheel["sha256"],
        )


if __name__ == "__main__":
    main()
