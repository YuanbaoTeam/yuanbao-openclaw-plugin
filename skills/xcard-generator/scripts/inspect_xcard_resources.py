#!/usr/bin/env python3
"""Print the current XCard/A2UI component, token, template, and demo inventory."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from xcard_resources import (
    catalog_functions,
    discover_resources,
    load_json,
    load_json_text,
    merge_component_catalogs,
)


def _literal_object_schema(schema: dict[str, Any]) -> dict[str, Any] | None:
    if schema.get("type") == "object" and isinstance(schema.get("properties"), dict):
        return schema
    for keyword in ("anyOf", "oneOf"):
        for branch in schema.get(keyword, []):
            if (
                isinstance(branch, dict)
                and branch.get("type") == "object"
                and isinstance(branch.get("properties"), dict)
                and "path" not in branch["properties"]
                and "call" not in branch["properties"]
            ):
                return branch
    return None


def _enum_values(schema: dict[str, Any]) -> list[Any] | None:
    if isinstance(schema.get("enum"), list):
        return schema["enum"]
    return None


def _template_inventory(template_dirs: tuple[Path, ...]) -> list[dict[str, str]]:
    templates: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for root in template_dirs:
        for path in sorted(root.glob("*/*.json")):
            if path.name.endswith(".tokens.json"):
                continue
            key = (path.parent.name, path.stem)
            if key in seen:
                continue
            seen.add(key)
            templates.append(
                {
                    "templateId": path.parent.name,
                    "version": path.stem,
                    "path": str(path),
                }
            )
    return templates


def _gallery_inventory(
    gallery_dirs: tuple[Path, ...],
    include_components: bool,
) -> list[dict[str, Any]]:
    demos: list[dict[str, Any]] = []
    for root in gallery_dirs:
        root_text = str(root)
        if "/App/iOS/" in root_text:
            platform = "ios"
        elif "/App/Android/" in root_text:
            platform = "android"
        else:
            platform = "resource"
        for path in sorted(root.glob("*.jsonl")):
            lines = [
                line
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            item: dict[str, Any] = {
                "name": path.name,
                "platform": platform,
                "messageCount": len(lines),
                "path": str(path),
            }
            if include_components:
                component_types: set[str] = set()
                for line in lines:
                    message = load_json_text(line)
                    payload = message.get("updateComponents") or message.get(
                        "createSurface"
                    )
                    if not isinstance(payload, dict):
                        continue
                    for component in payload.get("components", []):
                        component_type = component.get("component")
                        if isinstance(component_type, str):
                            component_types.add(component_type)
                item["components"] = sorted(component_types)
            demos.append(item)
    return demos


def _runtime_capabilities(repo_root: Path | None) -> dict[str, Any]:
    if repo_root is None:
        return {}
    dtmx_root = repo_root.parent / "dtmx"
    ios_renderer = (
        dtmx_root / "a2ui" / "iOS" / "src" / "UIKit" / "XCardSurfaceView.m"
    )
    ios_text = (
        ios_renderer.read_text(encoding="utf-8", errors="ignore")
        if ios_renderer.is_file()
        else ""
    )
    android_registry = (
        repo_root
        / "App"
        / "Android"
        / "infra"
        / "a2ui"
        / "src"
        / "androidMain"
        / "kotlin"
        / "com"
        / "tencent"
        / "yb"
        / "infra"
        / "a2ui"
        / "YBA2uiComponentRegistry.kt"
    )
    android_state_holder = (
        repo_root
        / "App"
        / "Android"
        / "module"
        / "debug"
        / "src"
        / "androidMain"
        / "kotlin"
        / "com"
        / "tencent"
        / "genui"
        / "sample"
        / "OfficialSampleStateHolder.kt"
    )
    registry_text = (
        android_registry.read_text(encoding="utf-8", errors="ignore")
        if android_registry.is_file()
        else ""
    )
    state_holder_text = (
        android_state_holder.read_text(encoding="utf-8", errors="ignore")
        if android_state_holder.is_file()
        else ""
    )
    return {
        "ios": {
            "source": str(ios_renderer) if ios_renderer.is_file() else None,
            "verticalListHeightCreatesScrollViewport": (
                "isVerticalScrollableList" in ios_text
                and "showsVerticalScrollIndicator = isVerticalScrollableList"
                in ios_text
            ),
            "buttonDeclaredWidthFillsBackground": (
                "hasDeclaredWidth" in ios_text
                and "weight > 0 || hasDeclaredWidth" in ios_text
            ),
            "singleLineAttributedTextTruncates": (
                "paragraphStyle.lineBreakMode = NSLineBreakByTruncatingTail"
                in ios_text
            ),
        },
        "androidGallery": {
            "registrySource": (
                str(android_registry) if android_registry.is_file() else None
            ),
            "xcardCatalogRegistered": (
                "XCardCatalogItems" in registry_text
                or "catalogs/xcard/catalog.json" in registry_text
            ),
            "templateLoaderInjected": "TemplateLoader" in state_holder_text,
        },
    }


def build_inventory(
    resource_root: Path | str | None,
    repo_root: Path | None,
    include_demos: bool,
    include_demo_components: bool,
) -> dict[str, Any]:
    resources = discover_resources(resource_root, repo_root)
    missing = resources.missing_required()
    if missing:
        raise SystemExit(
            "Missing required XCard resources: "
            + ", ".join(missing)
            + ". Pass --resource-root or set XCARD_RESOURCE_ROOT."
        )

    assert resources.basic_catalog
    assert resources.xcard_catalog
    assert resources.tokens
    basic_catalog = load_json(resources.basic_catalog)
    xcard_catalog = load_json(resources.xcard_catalog)
    common_types = (
        load_json(resources.common_types) if resources.common_types else None
    )
    tokens = load_json(resources.tokens)
    merged = merge_component_catalogs(
        basic_catalog,
        xcard_catalog,
        common_types,
    )

    components: dict[str, Any] = {}
    for name, schema in merged.items():
        properties = schema.get("properties", {})
        component_summary: dict[str, Any] = {
            "properties": sorted(
                key
                for key in properties
                if key not in {"id", "component", "catalogId", "accessibility", "metadata"}
            ),
            "required": [
                key
                for key in schema.get("required", [])
                if key not in {"id", "component"}
            ],
        }
        enums = {
            key: enum
            for key, property_schema in properties.items()
            if (enum := _enum_values(property_schema)) is not None
        }
        if enums:
            component_summary["enums"] = enums

        style_schema = properties.get("style")
        if isinstance(style_schema, dict):
            literal_style = _literal_object_schema(style_schema)
            if literal_style:
                component_summary["styleKeys"] = sorted(
                    literal_style.get("properties", {})
                )
        components[name] = component_summary

    icon_assets = tokens.get("icons", {}).get("assets", {})
    templates = _template_inventory(resources.template_dirs)
    demos = (
        _gallery_inventory(resources.gallery_dirs, include_demo_components)
        if include_demos or include_demo_components else []
    )
    for item in [*templates, *demos]:
        item["path"] = resources.location(Path(item["path"]))
    return {
        "sources": {
            "basicCatalog": resources.location(resources.basic_catalog),
            "xcardCatalog": resources.location(resources.xcard_catalog),
            "tokens": resources.location(resources.tokens),
            "galleryDirs": [resources.location(path) for path in resources.gallery_dirs],
            "templateDirs": [resources.location(path) for path in resources.template_dirs],
            "iconDirs": [resources.location(path) for path in resources.icon_dirs],
        },
        "catalog": {
            "basicCatalogId": basic_catalog.get("catalogId"),
            "xcardCatalogId": xcard_catalog.get("catalogId"),
            "components": components,
            "functions": sorted(catalog_functions(basic_catalog, xcard_catalog)),
        },
        "tokens": {
            "colors": sorted(tokens.get("colors", {})),
            "typography": sorted(tokens.get("typography", {})),
            "shape": sorted(tokens.get("shape", {})),
            "image": sorted(tokens.get("image", {})),
            "icons": sorted(set(icon_assets) | set(icon_assets.values())),
        },
        "templates": templates,
        "runtimeCapabilities": _runtime_capabilities(resources.repo_root),
        "demos": demos,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-root", help="Local resource directory or static Skill HTTP(S) URL")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--include-demos", action="store_true")
    parser.add_argument("--include-demo-components", action="store_true")
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()

    inventory = build_inventory(
        args.resource_root,
        args.repo_root,
        args.include_demos,
        args.include_demo_components,
    )
    print(
        json.dumps(
            inventory,
            ensure_ascii=False,
            indent=None if args.compact else 2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
