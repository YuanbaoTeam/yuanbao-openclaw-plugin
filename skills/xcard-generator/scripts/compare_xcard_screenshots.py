#!/usr/bin/env python3
"""Create a normalized target/actual XCard screenshot comparison."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat


def parse_crop(value: str) -> tuple[int, int, int, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("crop must be x,y,width,height")
    try:
        x, y, width, height = (int(part) for part in parts)
    except ValueError as error:
        raise argparse.ArgumentTypeError("crop values must be integers") from error
    if min(x, y) < 0 or width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("crop must use non-negative x/y and positive size")
    return x, y, width, height


def crop_image(
    path: Path,
    crop: tuple[int, int, int, int] | None,
) -> tuple[Image.Image, dict[str, object]]:
    image = Image.open(path).convert("RGB")
    source_size = image.size
    if crop is None:
        box = (0, 0, source_size[0], source_size[1])
    else:
        x, y, width, height = crop
        box = (x, y, x + width, y + height)
        if box[2] > source_size[0] or box[3] > source_size[1]:
            raise ValueError(f"crop {crop} exceeds image size {source_size}")
    result = image.crop(box)
    return result, {
        "path": str(path.resolve()),
        "sourceSize": list(source_size),
        "crop": [box[0], box[1], box[2] - box[0], box[3] - box[1]],
        "cropAspectRatio": result.width / result.height,
    }


def resize_width(image: Image.Image, width: int) -> Image.Image:
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), Image.Resampling.LANCZOS)


def add_label(image: Image.Image, label: str, label_height: int) -> Image.Image:
    canvas = Image.new("RGB", (image.width, image.height + label_height), "white")
    canvas.paste(image, (0, label_height))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=max(14, label_height // 2))
    bounds = draw.textbbox((0, 0), label, font=font)
    text_width = bounds[2] - bounds[0]
    draw.text(
        ((image.width - text_width) / 2, max(2, (label_height - (bounds[3] - bounds[1])) / 2)),
        label,
        fill="black",
        font=font,
    )
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--actual", type=Path, required=True)
    parser.add_argument("--target-crop", type=parse_crop)
    parser.add_argument("--actual-crop", type=parse_crop)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--diff-output", type=Path)
    parser.add_argument("--width", type=int, default=600)
    parser.add_argument("--label-height", type=int, default=44)
    args = parser.parse_args()

    if args.width <= 0 or args.label_height < 0:
        parser.error("width must be positive and label-height must be non-negative")

    target, target_report = crop_image(args.target, args.target_crop)
    actual, actual_report = crop_image(args.actual, args.actual_crop)
    target_resized = resize_width(target, args.width)
    actual_resized = resize_width(actual, args.width)

    common_height = max(target_resized.height, actual_resized.height)
    panels: list[Image.Image] = []
    for image, label in ((target_resized, "Target"), (actual_resized, "Actual")):
        panel = Image.new("RGB", (args.width, common_height), "white")
        panel.paste(image, (0, 0))
        panels.append(add_label(panel, label, args.label_height))

    comparison = Image.new(
        "RGB",
        (args.width * 2, common_height + args.label_height),
        "white",
    )
    comparison.paste(panels[0], (0, 0))
    comparison.paste(panels[1], (args.width, 0))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    comparison.save(args.output)

    target_ratio = target_report["cropAspectRatio"]
    actual_ratio = actual_report["cropAspectRatio"]
    ratio_delta = abs(float(target_ratio) - float(actual_ratio))
    report = {
        "target": target_report,
        "actual": actual_report,
        "normalizedWidth": args.width,
        "targetNormalizedHeight": target_resized.height,
        "actualNormalizedHeight": actual_resized.height,
        "aspectRatioDelta": ratio_delta,
        "warnings": (
            ["crop aspect ratios differ by more than 0.08"]
            if ratio_delta > 0.08
            else []
        ),
        "comparison": str(args.output.resolve()),
    }

    if args.diff_output:
        diff_target = target.resize((args.width, common_height), Image.Resampling.LANCZOS)
        diff_actual = actual.resize((args.width, common_height), Image.Resampling.LANCZOS)
        diff = ImageChops.difference(diff_target, diff_actual)
        args.diff_output.parent.mkdir(parents=True, exist_ok=True)
        diff.save(args.diff_output)
        stat = ImageStat.Stat(diff)
        report["meanAbsoluteChannelError"] = sum(stat.mean) / len(stat.mean)
        report["diff"] = str(args.diff_output.resolve())

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
