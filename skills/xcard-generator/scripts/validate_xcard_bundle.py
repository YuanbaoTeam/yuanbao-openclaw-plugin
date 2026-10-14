#!/usr/bin/env python3
"""Validate XCard A2UI v1.0 JSONL, templates, bindings, and token overlays."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from xcard_resources import (
    DuplicateKeyError,
    catalog_functions,
    discover_resources,
    load_json,
    load_json_text,
    merge_component_catalogs,
    merge_function_catalogs,
    normalize_token_name,
)


MESSAGE_KEYS = {
    "createSurface",
    "updateComponents",
    "updateDataModel",
    "deleteSurface",
    "callRendererFunction",
    "agentFunctionResponse",
}
MESSAGE_SCHEMA_NAMES = {
    "createSurface": "CreateSurfaceMessage",
    "updateComponents": "UpdateComponentsMessage",
    "updateDataModel": "UpdateDataModelMessage",
    "deleteSurface": "DeleteSurfaceMessage",
    "callRendererFunction": "CallRendererFunctionMessage",
    "agentFunctionResponse": "AgentFunctionResponseMessage",
}
COMMON_COMPONENT_KEYS = {
    "id",
    "component",
    "catalogId",
    "accessibility",
    "metadata",
    "subscriptions",
}
COLOR_STYLE_KEYS = {"color", "tint", "containerColor"}
ACTION_ONLY_FUNCTIONS = {
    "updateData",
    "toast",
    "copyContent",
    "publishDataModel",
    "sequence",
    "switch",
    "setTimeout",
    "closeModal",
}
ACTION_OBJECT_KEYS = {"event", "functionCall", "resultPath", "tracking", "checks", "throttle"}
# `sequence` args that make it wait for each step's result. Waiting is a
# property of the orchestration, so on any other system action they are a
# misplaced intent rather than an extension point.
SEQUENCE_WAIT_KEYS = {"waitForResults", "awaitTimeoutMs"}
INTERACTIVE_COMPONENTS = {"Button", "Clickable", "IconButton"}
# The components the catalog declares `combinedActions` on. Component schemas
# are open now, so a gesture map on anything else validates and then never
# fires; warn by name rather than reject, which is the split this validator
# keeps everywhere: lenient at runtime, strict while authoring.
COMBINED_ACTION_COMPONENTS = INTERACTIVE_COMPONENTS | {
    "Box",
    "Card",
    "Column",
    "Icon",
    "Image",
    "List",
    "RichText",
    "SvgView",
    "Row",
    "Text",
}
# RichText, design/xcard-richtext/spec.md §4 and §10.
RICH_TEXT_SPAN_KEYS = {"text", "style", "action"}
RICH_TEXT_SPAN_STYLE_KEYS = {"color", "fontWeight", "textDecoration", "fontStyle"}
# Bold / italic / link markers an author reaches for out of habit. Kept narrow
# so ordinary copy ("5 * 3", "C#") does not trip it.
# Label, design/xcard-label/spec.md §10. Style keys other components read
# that a Label ignores: its type, fill and corner all come from `variant`.
LABEL_IGNORED_STYLE_KEYS = {"fontWeight", "textDecoration", "fontStyle", "containerColor", "shape", "tint"}
MARKDOWN_TRACE_RE = re.compile(r"\*\*[^*\s][^*]*\*\*|__[^_\s][^_]*__|\[[^\]]+\]\([^)]+\)")
ACTION_TRIGGERS = ("click", "longPress", "doubleClick")
REFERENCE_KEYS = {"child", "trigger", "content"}
# System functions live in common_types.json `$defs`, not in any catalog, so a
# catalog-only lookup rejects the very features the protocol ships. `@index`
# and `@indexValue` additionally mean nothing outside a list template. Keep in
# step with the `systemCall` check in a2ui/cpp/src/core/evaluator.cpp.
SYSTEM_FUNCTIONS = {
    "@index",
    "@indexValue",
    "@selected",
    "@surfaceId",
    "@rendererVersion",
    "@hostEnv",
}
LIST_CONTEXT_FUNCTIONS = {"@index", "@indexValue"}
# `@selected` answers for a ChoiceGroup option: only an option template (and
# what it nests) and the group's own `action`, which runs in the tapped
# option's scope, have one. design/xcard-choice-flow/spec.md §3.2.
CHOICE_CONTEXT_FUNCTIONS = {"@selected"}
TEMPLATE_COMPONENT = "xCardTemplate"
# The protocol names a template only. `template_version` belongs to the
# package's meta.json, and component schemas are open, so writing it on the
# reference validates and is then read by nobody.
TEMPLATE_REFERENCE_KEYS = {"templateId", "path", "children", "style", "weight"}
TRACKING_PROFILES = ("generic", "yuanbao")
YUANBAO_TRACKING_PARAM_KEYS = {"P1", "P2", "P3", "P4", "P5", "P6"}
TRACKING_ID_WARN_LENGTH = 64
GLOBAL_TRACKING_PARAMS_KEY = "xCardGlobalTrackingParams"
# Deprecated Yuanbao event-code scheme. Cards still carrying it report nothing
# on the current host, and the shape is distinctive enough to name outright.
DEPRECATED_TRACKING_ID_PREFIXES = ("OnPageMod", "OnPageClick")
# VerticalGrid / HorizontalGrid, spec design/xcard-grid §12.2. Each grid names
# the property that sets its track count, the one that would belong to the
# other grid, and the style keys along its track and scroll axes.
GRID_AXES = {
    "VerticalGrid": {
        "tracks": "columns",
        "other": ("rows", "HorizontalGrid"),
        "track_size": ("width", "fillMaxWidth"),
        "scroll_fraction": "fillMaxHeight",
        "scroll_size": "height",
        "list_direction": "vertical",
    },
    "HorizontalGrid": {
        "tracks": "rows",
        "other": ("columns", "VerticalGrid"),
        "track_size": ("height", "fillMaxHeight"),
        "scroll_fraction": "fillMaxWidth",
        "scroll_size": "width",
        "list_direction": "horizontal",
    },
}
GRID_MAX_TRACKS = 12
GRID_REJECTED_KEYS = {
    "scrollable",
    "direction",
    "orientation",
    "justify",
    "horizontalArrangement",
    "verticalArrangement",
    "contentAlignment",
    "align",
}
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{8}$")
TOKEN_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class Issue:
    severity: str
    location: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "location": self.location,
            "message": self.message,
        }


def _is_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def _in_action_context(location: str) -> bool:
    return any(
        marker in location
        for marker in (
            ".action.functionCall",
            ".action.event",
            ".combinedActions.",
            ".args.actions[",
            ".args.cases[",
            ".args.default",
            ".args.action",
        )
    )


def _literal_type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _schema_errors(value: Any, schema: Any, location: str) -> list[str]:
    if not isinstance(schema, dict):
        return []
    if "$ref" in schema and len(schema) == 1:
        return []

    for keyword in ("allOf",):
        if isinstance(schema.get(keyword), list):
            errors: list[str] = []
            for branch in schema[keyword]:
                errors.extend(_schema_errors(value, branch, location))
            if errors:
                return errors

    for keyword in ("anyOf", "oneOf"):
        branches = schema.get(keyword)
        if isinstance(branches, list):
            branch_results = [
                _schema_errors(value, branch, location) for branch in branches
            ]
            if any(not result for result in branch_results):
                break
            return [
                f"{location}: value does not match any allowed {keyword} branch"
            ]

    expected_type = schema.get("type")
    if isinstance(expected_type, list):
        if not any(_is_type(value, item) for item in expected_type):
            return [f"{location}: expected one of {expected_type}"]
    elif isinstance(expected_type, str) and not _is_type(value, expected_type):
        return [f"{location}: expected {expected_type}, got {type(value).__name__}"]

    if "const" in schema and value != schema["const"]:
        return [f"{location}: expected constant {schema['const']!r}"]
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        return [f"{location}: {value!r} is not in {schema['enum']!r}"]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            return [f"{location}: {value} is below minimum {minimum}"]
    if isinstance(value, str) and isinstance(schema.get("pattern"), str):
        if re.fullmatch(schema["pattern"], value) is None:
            return [
                f"{location}: {value!r} does not match {schema['pattern']!r}"
            ]

    errors: list[str] = []
    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            for key in required:
                if key not in value:
                    errors.append(f"{location}: missing required property {key!r}")

        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}
        additional = schema.get(
            "additionalProperties",
            schema.get("unevaluatedProperties", True),
        )
        for key, item in value.items():
            if key in properties:
                errors.extend(
                    _schema_errors(item, properties[key], f"{location}.{key}")
                )
            elif additional is False:
                errors.append(f"{location}: unsupported property {key!r}")
            elif isinstance(additional, dict):
                errors.extend(
                    _schema_errors(item, additional, f"{location}.{key}")
                )

    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors.extend(
                _schema_errors(item, schema["items"], f"{location}[{index}]")
            )

    prohibited = schema.get("not")
    if isinstance(prohibited, dict):
        if not _schema_errors(value, prohibited, location):
            errors.append(f"{location}: matches a prohibited schema")
    return errors


def _collect_enum_strings(node: Any) -> set[str]:
    values: set[str] = set()
    if isinstance(node, dict):
        enum = node.get("enum")
        if isinstance(enum, list):
            values.update(item for item in enum if isinstance(item, str))
        for value in node.values():
            values.update(_collect_enum_strings(value))
    elif isinstance(node, list):
        for value in node:
            values.update(_collect_enum_strings(value))
    return values


def _walk(node: Any, location: str) -> Iterable[tuple[Any, str]]:
    yield node, location
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(value, f"{location}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, f"{location}[{index}]")


def _component_references(component: dict[str, Any]) -> set[str]:
    references: set[str] = set()
    for key in REFERENCE_KEYS:
        value = component.get(key)
        if isinstance(value, str):
            references.add(value)

    children = component.get("children")
    if isinstance(children, list):
        references.update(item for item in children if isinstance(item, str))
    elif isinstance(children, dict):
        component_id = children.get("componentId")
        if isinstance(component_id, str):
            references.add(component_id)

    tabs = component.get("tabs")
    if isinstance(tabs, list):
        for tab in tabs:
            if isinstance(tab, dict) and isinstance(tab.get("child"), str):
                references.add(tab["child"])
    # ConditionView renders one of `cases[].child`, or `default`.
    cases = component.get("cases")
    if isinstance(cases, list):
        for case in cases:
            if isinstance(case, dict) and isinstance(case.get("child"), str):
                references.add(case["child"])
    default = component.get("default")
    if isinstance(default, str):
        references.add(default)
    return references


class BundleValidator:
    def __init__(
        self,
        resource_root: Path | str | None,
        repo_root: Path | None,
        allow_components: set[str],
        *,
        allow_template: bool = False,
        allow_webcard: bool = False,
        template_root: Path | None = None,
        tracking_profile: str | None = None,
        allow_functions: set[str] | None = None,
    ) -> None:
        # Self-contained is the default because the features gated here
        # fail quietly: an unresolved xCardTemplate renders blank, a WebCard
        # needs a host URL policy, and tracking written to the wrong host
        # contract renders perfectly while reporting nothing.
        self.allow_template = allow_template
        self.allow_webcard = allow_webcard
        self.template_root = template_root
        self.tracking_profile = tracking_profile
        # Host-registered functions the catalogs do not declare. Registering
        # declares them on the host, so an author lists the ones the target
        # host has and every call site — not only a top-level action — may
        # use them.
        self.allowed_functions = set(allow_functions or ())
        self.resources = discover_resources(resource_root, repo_root)
        missing = self.resources.missing_required()
        if missing:
            raise SystemExit(
                "Missing required XCard resources: "
                + ", ".join(missing)
                + ". Pass --resource-root or set XCARD_RESOURCE_ROOT."
            )

        assert self.resources.basic_catalog
        assert self.resources.xcard_catalog
        assert self.resources.tokens
        self.basic_catalog = load_json(self.resources.basic_catalog)
        self.xcard_catalog = load_json(self.resources.xcard_catalog)
        self.common_types = (
            load_json(self.resources.common_types)
            if self.resources.common_types
            else None
        )
        self.component_schemas = merge_component_catalogs(
            self.basic_catalog,
            self.xcard_catalog,
            self.common_types,
        )
        self.function_schemas = merge_function_catalogs(
            self.basic_catalog,
            self.xcard_catalog,
            self.common_types,
        )
        # System functions are declared in common_types.json `$defs`, not in
        # any catalog, so a catalog-only lookup rejects them outright.
        common_defs = (self.common_types or {}).get("$defs", {})
        self.system_function_schemas = {
            name: schema
            for name, schema in (
                (
                    ((schema.get("properties") or {}).get("call") or {}).get("const"),
                    schema,
                )
                for schema in common_defs.values()
                if isinstance(schema, dict)
            )
            if isinstance(name, str) and name in SYSTEM_FUNCTIONS
        }
        self.agent_schema = (
            load_json(self.resources.agent_schema)
            if self.resources.agent_schema
            else {}
        )
        self.message_schemas = self.agent_schema.get("$defs", {})
        self.allowed_components = set(self.component_schemas) | allow_components
        self.functions = catalog_functions(self.basic_catalog, self.xcard_catalog)
        self.base_tokens = load_json(self.resources.tokens)
        self.base_colors = set(self.base_tokens.get("colors", {}))
        self.base_shapes = set(self.base_tokens.get("shape", {}))
        self.base_typography = set(self.base_tokens.get("typography", {}))
        self.base_images = set(self.base_tokens.get("image", {}))
        self.colors = set(self.base_colors)
        self.shapes = set(self.base_shapes)
        self.typography = set(self.base_typography)
        self.images = set(self.base_images)
        icon_assets = self.base_tokens.get("icons", {}).get("assets", {})
        self.icons = {
            normalize_token_name(name)
            for name in set(icon_assets) | set(icon_assets.values())
        }
        basic_icon_schema = (
            self.basic_catalog.get("components", {})
            .get("Icon", {})
            .get("properties", {})
            .get("name", {})
        )
        self.icons.update(
            normalize_token_name(name)
            for name in _collect_enum_strings(basic_icon_schema)
        )
        self.issues: list[Issue] = []

    def error(self, location: str, message: str) -> None:
        self.issues.append(Issue("error", location, message))

    def warning(self, location: str, message: str) -> None:
        self.issues.append(Issue("warning", location, message))

    def _apply_overlay(self, overlay: dict[str, Any]) -> None:
        self.colors.update(set(overlay.get("colors", {})) & self.base_colors)
        self.shapes.update(set(overlay.get("shape", {})) & self.base_shapes)
        self.typography.update(
            set(overlay.get("typography", {})) & self.base_typography
        )
        self.images.update(set(overlay.get("image", {})) & self.base_images)
        icon_assets = overlay.get("icons", {}).get("assets", {})
        base_icon_assets = self.base_tokens.get("icons", {}).get("assets", {})
        self.icons.update(
            normalize_token_name(name)
            for name in (
                (set(icon_assets) & set(base_icon_assets))
                | {
                    value
                    for key, value in icon_assets.items()
                    if key in base_icon_assets
                }
            )
        )

    def _token_snapshot(
        self,
    ) -> tuple[set[str], set[str], set[str], set[str], set[str]]:
        return (
            set(self.colors),
            set(self.shapes),
            set(self.typography),
            set(self.images),
            set(self.icons),
        )

    def _restore_tokens(
        self,
        snapshot: tuple[set[str], set[str], set[str], set[str], set[str]],
    ) -> None:
        (
            self.colors,
            self.shapes,
            self.typography,
            self.images,
            self.icons,
        ) = snapshot

    def validate_token_overlay(
        self,
        path: Path,
        overlay: dict[str, Any] | None = None,
    ) -> None:
        location = str(path)
        if overlay is None:
            try:
                overlay = load_json(path)
            except (OSError, ValueError, DuplicateKeyError) as error:
                self.error(location, str(error))
                return
        if not isinstance(overlay, dict):
            self.error(location, "token overlay root must be an object")
            return

        allowed_groups = {"colors", "typography", "shape", "image", "icons"}
        for key in overlay:
            if key not in allowed_groups:
                self.error(location, f"unsupported token group {key!r}")

        colors = overlay.get("colors", {})
        if not isinstance(colors, dict):
            self.error(f"{location}.colors", "must be an object")
        else:
            for name, modes in colors.items():
                if not TOKEN_NAME_RE.fullmatch(name):
                    self.error(
                        f"{location}.colors.{name}",
                        "token name must be an identifier",
                    )
                if name not in self.base_colors:
                    self.error(
                        f"{location}.colors.{name}",
                        "overlay can only override an existing color token",
                    )
                if not isinstance(modes, dict):
                    self.error(f"{location}.colors.{name}", "must be an object")
                    continue
                for mode in ("light", "dark"):
                    value = modes.get(mode)
                    if not isinstance(value, str) or not HEX_COLOR_RE.fullmatch(value):
                        self.error(
                            f"{location}.colors.{name}.{mode}",
                            "expected #RRGGBBAA",
                        )

        typography = overlay.get("typography", {})
        if not isinstance(typography, dict):
            self.error(f"{location}.typography", "must be an object")
        else:
            known_colors = self.base_colors
            for name, value in typography.items():
                if name != name.lower():
                    self.error(
                        f"{location}.typography.{name}",
                        "typography keys must be lowercase because variants are normalized by the renderer",
                    )
                if name not in self.base_typography:
                    self.error(
                        f"{location}.typography.{name}",
                        "overlay can only override an existing typography token",
                    )
                if not isinstance(value, dict):
                    self.error(
                        f"{location}.typography.{name}",
                        "must be an object",
                    )
                    continue
                for field in ("size", "weight", "lineHeight"):
                    if field in value and (
                        not isinstance(value[field], (int, float))
                        or isinstance(value[field], bool)
                        or value[field] < 0
                    ):
                        self.error(
                            f"{location}.typography.{name}.{field}",
                            "must be a non-negative number",
                        )
                color = value.get("color")
                if isinstance(color, str) and color not in known_colors:
                    self.error(
                        f"{location}.typography.{name}.color",
                        f"unknown color token {color!r}",
                    )

        for group, base_keys in (
            ("shape", self.base_shapes),
            ("image", self.base_images),
        ):
            value = overlay.get(group, {})
            if value is not None and not isinstance(value, dict):
                self.error(f"{location}.{group}", "must be an object")
            elif isinstance(value, dict):
                for name in value:
                    if name not in base_keys:
                        self.error(
                            f"{location}.{group}.{name}",
                            f"overlay can only override an existing {group} token",
                        )

        icons = overlay.get("icons", {})
        if icons is not None and not isinstance(icons, dict):
            self.error(f"{location}.icons", "must be an object")
        elif isinstance(icons, dict):
            base_icons = self.base_tokens.get("icons", {})
            for group, values in icons.items():
                if group not in base_icons:
                    self.error(
                        f"{location}.icons.{group}",
                        "overlay can only override an existing icon group",
                    )
                    continue
                if not isinstance(values, dict):
                    self.error(
                        f"{location}.icons.{group}",
                        "must be an object",
                    )
                    continue
                base_values = base_icons.get(group, {})
                for name in values:
                    if name not in base_values:
                        self.error(
                            f"{location}.icons.{group}.{name}",
                            "overlay can only override an existing icon token",
                        )

    def _validate_binding_paths(
        self,
        component: dict[str, Any],
        location: str,
        template_mode: bool,
    ) -> None:
        for node, node_location in _walk(component, location):
            # DataBinding is `additionalProperties: false`, so only a lone
            # `path` key is one. Anything else that happens to carry a `path`
            # string is ordinary data — `openWechatMiniProgram` args name a
            # mini-program page, and xCardTemplate.path is a data scope.
            if not isinstance(node, dict) or set(node) != {"path"}:
                continue
            if not isinstance(node["path"], str):
                continue
            path = node["path"]
            if not path:
                self.error(f"{node_location}.path", "binding path must not be empty")
                continue
            if template_mode and path.startswith("/"):
                self.error(
                    f"{node_location}.path",
                    "template bindings must be relative to the template instance",
                )
            if "." in path:
                self.error(
                    f"{node_location}.path",
                    "use '/' path segments instead of dotted binding syntax",
                )

    def _validate_function_call(
        self,
        node: Any,
        location: str,
        allow_unknown: bool,
    ) -> None:
        if not isinstance(node, dict) or not isinstance(node.get("call"), str):
            self.error(location, "function call must contain a string call")
            return
        call = node["call"]
        if call in SYSTEM_FUNCTIONS:
            self._validate_system_function(node, location, call)
            return
        schema = self.function_schemas.get(call)
        if schema is None:
            if not allow_unknown and call not in self.allowed_functions:
                self.error(
                    f"{location}.call",
                    f"function {call!r} is not declared by the active catalogs; "
                    "if the target host registers it, pass --allow-function "
                    f"{call} and list that dependency in the delivery notes",
                )
                return
            unknown = set(node) - {"call", "catalogId", "args"}
            if unknown:
                self.error(
                    location,
                    f"unsupported functionCall properties: {sorted(unknown)}",
                )
            if "catalogId" in node and not isinstance(node["catalogId"], str):
                self.error(f"{location}.catalogId", "must be a string")
            if "args" in node and not isinstance(node["args"], dict):
                self.error(f"{location}.args", "must be an object")
            return
        for message in _schema_errors(node, schema, location):
            self.error(location, message.removeprefix(f"{location}: "))
        if call in ACTION_ONLY_FUNCTIONS and not _in_action_context(location):
            self.error(
                f"{location}.call",
                f"action-only function {call!r} cannot be used as a property value",
            )
        if call == "switch":
            self._validate_switch_call(node, location)
        if call == "sequence":
            self._validate_sequence_call(node, location)
        if call == "setTimeout":
            args = node.get("args") if isinstance(node.get("args"), dict) else {}
            if isinstance(args, dict) and "action" in args:
                self._validate_action_object(
                    args["action"],
                    f"{location}.args.action",
                )

    def _validate_system_function(
        self,
        node: dict[str, Any],
        location: str,
        call: str,
    ) -> None:
        """Checks a `@`-prefixed system function against common_types.json.

        Only `@index` and `@hostEnv` take arguments, so the accepted shape
        comes from the schema rather than a local guess. The schema also
        pins `@hostEnv`'s key to a literal string: the core resolves the
        dependency when the component arrives, so a bound key is rejected.
        List-context enforcement happens per component set, where the list
        templates are actually known.
        """
        schema = self.system_function_schemas.get(call)
        if not isinstance(schema, dict):
            allowed = {"call", "args"} if call in {"@index", "@hostEnv"} else {"call"}
            unknown = sorted(set(node) - allowed)
            if unknown:
                self.error(
                    location,
                    f"system function {call!r} does not take {unknown}",
                )
            return
        for message in _schema_errors(node, schema, location):
            self.error(location, message.removeprefix(f"{location}: "))
        declared = set(schema.get("properties") or {})
        unknown = sorted(set(node) - declared)
        if unknown:
            self.error(
                location,
                f"system function {call!r} does not take {unknown}",
            )

    def _is_agent_only(self, call: str) -> bool:
        """True when only the agent may run this function.

        Such a call needs a round trip, so anything evaluated inline — a
        tracking param in particular — cannot wait for it.
        """
        for catalog in (self.xcard_catalog, self.basic_catalog):
            definition = (catalog.get("functions") or {}).get(call)
            if isinstance(definition, dict):
                return definition.get("allowedCallers") == "agentOnly"
        return False

    def _validate_index_context(
        self,
        component: dict[str, Any],
        location: str,
        in_list_context: bool,
        in_choice_context: bool = False,
    ) -> None:
        """Rejects `@index` / `@indexValue` outside a list template subtree,
        and `@selected` outside a ChoiceGroup option.

        Both resolve against the current list item, so away from a list they
        have nothing to resolve against. The renderer does not fail the
        message for it, which is exactly why it has to be caught here. A
        ChoiceGroup's own `action` runs in the tapped option's scope, so all
        three are legal inside it.
        """
        if in_list_context and in_choice_context:
            return
        option_action = (
            f"{location}.action" if component.get("component") == "ChoiceGroup" else None
        )
        map_templates = [
            f"{node_location}.args.template"
            for node, node_location in _walk(component, location)
            if isinstance(node, dict) and node.get("call") == "map"
        ]
        for node, node_location in _walk(component, location):
            if not isinstance(node, dict):
                continue
            if option_action and (
                node_location == option_action
                or node_location.startswith(option_action + ".")
            ):
                continue
            call = node.get("call")
            if not isinstance(call, str):
                continue
            in_map_template = any(
                node_location == prefix or node_location.startswith(prefix + ".")
                or node_location.startswith(prefix + "[")
                for prefix in map_templates
            )
            if call in LIST_CONTEXT_FUNCTIONS and not in_list_context and not in_map_template:
                self.error(
                    f"{node_location}.call",
                    f"{call} resolves against the current list item, so it "
                    "may only be used inside a list template subtree or map template",
                )
            if call in CHOICE_CONTEXT_FUNCTIONS and not in_choice_context:
                self.error(
                    f"{node_location}.call",
                    f"{call} answers for a ChoiceGroup option, so it may only "
                    "be used inside an option template or the group's action",
                )

    def _validate_calls(self, component: dict[str, Any], location: str) -> None:
        map_templates = [
            f"{node_location}.args.template"
            for node, node_location in _walk(component, location)
            if isinstance(node, dict) and node.get("call") == "map"
        ]
        for node, node_location in _walk(component, location):
            if not isinstance(node, dict) or not isinstance(node.get("call"), str):
                continue
            if node["call"] in ACTION_ONLY_FUNCTIONS and any(
                node_location == prefix or node_location.startswith(prefix + ".")
                or node_location.startswith(prefix + "[")
                for prefix in map_templates
            ):
                self.error(node_location, "map template cannot execute action-only functions")
            if node_location.endswith(".action.functionCall"):
                continue
            if ".combinedActions." in node_location and node_location.endswith(
                ".functionCall"
            ):
                continue
            self._validate_function_call(
                node,
                node_location,
                allow_unknown=False,
            )

    def _validate_action(self, component: dict[str, Any], location: str) -> None:
        if "action" in component:
            self._validate_action_object(component["action"], f"{location}.action")
        if "combinedActions" in component:
            self._validate_combined_actions(component, location)

    def _validate_combined_actions(
        self,
        component: dict[str, Any],
        location: str,
    ) -> None:
        combined = component["combinedActions"]
        combined_location = f"{location}.combinedActions"
        component_type = component.get("component")
        if component_type not in COMBINED_ACTION_COMPONENTS:
            self.warning(
                combined_location,
                f"{component_type} does not declare combinedActions, so no gesture "
                "on it runs; wrap it in a Clickable instead",
            )
        if "action" in component:
            self.error(
                location,
                "action and combinedActions are mutually exclusive",
            )
        if not isinstance(combined, dict):
            self.error(combined_location, "must be an object")
            return
        # Warned rather than rejected: the schema keeps gesture names open so a
        # card can bind one a later renderer adds. That is also what lets a
        # `longpress` typo through, which is exactly what this names.
        unknown = sorted(set(combined) - set(ACTION_TRIGGERS))
        if unknown:
            one = len(unknown) == 1
            named = repr(unknown[0]) if one else str(unknown)
            self.warning(
                combined_location,
                f"{component_type} has "
                f"{'an unrecognised gesture' if one else 'unrecognised gestures'} "
                f"{named}; no renderer runs {'it' if one else 'them'} — known "
                f"gestures are {list(ACTION_TRIGGERS)}",
            )
        if not combined:
            self.error(combined_location, "needs at least one gesture")
        for key in ACTION_TRIGGERS:
            if key in combined:
                self._validate_action_object(
                    combined[key],
                    f"{combined_location}.{key}",
                )

    def _validate_action_object(self, action: Any, location: str) -> None:
        if not isinstance(action, dict):
            self.error(location, "must be an object")
            return
        unknown = set(action) - ACTION_OBJECT_KEYS
        if unknown:
            self.error(
                location,
                f"unsupported action properties: {sorted(unknown)}",
            )
        branches = [key for key in ("event", "functionCall") if key in action]
        if len(branches) != 1:
            self.error(
                location,
                "must contain exactly one of event or functionCall",
            )
            return
        if "resultPath" in action:
            if "event" in action:
                self.error(f"{location}.resultPath", "event has no function result")
            elif not isinstance(action["resultPath"], str):
                self.error(f"{location}.resultPath", "must be a string")
        if "event" in action:
            event = action["event"]
            if not isinstance(event, dict):
                self.error(f"{location}.event", "must be an object")
                return
            unknown_event = set(event) - {"name", "userMessage", "context"}
            if unknown_event:
                self.error(
                    f"{location}.event",
                    f"unsupported event properties: {sorted(unknown_event)}",
                )
            if not isinstance(event.get("name"), str) or not event["name"]:
                self.error(
                    f"{location}.event.name",
                    "must be a non-empty string",
                )
            if "context" in event and not isinstance(event["context"], dict):
                self.error(f"{location}.event.context", "must be an object")
        else:
            branch = branches[0]
            function = action[branch]
            self._validate_function_call(
                function,
                f"{location}.{branch}",
                allow_unknown=True,
            )
            no_result_actions = {
                "updateData",
                "sequence",
                "switch",
                "setTimeout",
                "closeModal",
                "publishDataModel",
            }
            if isinstance(function, dict) and function.get("call") in no_result_actions:
                if "resultPath" in action:
                    self.error(f"{location}.{branch}", "system actions do not return a result")
            if (
                isinstance(function, dict)
                and function.get("call") in ACTION_ONLY_FUNCTIONS - {"sequence"}
            ):
                args = function.get("args")
                misplaced = sorted(
                    set(args) & SEQUENCE_WAIT_KEYS if isinstance(args, dict) else set()
                )
                if misplaced:
                    self.error(
                        f"{location}.{branch}.args",
                        f"{misplaced} only apply to a sequence",
                    )
        if "checks" in action:
            self._validate_check_list(action["checks"], f"{location}.checks")
        if "throttle" in action:
            self._validate_throttle(action["throttle"], f"{location}.throttle")

    def _validate_throttle(self, throttle: Any, location: str) -> None:
        if not isinstance(throttle, dict):
            self.error(location, "must be an object")
            return
        unknown = set(throttle) - {"id", "duration", "toast"}
        if unknown:
            self.error(location, f"unsupported throttle properties: {sorted(unknown)}")
        if not isinstance(throttle.get("id"), str) or not throttle["id"]:
            self.error(f"{location}.id", "must be a non-empty string")
        if "duration" in throttle and not _is_type(throttle["duration"], "number"):
            self.error(f"{location}.duration", "must be a number")
        if "toast" in throttle and not isinstance(throttle["toast"], str):
            self.error(f"{location}.toast", "must be a string")

    def _validate_switch_call(self, node: dict[str, Any], location: str) -> None:
        args = node.get("args")
        if not isinstance(args, dict):
            return
        cases = args.get("cases")
        if not isinstance(cases, list):
            return
        match_types: list[str] = []
        for index, case in enumerate(cases):
            case_location = f"{location}.args.cases[{index}]"
            if not isinstance(case, dict):
                continue
            match = case.get("match")
            if isinstance(match, dict) and ("path" in match or "call" in match):
                self.error(f"{case_location}.match", "match must be a literal")
            else:
                match_types.append(_literal_type_name(match))
            if "action" in case:
                self._validate_action_object(case["action"], f"{case_location}.action")
        if len(set(match_types)) > 1:
            self.error(
                f"{location}.args.cases",
                "switch match values must all share the same literal type",
            )
        if "default" in args:
            self._validate_action_object(args["default"], f"{location}.args.default")

    def _validate_sequence_call(self, node: dict[str, Any], location: str) -> None:
        args = node.get("args")
        if not isinstance(args, dict):
            return
        if "waitForResults" in args and not isinstance(args["waitForResults"], bool):
            self.error(f"{location}.args.waitForResults", "must be a literal boolean")
        if "awaitTimeoutMs" in args:
            timeout = args["awaitTimeoutMs"]
            if (
                isinstance(timeout, bool)
                or not isinstance(timeout, (int, float))
                or timeout < 0
                or timeout != int(timeout)
            ):
                self.error(
                    f"{location}.args.awaitTimeoutMs",
                    "must be a literal non-negative integer",
                )
            if args.get("waitForResults") is not True:
                self.error(
                    f"{location}.args.awaitTimeoutMs",
                    "needs waitForResults: true",
                )
        actions = args.get("actions")
        if not isinstance(actions, list):
            return
        events = 0
        for index, action in enumerate(actions):
            action_location = f"{location}.args.actions[{index}]"
            self._validate_action_object(action, action_location)
            if isinstance(action, dict) and "event" in action:
                events += 1
        if events > 1:
            self.error(
                f"{location}.args.actions",
                "sequence may contain at most one event",
            )

    def _validate_checks(self, component: dict[str, Any], location: str) -> None:
        checks = component.get("checks")
        if checks is None:
            return
        self._validate_check_list(checks, f"{location}.checks")

    def _validate_check_list(self, checks: Any, location: str) -> None:
        if not isinstance(checks, list):
            self.error(location, "must be an array")
            return
        for index, check in enumerate(checks):
            check_location = f"{location}[{index}]"
            if not isinstance(check, dict):
                self.error(check_location, "must be an object")
                continue
            unknown = set(check) - {"condition", "message"}
            if unknown:
                self.error(
                    check_location,
                    f"unsupported check properties: {sorted(unknown)}",
                )
            condition = check.get("condition")
            if not isinstance(condition, dict):
                self.error(
                    f"{check_location}.condition",
                    "must be a data binding or function call",
                )
            elif "path" in condition:
                if set(condition) != {"path"} or not isinstance(
                    condition["path"], str
                ):
                    self.error(
                        f"{check_location}.condition",
                        "data binding must contain only a string path",
                    )
                else:
                    self.warning(
                        f"{check_location}.condition",
                        "path-only checks are not coerced to boolean; prefer a function",
                    )
            elif "call" not in condition:
                self.error(
                    f"{check_location}.condition",
                    "must contain path or call",
                )
            if "message" in check and not isinstance(check["message"], str):
                self.error(f"{check_location}.message", "must be a string")

    def _validate_style_tokens(
        self,
        component: dict[str, Any],
        location: str,
    ) -> None:
        style = component.get("style")
        if not isinstance(style, dict) or "path" in style or "call" in style:
            return
        for key in COLOR_STYLE_KEYS:
            value = style.get(key)
            if isinstance(value, str) and value not in self.colors:
                self.error(
                    f"{location}.style.{key}",
                    f"unknown color token {value!r}",
                )
        shape = style.get("shape")
        if isinstance(shape, str) and shape not in self.shapes:
            self.error(
                f"{location}.style.shape",
                f"unknown shape token {shape!r}",
            )

    def _validate_style_layout(
        self,
        component: dict[str, Any],
        location: str,
        parent_type: str | None,
    ) -> None:
        style = component.get("style")
        if not isinstance(style, dict) or "path" in style or "call" in style:
            return
        if "fillMaxWidth" in style and "width" in style:
            self.error(
                f"{location}.style",
                "fillMaxWidth is mutually exclusive with width",
            )
        if "fillMaxHeight" in style and "height" in style:
            self.error(
                f"{location}.style",
                "fillMaxHeight is mutually exclusive with height",
            )
        if (
            "aspectRatio" in style
            and "width" in style
            and "height" in style
        ):
            self.warning(
                f"{location}.style.aspectRatio",
                "ignored when both width and height are set",
            )
        if parent_type == "Row" and "weight" in component and "fillMaxWidth" in style:
            self.error(
                f"{location}.style",
                "weight is mutually exclusive with fillMaxWidth on a Row child",
            )
        if parent_type == "Column" and "weight" in component and "fillMaxHeight" in style:
            self.error(
                f"{location}.style",
                "weight is mutually exclusive with fillMaxHeight on a Column child",
            )
    def _validate_component(
        self,
        component: Any,
        location: str,
        template_mode: bool,
    ) -> None:
        if not isinstance(component, dict):
            self.error(location, "component must be an object")
            return
        component_id = component.get("id")
        component_type = component.get("component")
        if not isinstance(component_id, str) or not component_id:
            self.error(f"{location}.id", "component id must be a non-empty string")
        if not isinstance(component_type, str) or not component_type:
            self.error(
                f"{location}.component",
                "component type must be a non-empty string",
            )
            return
        if component_type not in self.allowed_components:
            self.error(
                f"{location}.component",
                f"component {component_type!r} is not declared by the active catalogs",
            )
            return

        schema = self.component_schemas.get(component_type)
        if schema:
            for message in _schema_errors(component, schema, location):
                self.error(location, message.removeprefix(f"{location}: "))
            # Component schemas are open, so a renderer carries a property it
            # does not know instead of failing the message. Nothing would then
            # tell an author that `stlye` or `onClick` silently does nothing, so
            # the strictness moves here and names the key.
            declared = set(schema.get("properties") or {}) | COMMON_COMPONENT_KEYS
            if component_type in GRID_AXES:
                # Reported as errors with the reason by `_validate_grids`.
                declared |= GRID_REJECTED_KEYS | {GRID_AXES[component_type]["other"][0]}
            unknown = sorted(set(component) - declared)
            if unknown:
                one = len(unknown) == 1
                self.warning(
                    location,
                    f"{component_type} has unrecognised "
                    f"{'property' if one else 'properties'} {unknown}; "
                    f"no renderer reads {'it' if one else 'them'}",
                )
        else:
            unknown = set(component) - COMMON_COMPONENT_KEYS
            if unknown:
                self.warning(
                    location,
                    f"custom component fields were not schema-checked: {sorted(unknown)}",
                )

        self._validate_binding_paths(component, location, template_mode)
        self._validate_calls(component, location)
        self._validate_action(component, location)
        self._validate_checks(component, location)
        self._validate_style_tokens(component, location)
        self._validate_tracking(component, location, component_type)

        if component_type in INTERACTIVE_COMPONENTS:
            if "action" not in component and "combinedActions" not in component:
                self.error(
                    location,
                    "interactive component needs action or combinedActions",
                )
        if component_type == TEMPLATE_COMPONENT:
            self._validate_template_reference(component, location)
        if component_type == "WebCard" and not self.allow_webcard:
            self.error(
                f"{location}.component",
                "WebCard loads a page through the host URL policy; without one "
                "the slot is 0 tall. Pass --allow-webcard once the user has "
                "asked for it.",
            )
        if component_type == "Icon":
            name = component.get("name")
            if isinstance(name, str) and normalize_token_name(name) not in self.icons:
                self.error(
                    f"{location}.name",
                    f"unknown icon {name!r}; use a catalog or Yuanbao token icon",
                )
        if component_type == "SvgView":
            self._validate_svg_view(component, location)
        if component_type == "RichText":
            self._validate_rich_text(component, location)
        if component_type == "Label":
            self._validate_label(component, location)
        if component_type == "IconButton":
            name = component.get("name")
            if isinstance(name, str) and normalize_token_name(name) not in self.icons:
                self.error(
                    f"{location}.name",
                    f"unknown icon {name!r}; use a catalog or Yuanbao token icon",
                )

    def _validate_svg_view(self, component: dict[str, Any], location: str) -> None:
        """design/xcard-svgview §3.6. url and source are mutually exclusive."""
        has_url = "url" in component
        has_source = "source" in component
        if has_url == has_source:
            self.error(
                location,
                "SvgView needs exactly one of url and source",
            )
        if "urlDark" in component and not has_url:
            self.error(
                f"{location}.urlDark",
                "urlDark is only valid together with url",
            )
        if "sourceDark" in component and not has_source:
            self.error(
                f"{location}.sourceDark",
                "sourceDark is only valid together with source",
            )
        for key in ("source", "sourceDark"):
            value = component.get(key)
            if isinstance(value, str) and len(value.encode("utf-8")) > 65536:
                self.error(
                    f"{location}.{key}",
                    "inline SVG is longer than 65536 UTF-8 bytes",
                )
        fit = component.get("fit")
        if isinstance(fit, str) and fit not in {"contain", "cover", "fill", "none"}:
            self.error(
                f"{location}.fit",
                "fit must be contain, cover, fill, or none",
            )
        style = component.get("style")
        if isinstance(style, dict) and "color" in style:
            self.error(
                f"{location}.style.color",
                "SvgView has no style.color; recolor the decoded image with style.tint",
            )

    def _validate_label(self, component: dict[str, Any], location: str) -> None:
        """design/xcard-label/spec.md §10."""
        for key in ("action", "combinedActions"):
            if key in component:
                self.error(
                    f"{location}.{key}",
                    "Label is not tappable; wrap it in a Clickable to give it an action",
                )
        style = component.get("style")
        if isinstance(style, dict) and "path" not in style and "call" not in style:
            ignored = sorted(set(style) & LABEL_IGNORED_STYLE_KEYS)
            if ignored:
                self.warning(
                    f"{location}.style",
                    f"Label does not read {ignored}; its type, fill and corner come "
                    "from variant, and the fill is style.color at 8%",
                )
        text = component.get("text")
        if isinstance(text, str) and ("\n" in text or "\r" in text):
            self.warning(
                f"{location}.text",
                "Label draws one line; a line break renders as a space",
            )

    def _validate_rich_text(self, component: dict[str, Any], location: str) -> None:
        """design/xcard-richtext/spec.md §10."""
        if "action" in component:
            self.error(
                f"{location}.action",
                "RichText takes no action; put the action on a span, or use "
                "combinedActions for the whole paragraph",
            )
        spans = component.get("spans")
        spans_location = f"{location}.spans"
        if isinstance(spans, dict) and ("path" in spans or "call" in spans):
            self.error(
                spans_location,
                "spans must be a literal array; bind each span's text or style instead",
            )
            return
        if not isinstance(spans, list) or not spans:
            self.error(spans_location, "spans must be a non-empty array")
            return
        for index, span in enumerate(spans):
            span_location = f"{spans_location}[{index}]"
            if not isinstance(span, dict):
                self.error(span_location, "span must be an object")
                continue
            unknown = sorted(set(span) - RICH_TEXT_SPAN_KEYS)
            if unknown:
                self.error(
                    span_location,
                    f"unsupported span properties {unknown}; a span takes "
                    f"{sorted(RICH_TEXT_SPAN_KEYS)}",
                )
            if "text" not in span:
                self.error(span_location, "span needs text")
            text = span.get("text")
            if isinstance(text, str) and MARKDOWN_TRACE_RE.search(text):
                self.warning(
                    f"{span_location}.text",
                    "Markdown is not interpreted and renders literally; use "
                    "span style (fontWeight, fontStyle, textDecoration) and a "
                    "span action instead",
                )
            style = span.get("style")
            if isinstance(style, dict) and "path" not in style and "call" not in style:
                extra = sorted(set(style) - RICH_TEXT_SPAN_STYLE_KEYS)
                if extra:
                    self.error(
                        f"{span_location}.style",
                        f"a span style takes only {sorted(RICH_TEXT_SPAN_STYLE_KEYS)}; "
                        f"got {extra}. Size and layout belong to the RichText",
                    )
                color = style.get("color")
                if isinstance(color, str) and color not in self.colors:
                    self.error(
                        f"{span_location}.style.color",
                        f"unknown color token {color!r}",
                    )
            if "action" in span:
                self._validate_action_object(span["action"], f"{span_location}.action")

    def _validate_template_reference(
        self,
        component: dict[str, Any],
        location: str,
    ) -> None:
        """Checks an `xCardTemplate` reference, the part that is knowable here.

        Whether `templateId` resolves at runtime is not: the host fetches the
        package from an external system and the protocol carries no version,
        so existence and revision are both outside this file.
        """
        if not self.allow_template:
            self.error(
                f"{location}.component",
                f"{TEMPLATE_COMPONENT} depends on a template package the host "
                "fetches externally; an unresolved reference renders blank. "
                "Pass --allow-template once the user has asked for it.",
            )

        template_id = component.get("templateId")
        if isinstance(template_id, str):
            if not template_id:
                self.error(
                    f"{location}.templateId",
                    "templateId must not be empty",
                )
        elif isinstance(template_id, dict):
            if not ({"path", "call"} & set(template_id)):
                self.error(
                    f"{location}.templateId",
                    "must be a literal, a {path} binding or a {call}",
                )
        elif template_id is not None:
            self.error(
                f"{location}.templateId",
                "must be a string, a {path} binding or a {call}",
            )

        if "template_version" in component:
            self.error(
                f"{location}.template_version",
                "the protocol carries no template_version; the version lives "
                "in the package meta.json and nothing reads it here",
            )

        for key in ("action", "combinedActions"):
            if key in component:
                self.error(
                    f"{location}.{key}",
                    f"{TEMPLATE_COMPONENT} does not take {key}; wrap the "
                    "content in a Clickable instead",
                )

        unknown = sorted(set(component) - TEMPLATE_REFERENCE_KEYS - COMMON_COMPONENT_KEYS)
        if unknown:
            self.warning(
                location,
                f"{TEMPLATE_COMPONENT} has unrecognised properties {unknown}; "
                "no renderer reads them",
            )

    def _validate_tracking(
        self,
        component: dict[str, Any],
        location: str,
        component_type: str,
    ) -> None:
        """Checks every `tracking` anchor on and under a component.

        Position carries the meaning: on the component it is an exposure
        anchor, inside an action it is that action's click anchor. Both are
        gated behind an explicit profile, because the key names and the id
        vocabulary are a host contract rather than part of the protocol.
        """
        anchors: list[tuple[Any, str]] = []
        for node, node_location in _walk(component, location):
            if isinstance(node, dict) and "tracking" in node:
                anchors.append((node["tracking"], f"{node_location}.tracking"))

        if not anchors:
            return

        if self.tracking_profile is None:
            self.error(
                f"{location}.tracking",
                "tracking key names and id vocabulary are a host contract, "
                "not part of the protocol. Pass --tracking-profile "
                f"{{{','.join(TRACKING_PROFILES)}}} once the user has asked "
                "for tracking and named the host.",
            )
            return

        for anchor, anchor_location in anchors:
            self._validate_tracking_anchor(anchor, anchor_location)

        if component_type in {"Text", "Card", "Row", "Column", "Box", "Image"}:
            action = component.get("action")
            if isinstance(action, dict) and "tracking" in action:
                self.error(
                    f"{location}.action.tracking",
                    f"{component_type} does not fire a click, so a click "
                    "anchor here never reports; wrap it in a Clickable",
                )

    def _validate_tracking_anchor(self, anchor: Any, location: str) -> None:
        if not isinstance(anchor, dict):
            self.error(location, "tracking must be an object")
            return

        unknown = sorted(set(anchor) - {"id", "params", "strategy"})
        if unknown:
            self.error(location, f"unsupported tracking properties: {unknown}")

        anchor_id = anchor.get("id")
        if not isinstance(anchor_id, str) or not anchor_id:
            self.error(
                f"{location}.id",
                "id must be a non-empty string; an empty id drops the whole "
                "anchor with no error at runtime",
            )
        else:
            if len(anchor_id) > TRACKING_ID_WARN_LENGTH:
                self.warning(
                    f"{location}.id",
                    f"id is longer than {TRACKING_ID_WARN_LENGTH} characters; "
                    "the renderer logs a warning and downstream may truncate",
                )
            if anchor_id.split("#")[0] in DEPRECATED_TRACKING_ID_PREFIXES:
                self.error(
                    f"{location}.id",
                    f"{anchor_id.split('#')[0]!r} is the retired Yuanbao "
                    "event-code scheme; use a plain business name",
                )

        if "strategy" in anchor and not isinstance(anchor["strategy"], str):
            self.error(f"{location}.strategy", "strategy must be a string")

        params = anchor.get("params")
        if params is None:
            return
        if not isinstance(params, dict):
            self.error(f"{location}.params", "params must be an object")
            return
        self._validate_tracking_params(params, f"{location}.params", global_scope=False)

    def _validate_tracking_params(
        self,
        params: dict[str, Any],
        location: str,
        *,
        global_scope: bool,
    ) -> None:
        for key, value in params.items():
            key_location = f"{location}.{key}"
            if (
                self.tracking_profile == "yuanbao"
                and key not in YUANBAO_TRACKING_PARAM_KEYS
            ):
                self.error(
                    key_location,
                    f"the Yuanbao host only accepts "
                    f"{sorted(YUANBAO_TRACKING_PARAM_KEYS)}; {key!r} is dropped",
                )

            if isinstance(value, dict) and ("path" in value or "call" in value):
                if global_scope:
                    self.error(
                        key_location,
                        "global tracking params only accept literals; a "
                        "{path} or {call} here is dropped and raises onError",
                    )
                    continue
                # The call itself is already checked by _validate_calls, which
                # walks the whole component. Only the tracking-specific rule
                # belongs here: an agentOnly function cannot be awaited while
                # reporting, so the renderer drops the key.
                call = value.get("call")
                if isinstance(call, str) and self._is_agent_only(call):
                    self.error(
                        key_location,
                        f"{call!r} is agentOnly; tracking cannot await a round "
                        "trip, so the renderer drops this key",
                    )
                continue

            if value is None or isinstance(value, (dict, list)):
                self.error(
                    key_location,
                    f"tracking param values must be scalars; "
                    f"{_literal_type_name(value)} is dropped",
                )

    def _validate_global_tracking_params(
        self,
        payload: dict[str, Any],
        location: str,
    ) -> None:
        extensions = (payload.get("metadata") or {}).get("extensions")
        if not isinstance(extensions, dict):
            return
        params = extensions.get(GLOBAL_TRACKING_PARAMS_KEY)
        if params is None:
            return
        params_location = (
            f"{location}.metadata.extensions.{GLOBAL_TRACKING_PARAMS_KEY}"
        )
        if self.tracking_profile is None:
            self.error(
                params_location,
                "global tracking params need an explicit host contract. Pass "
                f"--tracking-profile {{{','.join(TRACKING_PROFILES)}}}.",
            )
            return
        if not isinstance(params, dict):
            self.error(params_location, "must be an object")
            return
        self._validate_tracking_params(params, params_location, global_scope=True)

    def _validate_component_set(
        self,
        components: Any,
        location: str,
        template_mode: bool,
    ) -> dict[str, dict[str, Any]]:
        if not isinstance(components, list) or not components:
            self.error(location, "components must be a non-empty array")
            return {}

        result: dict[str, dict[str, Any]] = {}
        for index, component in enumerate(components):
            component_location = f"{location}[{index}]"
            self._validate_component(component, component_location, template_mode)
            if not isinstance(component, dict):
                continue
            component_id = component.get("id")
            if not isinstance(component_id, str):
                continue
            if component_id in result:
                self.error(component_location, f"duplicate component id {component_id!r}")
            result[component_id] = component
        parent_type: dict[str, str] = {}
        for component in result.values():
            ctype = component.get("component")
            if not isinstance(ctype, str):
                continue
            refs: list[str] = []
            child = component.get("child")
            if isinstance(child, str):
                refs.append(child)
            children = component.get("children")
            if isinstance(children, list):
                refs.extend(item for item in children if isinstance(item, str))
            for ref in refs:
                parent_type[ref] = ctype
        list_context = self._list_context_ids(result)
        choice_context = self._list_context_ids(result, choice_only=True)
        for component_id, component in result.items():
            self._validate_style_layout(
                component,
                f"{location}.{component_id}",
                parent_type.get(component_id),
            )
            self._validate_index_context(
                component,
                f"{location}.{component_id}",
                component_id in list_context,
                component_id in choice_context,
            )
        self._validate_grids(result, location)
        self._validate_pagers(result, location)
        return result

    def _validate_pagers(
        self,
        components: dict[str, dict[str, Any]],
        location: str,
    ) -> None:
        """Pager / DotIndicator rules (design/xcard-pager spec §13.2)."""
        parents: dict[str, dict[str, Any]] = {}
        child_ids: dict[str, list[str]] = {}
        for component_id, component in components.items():
            refs: list[str] = []
            children = component.get("children")
            if isinstance(children, list):
                refs = [item for item in children if isinstance(item, str)]
            elif isinstance(children, dict) and isinstance(children.get("componentId"), str):
                refs = [children["componentId"]]
            for key in REFERENCE_KEYS:
                if isinstance(component.get(key), str):
                    refs.append(component[key])
            child_ids[component_id] = refs
            for ref in refs:
                parents.setdefault(ref, component)

        pager_paths: set[str] = set()
        for component in components.values():
            if component.get("component") != "Pager":
                continue
            current = component.get("currentPage")
            if isinstance(current, dict) and isinstance(current.get("path"), str):
                pager_paths.add(current["path"])

        for component_id, component in components.items():
            ctype = component.get("component")
            component_location = f"{location}.{component_id}"
            if ctype == "Pager":
                self._validate_pager(
                    component,
                    component_location,
                    parents.get(component_id),
                    components,
                    child_ids,
                )
            elif ctype == "DotIndicator":
                self._validate_dot_indicator(component, component_location, pager_paths)

    def _validate_pager(
        self,
        pager: dict[str, Any],
        location: str,
        parent: dict[str, Any] | None,
        components: dict[str, dict[str, Any]],
        child_ids: dict[str, list[str]],
    ) -> None:
        for key in ("direction", "orientation"):
            if key in pager:
                self.error(
                    f"{location}.{key}",
                    "Pager pages horizontally only in this version; delete it",
                )
        for key in ("combinedActions", "action"):
            if key in pager:
                self.error(
                    f"{location}.{key}",
                    "a Pager takes no gestures; put a Clickable inside the page",
                )
        if "indicator" in pager:
            self.error(
                f"{location}.indicator",
                "a Pager has no built-in indicator; add a DotIndicator bound to "
                "the same path as currentPage",
            )
        children = pager.get("children")
        if isinstance(children, list) and len(children) > 50:
            self.error(
                f"{location}.children",
                "a Pager draws at most 50 pages; the rest are dropped",
            )
        current = pager.get("currentPage")
        if not isinstance(current, dict) and "currentPage" in pager and (
            isinstance(current, bool)
            or not isinstance(current, (int, float))
            or current != int(current)
            or current < 0
        ):
            self.error(
                f"{location}.currentPage",
                "currentPage must be a non-negative integer or a {path} binding",
            )
        auto_play = pager.get("autoPlay")
        if isinstance(auto_play, dict):
            interval = auto_play.get("interval")
            if (
                isinstance(interval, (int, float))
                and not isinstance(interval, bool)
                and interval < 2000
            ):
                self.warning(
                    f"{location}.autoPlay.interval",
                    "autoPlay.interval below 2000ms is raised to 2000ms",
                )
        style = pager.get("style")
        style_known = style is None or (
            isinstance(style, dict) and not ("path" in style or "call" in style)
        )
        style = style if style_known and isinstance(style, dict) else {}
        for key in ("peek", "pageSpacing"):
            value = style.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value < 0:
                self.error(f"{location}.style.{key}", "must not be negative")

        if pager.get("id") == "root":
            self.warning(
                location,
                "a root Pager fails the whole message on a host that predates "
                "it; nest it in a Column",
            )
        parent_type = parent.get("component") if parent else None
        if style_known and "width" not in style:
            if parent_type == "List" and parent.get("direction") == "horizontal":
                self.error(
                    f"{location}.style",
                    "a Pager in a horizontal List needs style.width; without "
                    "one it is drawn 320dp wide",
                )
            if parent_type == "Row" and "weight" not in pager:
                self.error(
                    location,
                    "a Pager in a Row needs weight or style.width; without "
                    "either it is laid out as weight: 1",
                )

        # Pages that scroll sideways fight the pager for the swipe; a pager
        # anywhere below this one is not supported at all.
        page_ids = child_ids.get(pager.get("id", ""), [])
        for page_id in page_ids:
            page = components.get(page_id, {})
            ptype = page.get("component")
            if ptype == "HorizontalGrid" or (
                ptype == "List" and page.get("direction") == "horizontal"
            ):
                self.warning(
                    f"{location}.children",
                    f"page {page_id!r} scrolls horizontally and competes with "
                    "the Pager for the swipe",
                )
        seen: set[str] = set()
        pending = list(page_ids)
        while pending:
            descendant_id = pending.pop()
            if descendant_id in seen:
                continue
            seen.add(descendant_id)
            descendant = components.get(descendant_id)
            if descendant is None:
                continue
            if descendant.get("component") == "Pager":
                self.error(
                    location,
                    f"Pager {descendant_id!r} sits inside this Pager; nested "
                    "pagers are not supported",
                )
                break
            pending.extend(child_ids.get(descendant_id, []))

    def _validate_dot_indicator(
        self,
        dots: dict[str, Any],
        location: str,
        pager_paths: set[str],
    ) -> None:
        count = dots.get("count")
        if not isinstance(count, (dict, list)) and "count" in dots and (
            isinstance(count, bool)
            or not isinstance(count, (int, float))
            or count != int(count)
            or not 0 <= count <= 50
        ):
            self.error(
                f"{location}.count",
                "count must be an integer from 0 to 50, an array, or a {path} binding",
            )
        style = dots.get("style")
        if isinstance(style, dict) and not ("path" in style or "call" in style):
            for key in ("dotSize", "activeDotWidth"):
                value = style.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value <= 0:
                    self.error(f"{location}.style.{key}", "must be greater than 0")
            spacing = style.get("dotSpacing")
            if isinstance(spacing, (int, float)) and not isinstance(spacing, bool) and spacing < 0:
                self.error(f"{location}.style.dotSpacing", "must not be negative")
        current = dots.get("current")
        bound = isinstance(current, dict) and isinstance(current.get("path"), str)
        if dots.get("interactive") is True and not bound:
            self.warning(
                f"{location}.current",
                "an interactive DotIndicator with a literal current only moves "
                "its own highlight; bind current to the Pager's currentPage path",
            )
        if bound and current["path"] not in pager_paths:
            self.warning(
                f"{location}.current",
                f"no Pager in this card binds currentPage to {current['path']!r}; "
                "the dots will not follow a pager",
            )
        if dots.get("id") == "root":
            self.warning(
                location,
                "a root DotIndicator fails the whole message on a host that "
                "predates it; nest it in a Column",
            )

    def _validate_grids(
        self,
        components: dict[str, dict[str, Any]],
        location: str,
    ) -> None:
        """VerticalGrid / HorizontalGrid rules (design/xcard-grid spec §12.2).

        Template children count as children here: the item a grid expands
        per entry is sized by the grid's cell exactly like a literal child.
        """
        parents: dict[str, dict[str, Any]] = {}
        for component in components.values():
            children = component.get("children")
            refs: list[str] = []
            if isinstance(children, list):
                refs = [item for item in children if isinstance(item, str)]
            elif isinstance(children, dict) and isinstance(
                children.get("componentId"), str
            ):
                refs = [children["componentId"]]
            if isinstance(component.get("child"), str):
                refs.append(component["child"])
            for ref in refs:
                parents[ref] = component

        for component_id, component in components.items():
            component_location = f"{location}.{component_id}"
            ctype = component.get("component")
            if ctype in GRID_AXES:
                self._validate_grid(
                    component, component_location, parents.get(component_id)
                )
            parent = parents.get(component_id)
            if parent is not None and parent.get("component") in GRID_AXES:
                self._validate_grid_child(component, component_location, parent)

    def _validate_grid(
        self,
        grid: dict[str, Any],
        location: str,
        parent: dict[str, Any] | None,
    ) -> None:
        gtype = grid["component"]
        axes = GRID_AXES[gtype]
        tracks_key = axes["tracks"]
        other_key, other_type = axes["other"]
        if tracks_key in grid:
            tracks = grid[tracks_key]
            if isinstance(tracks, dict):
                self.error(
                    f"{location}.{tracks_key}",
                    f"{tracks_key} takes a fixed track count only; adaptive "
                    "and fixedSize tracks are not supported",
                )
            elif (
                isinstance(tracks, bool)
                or not isinstance(tracks, (int, float))
                or tracks != int(tracks)
                or not 1 <= tracks <= GRID_MAX_TRACKS
            ):
                self.error(
                    f"{location}.{tracks_key}",
                    f"{tracks_key} must be an integer from 1 to "
                    f"{GRID_MAX_TRACKS}; anything else renders as 2",
                )
        if other_key in grid:
            self.error(
                f"{location}.{other_key}",
                f"{gtype} does not take {other_key}; use {other_type} for a "
                f"grid laid out by {other_key}",
            )
        for key in ("direction", "orientation"):
            if key in grid:
                self.error(
                    f"{location}.{key}",
                    "the direction is the component: VerticalGrid or HorizontalGrid",
                )
        for key in ("justify", "horizontalArrangement", "verticalArrangement"):
            if key in grid:
                self.error(
                    f"{location}.{key}",
                    "tracks always fill the grid, so there is nothing to distribute",
                )
        for key in ("contentAlignment", "align"):
            if key in grid:
                self.error(
                    f"{location}.{key}",
                    "a grid does not align inside its cells; wrap a child in "
                    "a Box to position it",
                )

        if "scrollable" in grid:
            self.error(
                f"{location}.scrollable",
                "scrollable was removed: a grid is lazy and always scrolls "
                "inside itself past its length; delete it",
            )

        style = grid.get("style")
        # A bound style is only known at runtime; the rules that read what
        # the style leaves out skip it.
        style_known = style is None or (
            isinstance(style, dict) and not ("path" in style or "call" in style)
        )
        style = style if style_known and isinstance(style, dict) else {}
        for key in ("spacing", "columnSpacing", "rowSpacing"):
            value = style.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value < 0:
                self.error(f"{location}.style.{key}", "must not be negative")
        if "lineSpacing" in style:
            self.error(
                f"{location}.style.lineSpacing",
                "a grid ignores lineSpacing; use rowSpacing / columnSpacing",
            )

        parent_type = parent.get("component") if parent else None
        if grid.get("id") == "root":
            self.warning(
                location,
                f"a root {gtype} fails the whole message on a host that "
                "predates it; nest it in a Column",
            )
        if style_known:
            if gtype == "HorizontalGrid" and "height" not in style:
                self.error(
                    f"{location}.style",
                    "HorizontalGrid needs style.height; without one it has no "
                    "rows to divide and collapses into a single row",
                )
            if (
                gtype == "VerticalGrid"
                and parent_type == "List"
                and parent.get("direction") == "horizontal"
                and "width" not in style
            ):
                self.error(
                    f"{location}.style",
                    "a VerticalGrid in a horizontal List needs style.width; "
                    "without one it collapses into a single column",
                )
            if (
                gtype == "VerticalGrid"
                and parent_type == "Row"
                and "weight" not in grid
                and "width" not in style
            ):
                self.error(
                    location,
                    "a VerticalGrid in a Row needs weight or style.width; "
                    "without either it is laid out as weight: 1",
                )

            scroll_size = axes["scroll_size"]
            weighted_parent = "Column" if gtype == "VerticalGrid" else "Row"
            scroll_bounded = (
                scroll_size in style
                or axes["scroll_fraction"] in style
                or ("weight" in grid and parent_type == weighted_parent)
            )
            template_children = isinstance(grid.get("children"), dict)
            # Every parent bounds a width except a horizontal List; almost
            # none bounds a height, so a VerticalGrid is flagged wherever it is.
            parent_unbounded = gtype == "VerticalGrid" or (
                parent_type == "List" and parent.get("direction") == "horizontal"
            )
            if template_children and not scroll_bounded and parent_unbounded:
                self.warning(
                    location,
                    "with no declared length, a grid in an unbounded parent "
                    "stops at 2048dp and scrolls inside past that",
                )

    def _validate_grid_child(
        self,
        child: dict[str, Any],
        location: str,
        grid: dict[str, Any],
    ) -> None:
        gtype = grid["component"]
        axes = GRID_AXES[gtype]
        if "weight" in child:
            self.error(f"{location}.weight", f"a {gtype} child takes no weight")
        if "span" in child:
            self.error(
                f"{location}.span",
                "grid items cannot span tracks; each takes one cell. Put "
                "full-width content outside the grid",
            )
        style = child.get("style")
        if isinstance(style, dict) and not ("path" in style or "call" in style):
            for key in axes["track_size"]:
                if key in style:
                    self.warning(
                        f"{location}.style.{key}",
                        f"overridden by the {gtype} cell; wrap the child in a "
                        "Box to make it smaller than the cell",
                    )
            if axes["scroll_fraction"] in style:
                self.warning(
                    f"{location}.style.{axes['scroll_fraction']}",
                    f"ignored inside a {gtype}",
                )
        else:
            style = {}

        ctype = child.get("component")
        scrolls_same_axis = (
            ctype == "List"
            and child.get("direction", "vertical") == axes["list_direction"]
        ) or ctype == gtype
        if scrolls_same_axis and axes["scroll_size"] not in style:
            self.error(
                location,
                f"a {ctype} scrolling along the {gtype}'s own axis needs "
                f"style.{axes['scroll_size']}; without one it expands to 2048dp",
            )
        if ctype in {"ConditionView", "Visibility", "PlatformSwitch"}:
            self.warning(
                location,
                "when this renders nothing it still takes its cell and the "
                "items after it do not move up; filter the data instead",
            )

    @staticmethod
    def _list_context_ids(
        components: dict[str, dict[str, Any]],
        choice_only: bool = False,
    ) -> set[str]:
        """Ids rendered once per list item, template roots and descendants.

        A dynamic list names its item template through
        `children: {componentId, path}`; everything reachable below that
        template is rendered per item too, so `@index` is legal there. A
        ChoiceGroup's `options.componentId` is such a template as well, and
        with [choice_only] it is the only kind collected: the ids where
        `@selected` has an option to answer for.
        """
        pending: list[str] = []
        for component in components.values():
            children = component.get("children")
            if not choice_only and isinstance(children, dict) and isinstance(
                children.get("componentId"), str
            ):
                pending.append(children["componentId"])
            options = component.get("options")
            if (
                component.get("component") == "ChoiceGroup"
                and isinstance(options, dict)
                and isinstance(options.get("componentId"), str)
            ):
                pending.append(options["componentId"])

        seen: set[str] = set()
        while pending:
            component_id = pending.pop()
            if component_id in seen:
                continue
            seen.add(component_id)
            component = components.get(component_id)
            if not isinstance(component, dict):
                continue
            for reference in _component_references(component):
                if reference not in seen:
                    pending.append(reference)
        return seen

    def _validate_final_tree(
        self,
        components: dict[str, dict[str, Any]],
        location: str,
    ) -> None:
        if "root" not in components:
            self.error(location, "final component state must contain id='root'")
        for component_id, component in components.items():
            for reference in _component_references(component):
                if reference not in components:
                    self.error(
                        f"{location}.{component_id}",
                        f"references missing child component {reference!r}",
                    )

    def _extract_template_refs(
        self,
        messages: list[dict[str, Any]],
    ) -> set[str]:
        """Collects the literal `templateId`s an xCardTemplate asks for.

        Bindings and function calls are skipped: which template they end up
        naming is a runtime value, so there is nothing to look up here.
        """
        references: set[str] = set()
        for message in messages:
            payload = message.get("updateComponents") or message.get("createSurface")
            if not isinstance(payload, dict):
                continue
            components = payload.get("components")
            if not isinstance(components, list):
                continue
            for component in components:
                if (
                    isinstance(component, dict)
                    and component.get("component") == TEMPLATE_COMPONENT
                    and isinstance(component.get("templateId"), str)
                    and component["templateId"]
                ):
                    references.add(component["templateId"])
        return references

    def _find_template_package(self, template_id: str) -> Path | None:
        """Locates a `{templateId}/` package directory under --template-root."""
        if self.template_root is None:
            return None
        root = self.template_root
        direct = root / template_id
        if (direct / "template.json").is_file():
            return direct
        normalized_id = normalize_token_name(template_id)
        for candidate in sorted(root.iterdir()) if root.is_dir() else ():
            if (
                candidate.is_dir()
                and normalize_token_name(candidate.name) == normalized_id
                and (candidate / "template.json").is_file()
            ):
                return candidate
        return None

    def validate_template_package(self, directory: Path) -> None:
        """Validates a `meta.json` + `template.json` xCardTemplate package.

        The rules mirror the core's parseTemplateMeta and
        parseTemplateComponents, which reject the message-shaped file the
        earlier revision of this format used.
        """
        meta_path = directory / "meta.json"
        template_path = directory / "template.json"

        if not meta_path.is_file():
            self.error(str(directory), "template package is missing meta.json")
        else:
            try:
                meta = load_json(meta_path)
            except (OSError, ValueError, DuplicateKeyError) as error:
                self.error(str(meta_path), str(error))
            else:
                self._validate_template_meta(meta, str(meta_path))

        if not template_path.is_file():
            self.error(str(directory), "template package is missing template.json")
            return

        try:
            data = load_json(template_path)
        except (OSError, ValueError, DuplicateKeyError) as error:
            self.error(str(template_path), str(error))
            return

        location = str(template_path)
        if not isinstance(data, dict):
            self.error(location, "template.json root must be an object")
            return

        for forbidden, reason in (
            ("version", "the protocol version comes from meta.json"),
            ("surfaceId", "the nested surface id is generated by the core"),
            (
                "updateComponents",
                "a template file is not a message; wrapping it was dropped",
            ),
        ):
            if forbidden in data:
                self.error(
                    f"{location}.{forbidden}",
                    f"template.json must not carry {forbidden!r}: {reason}",
                )

        unknown = sorted(set(data) - {"components"})
        if unknown:
            self.warning(
                location,
                f"template.json only carries components; {unknown} is ignored",
            )

        components = self._validate_component_set(
            data.get("components"),
            f"{location}.components",
            template_mode=True,
        )
        self._validate_final_tree(components, location)

    def _validate_template_meta(self, meta: Any, location: str) -> None:
        if not isinstance(meta, dict):
            self.error(location, "meta.json root must be an object")
            return
        for key in ("catalog", "template_version"):
            value = meta.get(key)
            if not isinstance(value, str) or not value:
                self.error(
                    f"{location}.{key}",
                    f"{key} is required and must be a non-empty string",
                )
        if "a2ui_version" in meta and not isinstance(meta["a2ui_version"], str):
            self.error(
                f"{location}.a2ui_version",
                "must be a string when present; defaults to v1.0",
            )
        catalog = meta.get("catalog")
        known_catalog_ids = {
            self.basic_catalog.get("catalogId"),
            self.xcard_catalog.get("catalogId"),
        }
        if isinstance(catalog, str) and catalog not in known_catalog_ids:
            self.warning(
                f"{location}.catalog",
                f"catalog {catalog!r} is not one of the discovered catalogs",
            )
        unknown = sorted(set(meta) - {"catalog", "template_version", "a2ui_version"})
        if unknown:
            self.warning(location, f"unrecognised meta.json keys: {unknown}")

    def validate_template(
        self,
        path: Path,
        data: dict[str, Any] | None = None,
    ) -> None:
        """Validates a reusable component set (the message-shaped kind).

        Two different things are called a template. This is the Skill's own
        reusable fragment, carried in an `updateComponents` envelope. An
        `xCardTemplate` package is a different format entirely and is
        dispatched to validate_template_package by shape.
        """
        location = str(path)
        if data is None:
            try:
                data = load_json(path)
            except (OSError, ValueError, DuplicateKeyError) as error:
                self.error(location, str(error))
                return
        if not isinstance(data, dict):
            self.error(location, "template root must be an object")
            return
        # Shape decides, not the filename: the reusable fragment carries an
        # `updateComponents` envelope, an xCardTemplate package carries a bare
        # `components` array. Dispatching on the name would misread a
        # legacy-shaped file that happens to be called template.json.
        if "components" in data and "updateComponents" not in data:
            self.validate_template_package(path.parent)
            return
        if data.get("version") != "v1.0":
            self.error(f"{location}.version", "template version must be v1.0")
        update = data.get("updateComponents")
        if not isinstance(update, dict):
            self.error(location, "template must contain updateComponents")
            return
        if update.get("surfaceId") != "template":
            self.error(
                f"{location}.updateComponents.surfaceId",
                "template surfaceId must be 'template'",
            )
        components = self._validate_component_set(
            update.get("components"),
            f"{location}.updateComponents.components",
            template_mode=True,
        )
        self._validate_final_tree(components, location)

    def validate_jsonl(self, path: Path) -> None:
        location = str(path)
        try:
            raw_lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            self.error(location, str(error))
            return

        messages: list[dict[str, Any]] = []
        for line_number, line in enumerate(raw_lines, start=1):
            if not line.strip():
                continue
            try:
                message = load_json_text(line)
            except (ValueError, DuplicateKeyError) as error:
                self.error(f"{location}:{line_number}", str(error))
                continue
            if not isinstance(message, dict):
                self.error(
                    f"{location}:{line_number}",
                    "each JSONL line must be an object",
                )
                continue
            messages.append(message)

        if not messages:
            self.error(location, "JSONL must contain at least one message")
            return
        self._validate_message_list(messages, location, path)

    def _validate_message_list(
        self,
        messages: list[dict[str, Any]],
        location: str,
        path: Path,
    ) -> None:

        token_snapshot = self._token_snapshot()
        try:
            for template_id in sorted(self._extract_template_refs(messages)):
                package = self._find_template_package(template_id)
                if package is None:
                    # Absence here says nothing about the host: the package is
                    # published to an external system and the protocol carries
                    # no version, so neither existence nor revision can be
                    # settled from these files.
                    self.warning(
                        location,
                        f"template {template_id!r} was not validated: its "
                        "package is external. Pass --template-root to check "
                        "the local copy; existence on the host stays unverified.",
                    )
                    continue
                overlay_path = package / "tokens.json"
                if overlay_path.is_file():
                    try:
                        overlay = load_json(overlay_path)
                    except (OSError, ValueError, DuplicateKeyError) as error:
                        self.error(str(overlay_path), str(error))
                    else:
                        self.validate_token_overlay(overlay_path, overlay)
                        self._apply_overlay(overlay)
                self.validate_template_package(package)

            created_surfaces: set[str] = set()
            surface_components: dict[str, dict[str, dict[str, Any]]] = {}

            for index, message in enumerate(messages, start=1):
                message_location = f"{location}:{index}"
                if message.get("version") != "v1.0":
                    self.error(f"{message_location}.version", "must be v1.0")
                payload_keys = [key for key in MESSAGE_KEYS if key in message]
                if len(payload_keys) != 1:
                    self.error(
                        message_location,
                        "must contain exactly one A2UI message payload",
                    )
                    continue
                if set(message) != {"version", payload_keys[0]}:
                    self.error(
                        message_location,
                        f"unsupported top-level keys: {sorted(set(message) - {'version', payload_keys[0]})}",
                    )

                message_key = payload_keys[0]
                schema_name = MESSAGE_SCHEMA_NAMES.get(message_key)
                message_schema = (
                    self.message_schemas.get(schema_name)
                    if schema_name
                    else None
                )
                if isinstance(message_schema, dict):
                    for schema_error in _schema_errors(
                        message,
                        message_schema,
                        message_location,
                    ):
                        self.error(
                            message_location,
                            schema_error.removeprefix(f"{message_location}: "),
                        )
                payload = message[message_key]
                if not isinstance(payload, dict):
                    self.error(
                        f"{message_location}.{message_key}",
                        "must be an object",
                    )
                    continue

                surface_id = payload.get("surfaceId")
                if message_key in {
                    "createSurface",
                    "updateComponents",
                    "updateDataModel",
                    "deleteSurface",
                } and (not isinstance(surface_id, str) or not surface_id):
                    self.error(
                        f"{message_location}.{message_key}.surfaceId",
                        "must be a non-empty string",
                    )
                    continue

                if message_key == "createSurface":
                    if surface_id in created_surfaces:
                        self.error(
                            message_location,
                            f"surface {surface_id!r} is created more than once",
                        )
                    created_surfaces.add(surface_id)
                    surface_components.setdefault(surface_id, {})
                    catalog_id = payload.get("catalogId")
                    known_catalog_ids = {
                        self.basic_catalog.get("catalogId"),
                        self.xcard_catalog.get("catalogId"),
                    }
                    if (
                        isinstance(catalog_id, str)
                        and catalog_id not in known_catalog_ids
                    ):
                        self.warning(
                            f"{message_location}.createSurface.catalogId",
                            f"catalog {catalog_id!r} is not one of the discovered catalogs",
                        )
                    self._validate_global_tracking_params(
                        payload,
                        f"{message_location}.createSurface",
                    )
                    if "components" in payload:
                        inline = self._validate_component_set(
                            payload["components"],
                            f"{message_location}.createSurface.components",
                            template_mode=False,
                        )
                        surface_components[surface_id].update(inline)

                elif message_key == "updateComponents":
                    if surface_id not in created_surfaces:
                        self.error(
                            message_location,
                            f"updateComponents precedes createSurface for {surface_id!r}",
                        )
                    updated = self._validate_component_set(
                        payload.get("components"),
                        f"{message_location}.updateComponents.components",
                        template_mode=False,
                    )
                    surface_components.setdefault(surface_id, {}).update(updated)

                elif message_key == "updateDataModel":
                    if surface_id not in created_surfaces:
                        self.error(
                            message_location,
                            f"updateDataModel precedes createSurface for {surface_id!r}",
                        )
                    if "value" not in payload:
                        self.error(
                            f"{message_location}.updateDataModel",
                            "value is required; use null to delete",
                        )
                    path_value = payload.get("path")
                    if path_value is not None and (
                        not isinstance(path_value, str)
                        or (path_value != "/" and not path_value.startswith("/"))
                    ):
                        self.error(
                            f"{message_location}.updateDataModel.path",
                            "must be '/' or an absolute JSON Pointer",
                        )

                elif message_key == "deleteSurface":
                    if surface_id not in created_surfaces:
                        self.error(
                            message_location,
                            f"deleteSurface references unknown surface {surface_id!r}",
                        )
                    created_surfaces.discard(surface_id)

            for surface_id, components in surface_components.items():
                self._validate_final_tree(
                    components,
                    f"{location} surface {surface_id}",
                )
        finally:
            self._restore_tokens(token_snapshot)

    def validate_target(self, target: Path) -> None:
        target = target.expanduser().resolve()
        if target.is_file():
            if target.name.endswith(".tokens.json"):
                self.validate_token_overlay(target)
            elif target.suffix == ".jsonl":
                self.validate_jsonl(target)
            elif target.suffix == ".json":
                try:
                    data = load_json(target)
                except (OSError, ValueError, DuplicateKeyError) as error:
                    self.error(str(target), str(error))
                    return
                if isinstance(data, dict) and isinstance(data.get("messages"), list):
                    self._validate_message_list(
                        [item for item in data["messages"] if isinstance(item, dict)],
                        str(target),
                        target,
                    )
                    return
                token_snapshot = self._token_snapshot()
                overlay_path = target.with_name(f"{target.stem}.tokens.json")
                if overlay_path.is_file():
                    try:
                        overlay = load_json(overlay_path)
                    except (OSError, ValueError, DuplicateKeyError) as error:
                        self.error(str(overlay_path), str(error))
                    else:
                        self.validate_token_overlay(overlay_path, overlay)
                        self._apply_overlay(overlay)
                try:
                    self.validate_template(target)
                finally:
                    self._restore_tokens(token_snapshot)
            else:
                self.error(str(target), "expected .jsonl or .json")
            return

        if not target.is_dir():
            self.error(str(target), "target does not exist")
            return

        jsonl_files = sorted(target.rglob("*.jsonl"))
        template_files = sorted(
            path
            for path in target.rglob("*.json")
            if not path.name.endswith(".tokens.json")
            and "templates" in path.parts
        )
        token_files = sorted(target.rglob("*.tokens.json"))
        if not jsonl_files and not template_files and not token_files:
            self.error(str(target), "no XCard bundle files found")
            return
        for token_file in token_files:
            self.validate_token_overlay(token_file)
        for template_file in template_files:
            token_snapshot = self._token_snapshot()
            overlay_path = template_file.with_name(
                f"{template_file.stem}.tokens.json"
            )
            if overlay_path.is_file():
                try:
                    overlay = load_json(overlay_path)
                except (OSError, ValueError, DuplicateKeyError) as error:
                    self.error(str(overlay_path), str(error))
                else:
                    self._apply_overlay(overlay)
            try:
                self.validate_template(template_file)
            finally:
                self._restore_tokens(token_snapshot)
        for jsonl_file in jsonl_files:
            self.validate_jsonl(jsonl_file)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    parser.add_argument("--resource-root", help="Local resource directory or static Skill HTTP(S) URL")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument(
        "--allow-component",
        action="append",
        default=[],
        help="Allow a host component not present in the static catalogs.",
    )
    parser.add_argument(
        "--allow-function",
        action="append",
        default=[],
        help=(
            "Allow a host-registered function not present in the static "
            "catalogs, at any call site. Only for functions the target host "
            "actually registers."
        ),
    )
    parser.add_argument(
        "--allow-webcard",
        action="store_true",
        help=(
            "Allow WebCard. Off by default: the slot needs a host URL policy "
            "and a page, so an unconfigured host renders it at height 0."
        ),
    )
    parser.add_argument(
        "--allow-template",
        action="store_true",
        help=(
            "Allow xCardTemplate references. Off by default: the package is "
            "fetched externally, so an unresolved reference renders blank."
        ),
    )
    parser.add_argument(
        "--template-root",
        type=Path,
        help=(
            "Directory of local {templateId}/ packages (meta.json + "
            "template.json) to validate referenced templates against."
        ),
    )
    parser.add_argument(
        "--tracking-profile",
        choices=TRACKING_PROFILES,
        help=(
            "Authorise tracking and pin the host contract. Required whenever "
            "a document carries tracking: 'generic' checks the protocol only, "
            "'yuanbao' also enforces the P1..P6 slots."
        ),
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    validator = BundleValidator(
        args.resource_root,
        args.repo_root,
        set(args.allow_component),
        allow_template=args.allow_template or args.template_root is not None,
        allow_webcard=args.allow_webcard,
        template_root=args.template_root,
        tracking_profile=args.tracking_profile,
        allow_functions=set(args.allow_function),
    )
    validator.validate_target(args.target)
    errors = [issue for issue in validator.issues if issue.severity == "error"]

    if args.json:
        print(
            json.dumps(
                {
                    "ok": not errors,
                    "issues": [issue.as_dict() for issue in validator.issues],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for issue in validator.issues:
            print(
                f"{issue.severity.upper()}: {issue.location}: {issue.message}"
            )
        if errors:
            print(f"FAILED: {len(errors)} error(s)")
        else:
            print(
                f"OK: {args.target} ({len(validator.issues)} warning(s))"
            )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
