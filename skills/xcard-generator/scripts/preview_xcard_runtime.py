#!/usr/bin/env python3
"""Preview a self-contained XCard artifact in Yuanbao and compare it to a design."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from PIL import Image

from compare_xcard_screenshots import parse_crop
from xcard_resources import load_json, load_json_text


DEFAULT_BUNDLE_ID = "com.tencent.hunyuan.app.chat.debug"
TARGET_PAGE_TITLE = "XCard调试"
PASTE_BUTTON_LABEL = "粘贴 JSON 并预览"


class PreviewError(RuntimeError):
    pass


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class Artifact:
    path: Path
    text: str
    documents: tuple[dict[str, Any], ...]

    @property
    def message_count(self) -> int:
        return len(self.documents)


def run_command(
    command: Sequence[str],
    *,
    input_text: str | None = None,
    timeout: int = 30,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        env=env,
        check=False,
    )


def load_artifact(path: Path) -> Artifact:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise PreviewError(f"artifact does not exist: {resolved}")

    if resolved.suffix == ".jsonl":
        lines = [line.strip() for line in resolved.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not lines:
            raise PreviewError("JSONL artifact is empty")
        documents = tuple(load_json_text(line) for line in lines)
        text = "\n".join(lines) + "\n"
    elif resolved.suffix == ".json":
        value = load_json(resolved)
        values = value if isinstance(value, list) else [value]
        documents = tuple(values)
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        raise PreviewError("artifact must be .json or .jsonl")

    if not all(isinstance(document, dict) for document in documents):
        raise PreviewError("every preview message must be a JSON object")
    return Artifact(resolved, text, documents)


def artifact_problems(
    artifact: Artifact,
    *,
    allow_runtime_template: bool = False,
) -> list[str]:
    creates: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    problems: list[str] = []

    for document in artifact.documents:
        create = document.get("createSurface")
        if isinstance(create, dict):
            creates.append(create)
        update = document.get("updateComponents")
        if isinstance(update, dict):
            updates.append(update)

    if not creates:
        problems.append("preview artifact has no createSurface message")
    if not updates:
        problems.append("preview artifact has no updateComponents message")
    if any(update.get("surfaceId") == "template" for update in updates):
        problems.append("template-only updateComponents cannot be previewed as a standalone Surface")

    surface_ids = {
        payload.get("surfaceId")
        for payload in (*creates, *updates)
        if isinstance(payload.get("surfaceId"), str)
    }
    if len(surface_ids) > 1:
        problems.append("createSurface/updateComponents surfaceId values do not match")

    components: list[dict[str, Any]] = []
    for update in updates:
        value = update.get("components")
        if isinstance(value, list):
            components.extend(component for component in value if isinstance(component, dict))
    if not any(component.get("id") == "root" for component in components):
        problems.append("final updateComponents has no root component")
    if not allow_runtime_template and any(
        component.get("component") == "xCardTemplate" for component in components
    ):
        problems.append(
            "an xCardTemplate reference is not self-contained: the host fetches "
            "the package externally and renders nothing when it is missing. "
            "Preview the inline equivalent, or pass --allow-runtime-template "
            "once the package is known to be on the device"
        )
    return problems


def find_automation_skill(
    explicit: Path | None,
    app_repo: Path | None,
) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("XCARD_SIM_AUTOMATION_SKILL"):
        candidates.append(Path(os.environ["XCARD_SIM_AUTOMATION_SKILL"]))
    if app_repo:
        candidates.append(app_repo / ".codebuddy" / "skills" / "sim-automation-test")
        candidates.append(app_repo / "App" / "iOS" / ".codebuddy" / "skills" / "sim-automation-test")

    for candidate in candidates:
        root = candidate.expanduser().resolve()
        if (
            (root / "scripts" / "go.py").is_file()
            and (root / "scripts" / "yb_automation_test_kit.py").is_file()
            and (root / "bin" / "sim-use").is_file()
        ):
            return root
    return None


def booted_devices() -> list[dict[str, str]]:
    process = run_command(["xcrun", "simctl", "list", "devices", "booted", "-j"])
    if process.returncode != 0:
        raise PreviewError(process.stderr.strip() or "unable to list booted simulators")
    payload = json.loads(process.stdout)
    devices: list[dict[str, str]] = []
    for runtime, values in (payload.get("devices") or {}).items():
        for value in values or []:
            if value.get("state") == "Booted" and value.get("isAvailable", True):
                devices.append(
                    {
                        "udid": str(value.get("udid") or ""),
                        "name": str(value.get("name") or ""),
                        "runtime": runtime,
                    }
                )
    return devices


def app_is_installed(udid: str, bundle_id: str) -> bool:
    process = run_command(
        ["xcrun", "simctl", "get_app_container", udid, bundle_id, "app"],
        timeout=15,
    )
    return process.returncode == 0 and bool(process.stdout.strip())


def select_device(
    devices: Sequence[dict[str, str]],
    installed_udids: set[str],
    explicit_udid: str | None,
) -> dict[str, str] | None:
    if explicit_udid:
        return next(
            (
                device
                for device in devices
                if device["udid"] == explicit_udid and explicit_udid in installed_udids
            ),
            None,
        )
    eligible = [
        device
        for device in devices
        if device["udid"] in installed_udids and "iPhone" in device["name"]
    ]
    return eligible[0] if len(eligible) == 1 else None


def check_toolchain(args: argparse.Namespace, artifact: Artifact) -> dict[str, Any]:
    checks: list[Check] = []
    problems = artifact_problems(
        artifact,
        allow_runtime_template=args.allow_runtime_template,
    )
    checks.append(
        Check(
            "artifact",
            not problems,
            "; ".join(problems) if problems else f"{artifact.message_count} preview message(s)",
        )
    )

    design = args.design.expanduser().resolve() if args.design else None
    checks.append(
        Check(
            "design",
            design is None or design.is_file(),
            str(design) if design and design.is_file() else ("not requested" if design is None else "missing"),
        )
    )

    xcrun = shutil.which("xcrun")
    checks.append(Check("xcrun", bool(xcrun), xcrun or "not found"))

    app_repo = args.app_repo.expanduser().resolve() if args.app_repo else None
    automation_skill = find_automation_skill(args.automation_skill, app_repo)
    checks.append(
        Check(
            "sim-automation-test",
            automation_skill is not None,
            str(automation_skill) if automation_skill else "pass --automation-skill or --app-repo",
        )
    )

    doctor_output = ""
    if automation_skill:
        doctor = run_command(
            [sys.executable, str(automation_skill / "scripts" / "doctor.py")],
            timeout=30,
        )
        doctor_output = (doctor.stdout + doctor.stderr).strip()
        checks.append(
            Check(
                "automation-contract",
                doctor.returncode == 0,
                doctor_output.splitlines()[-1] if doctor_output else f"exit={doctor.returncode}",
            )
        )
    else:
        checks.append(Check("automation-contract", False, "automation skill unavailable"))

    selected: dict[str, str] | None = None
    device_error = ""
    if xcrun:
        try:
            devices = booted_devices()
            installed = {
                device["udid"]
                for device in devices
                if app_is_installed(device["udid"], args.bundle_id)
            }
            selected = select_device(devices, installed, args.udid)
            if selected is None:
                device_error = (
                    "no eligible simulator"
                    if not installed
                    else "multiple eligible simulators; pass --udid"
                )
        except (PreviewError, json.JSONDecodeError) as error:
            device_error = str(error)
    else:
        device_error = "xcrun unavailable"
    checks.append(
        Check(
            "simulator",
            selected is not None,
            (
                f"{selected['name']} {selected['udid']}"
                if selected
                else device_error
            ),
        )
    )

    bridge_output = ""
    if automation_skill and selected:
        yb_cli = automation_skill / "bin" / "yb-cli-ios"
        bridge_outputs: list[str] = []
        bridge: subprocess.CompletedProcess[str] | None = None
        for attempt in range(2):
            bridge = run_command(
                [str(yb_cli), "call", "yb.app.info"],
                timeout=15,
            )
            bridge_outputs.append((bridge.stdout + bridge.stderr).strip())
            if bridge.returncode == 0 and bridge.stdout.strip():
                break
            if attempt == 0:
                run_command([str(yb_cli), "connect", "--reset"], timeout=15)
        assert bridge is not None
        bridge_output = "\n".join(output for output in bridge_outputs if output)
        bridge_ok = bridge.returncode == 0 and bool(bridge.stdout.strip())
    else:
        bridge_ok = False
        bridge_output = "automation skill or selected simulator unavailable"
    checks.append(
        Check(
            "runtime-bridge",
            bridge_ok,
            (
                "yb.app.info available"
                if bridge_ok
                else bridge_output.splitlines()[0][:240]
            ),
        )
    )

    preview_ready = all(
        check.ok
        for check in checks
        if check.name in {
            "artifact",
            "xcrun",
            "sim-automation-test",
            "automation-contract",
            "simulator",
            "runtime-bridge",
        }
    )
    comparison_ready = preview_ready and (design is not None and design.is_file())
    return {
        "readyForPreview": preview_ready,
        "readyForComparison": comparison_ready,
        "artifact": str(artifact.path),
        "messageCount": artifact.message_count,
        "design": str(design) if design else None,
        "automationSkill": str(automation_skill) if automation_skill else None,
        "selectedDevice": selected,
        "checks": [asdict(check) for check in checks],
        "doctorOutput": doctor_output,
        "runtimeBridgeOutput": bridge_output,
    }


def parse_workspace(output: str) -> Path:
    match = re.search(r"^WORKSPACE=(.+)$", output, re.MULTILINE)
    if not match:
        raise PreviewError("sim automation go.py did not return WORKSPACE")
    workspace = Path(match.group(1)).expanduser().resolve()
    if not workspace.is_dir():
        raise PreviewError(f"sim automation workspace missing: {workspace}")
    return workspace


def create_kit_session(
    automation_skill: Path,
    udid: str,
    output_dir: Path,
) -> tuple[Any, Path, str]:
    env = os.environ.copy()
    env["SIM_AUTOMATION_ROOT"] = str(output_dir / "sim-automation")
    title = "xcard-preview-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    outputs: list[str] = []
    process: subprocess.CompletedProcess[str] | None = None
    for attempt in range(2):
        command = [
            sys.executable,
            str(automation_skill / "scripts" / "go.py"),
            "--title",
            f"{title}-attempt-{attempt + 1}",
            "--udid",
            udid,
        ]
        process = run_command(command, timeout=90, env=env)
        output = process.stdout + process.stderr
        outputs.append(output)
        if process.returncode == 0:
            break
        if attempt == 0:
            run_command(
                [str(automation_skill / "bin" / "yb-cli-ios"), "connect", "--reset"],
                timeout=15,
            )
    assert process is not None
    output = "\n\n".join(outputs)
    if process.returncode != 0:
        raise PreviewError("sim automation session failed after one daemon reset:\n" + output)
    workspace = parse_workspace(output)

    scripts_dir = automation_skill / "scripts"
    sys.path.insert(0, str(scripts_dir))
    module = importlib.import_module("yb_automation_test_kit")
    kit = module.YBAutomationTestKit(workspace=str(workspace), udid=udid)
    return kit, workspace, output


def navigate_to_gallery(kit: Any, *, max_steps: int = 10) -> tuple[Any, list[str]]:
    evidence: list[str] = []
    snap = kit.snapshot()
    evidence.append(str(snap))

    for _ in range(max_steps):
        tree = snap.tree
        if TARGET_PAGE_TITLE in tree and PASTE_BUTTON_LABEL in tree:
            return snap, evidence

        if re.search(r'ic env (?:other|test|pre)', tree):
            result = kit.tap(r"ic env (?:other|test|pre)")
        elif "研发助手" in tree:
            try:
                result = kit.tap("老DEBUG页", scroll=True, timeout=15)
            except RuntimeError as error:
                if "SCROLL_NO_CONTAINER" not in str(error):
                    raise
                result = kit.swipe(200, 780, 200, 300)
        elif "DEBUG 面板" in tree and "XCard调试" in tree:
            result = kit.tap("XCard调试")
        elif "ic back black" in tree:
            result = kit.tap("ic back black")
        elif re.search(r'"Login"|Log In with Mobile Number', tree):
            result = kit.tap(r'"Login"|Log In with Mobile Number')
        else:
            raise PreviewError(
                "unable to navigate to XCard Gallery; latest tree: "
                + (snap.out or "(no artifact directory)")
            )
        evidence.append(str(result))
        snap = result if result.out else kit.snapshot()

    raise PreviewError("XCard Gallery navigation exceeded the step limit")


def set_simulator_pasteboard(udid: str, text: str) -> None:
    write = run_command(
        ["xcrun", "simctl", "pbcopy", udid],
        input_text=text,
        timeout=30,
    )
    if write.returncode != 0:
        raise PreviewError(write.stderr.strip() or "simulator pbcopy failed")
    read = run_command(["xcrun", "simctl", "pbpaste", udid], timeout=30)
    if read.returncode != 0:
        raise PreviewError(read.stderr.strip() or "simulator pbpaste failed")
    if read.stdout.replace("\r\n", "\n") != text.replace("\r\n", "\n"):
        raise PreviewError("simulator pasteboard readback differs from the artifact")


def preview_artifact(kit: Any, artifact: Artifact) -> tuple[Any, list[str]]:
    evidence: list[str] = []
    set_simulator_pasteboard(kit.udid, artifact.text)
    result = kit.tap(PASTE_BUTTON_LABEL)
    evidence.append(str(result))

    expected = rf"Step\s+{artifact.message_count}/{artifact.message_count}"
    wait_match = kit.wait(expected, timeout=max(15, artifact.message_count * 3))
    evidence.append(
        "WAIT_MATCH=" + wait_match
        if wait_match
        else "WAIT_TIMEOUT=" + expected
    )

    final = kit.snapshot()
    evidence.append(str(final))
    if not wait_match:
        raise PreviewError("preview did not reach the final JSONL step")
    if re.search(r"\berror:\s|无法预览|COMPONENT_NOT_SUPPORTED|CATALOG_NOT_", final.tree):
        raise PreviewError("preview completed with a renderer error")
    return final, evidence


def find_xcard_surface_frame(snapshot_path: Path) -> dict[str, float] | None:
    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    candidates = [
        node
        for node in payload.get("nodes") or []
        if node.get("className") == "XCardSurfaceView"
        and isinstance(node.get("globalFrame"), dict)
    ]
    if not candidates:
        return None
    node = max(
        candidates,
        key=lambda item: float(item["globalFrame"].get("width", 0))
        * float(item["globalFrame"].get("height", 0)),
    )
    return {
        key: float(node["globalFrame"][key])
        for key in ("x", "y", "width", "height")
    }


def read_screen_size(out_dir: Path) -> tuple[float, float] | None:
    path = out_dir / "lookin-semantic.json"
    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    screen = payload.get("screen")
    if not isinstance(screen, dict):
        return None
    width = screen.get("width")
    height = screen.get("height")
    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        return None
    return float(width), float(height)


def frame_to_crop(
    frame: dict[str, float],
    screen_size: tuple[float, float],
    image_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    screen_width, screen_height = screen_size
    image_width, image_height = image_size
    scale_x = image_width / screen_width
    scale_y = image_height / screen_height
    x = max(0, round(frame["x"] * scale_x))
    y = max(0, round(frame["y"] * scale_y))
    width = max(1, round(frame["width"] * scale_x))
    height = max(1, round(frame["height"] * scale_y))
    width = min(width, image_width - x)
    height = min(height, image_height - y)
    return x, y, width, height


def automatic_actual_crop(final: Any) -> tuple[int, int, int, int]:
    snapshot_path = Path(final.out) / "snapshot.json"
    frame = find_xcard_surface_frame(snapshot_path)
    screen_size = read_screen_size(Path(final.out))
    if frame is None or screen_size is None:
        raise PreviewError(
            "Lookin did not provide an XCardSurfaceView frame; pass --actual-crop or retry with VERDICT=ok"
        )
    with Image.open(final.screenshot) as image:
        image_size = image.size
    return frame_to_crop(frame, screen_size, image_size)


def crop_argument(value: tuple[int, int, int, int]) -> str:
    return ",".join(str(item) for item in value)


def compare_design(
    *,
    script_dir: Path,
    design: Path,
    actual: Path,
    output_dir: Path,
    target_crop: tuple[int, int, int, int] | None,
    actual_crop: tuple[int, int, int, int],
) -> dict[str, Any]:
    comparison = output_dir / "comparison.png"
    diff = output_dir / "pixel-diff.png"
    report = output_dir / "comparison.json"
    command = [
        sys.executable,
        str(script_dir / "compare_xcard_screenshots.py"),
        "--target",
        str(design),
        "--actual",
        str(actual),
        "--actual-crop",
        crop_argument(actual_crop),
        "--output",
        str(comparison),
        "--diff-output",
        str(diff),
        "--report",
        str(report),
    ]
    if target_crop:
        command += ["--target-crop", crop_argument(target_crop)]
    process = run_command(command, timeout=60)
    if process.returncode != 0:
        raise PreviewError(process.stderr.strip() or "screenshot comparison failed")
    return json.loads(report.read_text(encoding="utf-8"))


def write_summary(
    output_dir: Path,
    report: dict[str, Any],
    navigation_log: Path,
) -> None:
    comparison = report.get("comparison") or {}
    lines = [
        "# XCard Runtime Preview",
        "",
        f"- Artifact: `{report['artifact']}`",
        f"- Simulator: `{report['device']['name']}` (`{report['device']['udid']}`)",
        f"- Preview screenshot: `{report['previewScreenshot']}`",
        f"- Navigation log: `{navigation_log}`",
    ]
    if comparison:
        lines.extend(
            [
                f"- Comparison: `{comparison.get('comparison')}`",
                f"- Pixel diff: `{comparison.get('diff')}`",
                f"- Mean absolute channel error: `{comparison.get('meanAbsoluteChannelError')}`",
                f"- Aspect ratio delta: `{comparison.get('aspectRatioDelta')}`",
            ]
        )
    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def execute(args: argparse.Namespace, artifact: Artifact, toolchain: dict[str, Any]) -> dict[str, Any]:
    if not toolchain["readyForPreview"]:
        raise PreviewError("preview toolchain is not ready")

    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir
        else Path(tempfile.mkdtemp(prefix="xcard-preview-"))
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    automation_skill = Path(toolchain["automationSkill"])
    device = toolchain["selectedDevice"]
    kit, workspace, session_output = create_kit_session(
        automation_skill,
        device["udid"],
        output_dir,
    )

    _, navigation_evidence = navigate_to_gallery(kit, max_steps=args.max_navigation_steps)
    final, preview_evidence = preview_artifact(kit, artifact)
    if not final.screenshot:
        raise PreviewError("runtime preview did not produce a screenshot")

    navigation_log = output_dir / "automation.log"
    navigation_log.write_text(
        session_output
        + "\n\n"
        + "\n\n".join(navigation_evidence + preview_evidence),
        encoding="utf-8",
    )

    requested_actual_crop = args.actual_crop
    actual_crop = requested_actual_crop or automatic_actual_crop(final)
    comparison: dict[str, Any] | None = None
    if args.design:
        comparison = compare_design(
            script_dir=Path(__file__).resolve().parent,
            design=args.design.expanduser().resolve(),
            actual=Path(final.screenshot),
            output_dir=output_dir,
            target_crop=args.target_crop,
            actual_crop=actual_crop,
        )

    report = {
        "ok": True,
        "artifact": str(artifact.path),
        "messageCount": artifact.message_count,
        "device": device,
        "automationWorkspace": str(workspace),
        "previewScreenshot": str(Path(final.screenshot).resolve()),
        "actualCrop": list(actual_crop),
        "comparison": comparison,
        "toolchain": toolchain,
        "outputDirectory": str(output_dir),
    }
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_summary(output_dir, report, navigation_log)
    return report


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--design", type=Path)
    parser.add_argument("--app-repo", type=Path)
    parser.add_argument("--automation-skill", type=Path)
    parser.add_argument("--udid")
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--allow-runtime-template", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check")
    add_common_arguments(check)

    run = subparsers.add_parser("run")
    add_common_arguments(run)
    run.add_argument("--output-dir", type=Path)
    run.add_argument("--target-crop", type=parse_crop)
    run.add_argument("--actual-crop", type=parse_crop)
    run.add_argument("--max-navigation-steps", type=int, default=10)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        artifact = load_artifact(args.artifact)
        toolchain = check_toolchain(args, artifact)
        if args.command == "check":
            print(json.dumps(toolchain, ensure_ascii=False, indent=2))
            return 0 if toolchain["readyForPreview"] else 3
        report = execute(args, artifact, toolchain)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (PreviewError, OSError, ValueError, json.JSONDecodeError) as error:
        print(
            json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
