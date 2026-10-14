#!/usr/bin/env python3
"""Audit XCard dimensions and inline image assets for common visual failures."""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from xcard_resources import load_json, load_json_text


@dataclass(frozen=True)
class Finding:
    location: str
    message: str


def walk_components(data: Any, location: str) -> Iterable[tuple[dict[str, Any], str]]:
    if not isinstance(data, dict):
        return
    for payload_name in ("createSurface", "updateComponents"):
        payload = data.get(payload_name)
        if not isinstance(payload, dict):
            continue
        components = payload.get("components")
        if not isinstance(components, list):
            continue
        for index, component in enumerate(components):
            if isinstance(component, dict):
                yield component, f"{location}.{payload_name}.components[{index}]"


def load_documents(target: Path) -> list[tuple[Any, str]]:
    files: list[Path]
    if target.is_dir():
        files = sorted(
            path
            for path in target.rglob("*")
            if path.suffix in {".json", ".jsonl"}
            and not path.name.endswith(".tokens.json")
        )
    else:
        files = [target]

    documents: list[tuple[Any, str]] = []
    for path in files:
        if path.suffix == ".jsonl":
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(),
                start=1,
            ):
                if line.strip():
                    documents.append(
                        (load_json_text(line), f"{path}:{line_number}")
                    )
        elif path.suffix == ".json":
            documents.append((load_json(path), str(path)))
    return documents


def follow_template_references(
    target: Path,
    documents: list[tuple[Any, str]],
) -> list[tuple[Any, str]]:
    if not target.is_file() or target.suffix != ".jsonl":
        return documents
    template_root = target.parent / "templates"
    if target.parent.name == "gallery":
        template_root = target.parent.parent / "templates"

    result = list(documents)
    seen = {location for _, location in result}
    for document, location in documents:
        for component, _ in walk_components(document, location):
            if component.get("component") != "xCardTemplate":
                continue
            template_id = component.get("templateId")
            if not isinstance(template_id, str) or not template_id:
                continue
            # A template package is `{templateId}/template.json`; the protocol
            # carries no version, so which revision the host resolves is not
            # knowable here. Only a local copy can be audited.
            template_path = template_root / template_id / "template.json"
            template_location = str(template_path)
            if template_path.is_file() and template_location not in seen:
                result.append((load_json(template_path), template_location))
                seen.add(template_location)
    return result


def literal_style(component: dict[str, Any]) -> dict[str, Any]:
    style = component.get("style")
    if not isinstance(style, dict) or "path" in style or "call" in style:
        return {}
    return style


def numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def is_near_white(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, alpha = pixel
    return alpha >= 240 and min(red, green, blue) >= 238


def circular_image_has_white_matte(
    url: str,
    style: dict[str, Any],
) -> bool:
    if not url.startswith("data:image/") or ";base64," not in url:
        return False
    width = numeric(style.get("width"))
    height = numeric(style.get("height"))
    shape = numeric(style.get("shape"))
    if width is None or height is None or shape is None:
        return False
    if abs(width - height) > 0.5 or shape < min(width, height) * 0.45:
        return False

    try:
        encoded = url.split(";base64,", 1)[1]
        image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGBA")
    except Exception:
        return False

    center_x = (image.width - 1) / 2
    center_y = (image.height - 1) / 2
    radius = min(image.width, image.height) * 0.43
    samples: list[tuple[int, int, int, int]] = []
    for index in range(72):
        angle = 2 * math.pi * index / 72
        x = round(center_x + math.cos(angle) * radius)
        y = round(center_y + math.sin(angle) * radius)
        samples.append(image.getpixel((x, y)))
    return sum(is_near_white(pixel) for pixel in samples) / len(samples) > 0.55


def audit_component(
    component: dict[str, Any],
    location: str,
    expect_scroll: bool,
) -> list[Finding]:
    findings: list[Finding] = []
    component_type = component.get("component")
    style = literal_style(component)

    if component_type == "Button":
        width = numeric(style.get("width"))
        height = numeric(style.get("height"))
        if width is not None and height and width / height < 1.4:
            findings.append(
                Finding(
                    location,
                    f"text Button is near-circular ({width:g}x{height:g}); "
                    "use IconButton for a circle or widen the text button",
                )
            )

    if component_type == "Image":
        url = component.get("url")
        if isinstance(url, str) and circular_image_has_white_matte(url, style):
            findings.append(
                Finding(
                    location,
                    "circular inline image has an opaque near-white perimeter; "
                    "tight-crop or remove the matte before dark-mode delivery",
                )
            )

    if (
        expect_scroll
        and component_type == "List"
        and component.get("direction", "vertical") == "vertical"
        and isinstance(component.get("children"), dict)
        and numeric(style.get("height")) is None
    ):
        findings.append(
            Finding(
                location,
                "dynamic vertical List expected to scroll but has no numeric style.height viewport",
            )
        )
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    parser.add_argument("--expect-scroll", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    target = args.target.expanduser().resolve()
    if not target.exists():
        parser.error(f"target does not exist: {target}")

    findings: list[Finding] = []
    documents = follow_template_references(target, load_documents(target))
    for document, location in documents:
        for component, component_location in walk_components(document, location):
            findings.extend(
                audit_component(
                    component,
                    component_location,
                    args.expect_scroll,
                )
            )

    payload = {
        "ok": not findings,
        "findings": [
            {"location": finding.location, "message": finding.message}
            for finding in findings
        ],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for finding in findings:
            print(f"WARNING: {finding.location}: {finding.message}")
        if findings:
            print(f"FOUND: {len(findings)} visual risk(s)")
        else:
            print(f"OK: {target} (0 visual risk(s))")
    return 1 if args.strict and findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
