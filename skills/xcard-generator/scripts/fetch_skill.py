#!/usr/bin/env python3
"""Download a complete static skill directory using its file manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path, PurePosixPath
from urllib.error import URLError
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from urllib.request import urlopen

SKILL_NAME = "xcard-generator"


def skill_base_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Expected an HTTP(S) skill directory or SKILL.md URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use a skill URL without credentials, query, or fragment")
    path = parsed.path
    if path.endswith(("/SKILL.md", "/manifest.json")):
        path = path.rsplit("/", 1)[0]
    return urlunsplit((parsed.scheme, parsed.netloc, path.rstrip("/") + "/", "", ""))


def read_url(url: str, limit: int) -> bytes:
    with urlopen(url, timeout=30) as response:
        if response.status != 200:
            raise ValueError("Static skill request did not return HTTP 200")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Static skill response exceeds its expected size")
    return data


def manifest_files(manifest: dict) -> list[dict]:
    if manifest.get("name") != SKILL_NAME or manifest.get("entrypoint") != "SKILL.md":
        raise ValueError("Unexpected skill manifest name or entrypoint")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries or len(entries) > 1000:
        raise ValueError("Invalid skill manifest file list")
    seen = set()
    total = 0
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Invalid skill manifest file entry")
        name = entry.get("path")
        if not isinstance(name, str) or not name:
            raise ValueError("Invalid skill file path")
        path = PurePosixPath(name)
        if (
            path.is_absolute() or path.as_posix() != name or "\\" in name or ":" in name
            or any(part in {".", ".."} or part.startswith(".") for part in path.parts)
            or name in seen or any(ord(char) < 32 for char in name)
        ):
            raise ValueError(f"Unsafe or duplicate skill file path: {name!r}")
        seen.add(name)
        size = entry.get("size")
        digest = entry.get("sha256")
        if type(size) is not int or not 0 <= size <= 10 * 1024 * 1024:
            raise ValueError("Invalid skill file size")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid skill file checksum")
        total += size
    if "SKILL.md" not in seen or total > 50 * 1024 * 1024:
        raise ValueError("Skill entrypoint missing or total size exceeds limit")
    return entries


def download_skill(url: str, output: Path) -> Path:
    base = skill_base_url(url)
    output = output.expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise ValueError(f"Destination already exists: {output}. Choose a new directory.")
    try:
        manifest = json.loads(read_url(urljoin(base, "manifest.json"), 1024 * 1024))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Expected manifest JSON; check the skill URL and site authentication") from error
    if not isinstance(manifest, dict):
        raise ValueError("Expected a skill manifest object")
    entries = manifest_files(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Publish the local folder only after every downloaded file passes its checksum.
    with tempfile.TemporaryDirectory(prefix=".xcard-download-", dir=output.parent) as temporary:
        staging = Path(temporary) / SKILL_NAME
        staging.mkdir()
        for entry in entries:
            content = read_url(urljoin(base, quote(entry["path"], safe="/")), entry["size"])
            if len(content) != entry["size"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
                raise ValueError(f"Checksum mismatch for {entry['path']}; check deployment and authentication")
            target = staging / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        if output.exists() or output.is_symlink():
            raise ValueError(f"Destination appeared during download: {output}")
        staging.rename(output)
    return output.resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Skill directory or SKILL.md URL")
    parser.add_argument("--output", type=Path, default=Path(SKILL_NAME))
    args = parser.parse_args()
    try:
        result = download_skill(args.url, args.output)
    except (OSError, URLError, ValueError) as error:
        parser.exit(1, f"Download failed: {error}\n")
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
