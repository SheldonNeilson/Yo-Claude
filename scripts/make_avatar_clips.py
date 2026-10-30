"""Prepare the avatar's source clips (ui/avatar/*.mp4 + clips.json). The window turns them into ASCII live, frame by
frame (ui/avatar.js), so the resolution, contrast and retro effects can change without remaking anything.

The clips are short videos of one person, all starting from the same frame: a free-licence photo (Pexels 3781556)
cleaned up with Qwen-Image-Edit and animated with Wan 2.2 I2V on the local GPU (see D:/Temp/yoclaude-faces/gen.py).
Here they're cropped to face, hair and shoulders, shrunk and re-encoded small.

    python scripts/make_avatar_clips.py D:/Temp/yoclaude-faces/clips
"""
import json
import subprocess
import sys
from pathlib import Path

CLIPS = ["idle", "talking", "listening", "thinking", "laughing", "looking", "hair"]
CROP = (0.14, 0.03, 0.86, 0.66)   # out of the 480x832 clip: left, top, right, bottom (fractions)
WIDTH = 320                       # pixels across: plenty for ~160 characters
FPS = 12
OUT = Path(__file__).resolve().parent.parent / "ui" / "avatar"


def main(folder: Path):
    OUT.mkdir(exist_ok=True)
    made = {}
    for name in CLIPS:
        src = folder / f"{name}.mp4"
        if not src.exists():
            continue
        l, t, r, b = CROP
        vf = (f"crop=iw*{r - l:.4f}:ih*{b - t:.4f}:iw*{l:.4f}:ih*{t:.4f},scale={WIDTH}:-2:flags=lanczos,fps={FPS},"
              "format=yuv420p")
        out = OUT / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", vf, "-an", "-c:v", "libx264",
                        "-crf", "24", "-preset", "slow", "-movflags", "+faststart", str(out)], check=True)
        frames = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                                     "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(out)],
                                    capture_output=True, text=True, check=True).stdout.strip())
        made[name] = frames
        print(f"{out.name}: {frames} frames, {out.stat().st_size // 1024} KB")
    (OUT / "clips.json").write_text(json.dumps({"fps": FPS, "clips": made}, indent=1), encoding="utf-8")
    old = OUT / "frames.js"
    if old.exists():
        old.unlink()   # the baked-text version this replaces


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\Temp\yoclaude-faces\clips"))
