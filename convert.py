#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy"]
# ///
"""mp4 -> portable colored-ASCII sequence (seq.json.gz).

One ffmpeg pipe does all decode/scale/fps; numpy does the pixel math.
Output is a single gzipped JSON — see README for the format.

    python convert.py in.mp4 seq.json.gz [--cols 120] [--fps 24] [--ramp " .:-=+*#%@"]
    python convert.py --selftest
"""

import argparse
import base64
import gzip
import json
import subprocess
import sys

import numpy as np

# dark -> light. Space = darkest so blank cells render nothing in the player.
# No leading space: the darkest cells get a real glyph (drawn in their near-black
# RGB) instead of an empty cell, so dark regions read as black text on a light
# background — not the page showing through. On a dark screen they stay ~invisible.
DEFAULT_RAMP = ".:-=+*#%@"


def probe_aspect(path: str) -> float:
    """width / height of the first video stream."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = (int(n) for n in out.split("x"))
    return w / h


def luma_to_chars(rgb: np.ndarray, ramp: str) -> str:
    """(rows, cols, 3) uint8 -> flattened char string, row-major."""
    luma = rgb @ np.array([0.299, 0.587, 0.114])  # (rows, cols)
    idx = (luma / 255 * (len(ramp) - 1)).round().astype(int)
    table = np.array(list(ramp))
    return "".join(table[idx].ravel())


def convert(inp: str, out: str, cols: int, fps: int, ramp: str) -> int:
    aspect = probe_aspect(inp)
    # /2: monospace cells are ~2x taller than wide.
    rows = max(1, round(cols / aspect / 2))
    frame_bytes = cols * rows * 3

    proc = subprocess.Popen(
        [
            "ffmpeg", "-v", "error",
            "-i", inp,
            "-vf", f"scale={cols}:{rows},fps={fps}",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
    )

    frames = []
    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break  # EOF (ffmpeg only emits whole frames)
        rgb = np.frombuffer(buf, dtype=np.uint8).reshape(rows, cols, 3)
        frames.append({
            "c": luma_to_chars(rgb, ramp),
            "rgb": base64.b64encode(rgb.tobytes()).decode("ascii"),
        })
    proc.wait()
    if proc.returncode not in (0, None):
        raise RuntimeError(f"ffmpeg exited {proc.returncode}")

    seq = {"cols": cols, "rows": rows, "fps": fps, "ramp": ramp, "frames": frames}
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump(seq, f, separators=(",", ":"))
    return len(frames)


def selftest() -> None:
    ramp = DEFAULT_RAMP
    # mid-gray -> middle of ramp; rgb round-trips through base64.
    rgb = np.full((2, 3, 3), 128, dtype=np.uint8)
    chars = luma_to_chars(rgb, ramp)
    mid = ramp[round(128 / 255 * (len(ramp) - 1))]
    assert set(chars) == {mid}, f"expected all {mid!r}, got {chars!r}"
    b64 = base64.b64encode(rgb.tobytes()).decode("ascii")
    assert np.frombuffer(base64.b64decode(b64), np.uint8).tolist() == rgb.ravel().tolist()
    # black -> space (first ramp char), white -> last.
    assert luma_to_chars(np.zeros((1, 1, 3), np.uint8), ramp) == ramp[0]
    assert luma_to_chars(np.full((1, 1, 3), 255, np.uint8), ramp) == ramp[-1]
    print("selftest ok")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", nargs="?", help="source mp4")
    ap.add_argument("output", nargs="?", help="seq.json.gz")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--ramp", default=DEFAULT_RAMP)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if not args.input or not args.output:
        ap.error("input and output required (or use --selftest)")

    n = convert(args.input, args.output, args.cols, args.fps, args.ramp)
    print(f"wrote {args.output}: {n} frames @ {args.fps}fps, {args.cols} cols")


if __name__ == "__main__":
    sys.exit(main())
