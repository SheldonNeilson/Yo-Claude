"""Prepare the avatar's source clips (ui/avatar/*.mp4 + clips.json). The window turns them into ASCII live, frame by
frame (ui/avatar.js), so the resolution, contrast and retro effects can change without remaking anything.

The clips are short videos of one person, all starting from the same frame: a free-licence photo (Pexels 3781556)
cleaned up with Qwen-Image-Edit and animated with Wan 2.2 I2V on the local GPU (see D:/Temp/yoclaude-faces/gen.py).
Here they're cropped to face, hair and shoulders, shrunk and re-encoded small.

    python scripts/make_avatar_clips.py D:/Temp/yoclaude-faces/clips            (all of them: the manifest is replaced)
    python scripts/make_avatar_clips.py D:/Temp/yoclaude-faces/clips idle_yawn  (just these: added to the manifest)

The window rereads clips.json every minute or so and picks up new or changed clips without a restart. Each entry
is {"frames": n, "stamp": size-mtime}, so a re-made clip is noticed too.
"""
import json
import subprocess
import sys
from pathlib import Path

# idle, talking, listening, thinking, laughing, looking, hair, and extra mannerisms named idle_* and think_*
SKIP = {"base"}
CROP = (0.14, 0.03, 0.86, 0.66)   # out of the 480x832 clip: left, top, right, bottom (fractions)
WIDTH = 320                       # pixels across: plenty for ~160 characters
FPS = 12
OUT = Path(__file__).resolve().parent.parent / "ui" / "avatar"


def main(folder: Path, only=()):
    OUT.mkdir(exist_ok=True)
    manifest = OUT / "clips.json"
    made = {}
    if only and manifest.exists():
        made = json.loads(manifest.read_text(encoding="utf-8")).get("clips", {})
    for src in sorted(folder.glob("*.mp4")):
        name = src.stem
        if name in SKIP or (only and name not in only):
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
        st = out.stat()
        made[name] = {"frames": frames, "stamp": f"{st.st_size}-{int(st.st_mtime)}"}
        print(f"{out.name}: {frames} frames, {st.st_size // 1024} KB")
    tmp = manifest.with_suffix(".tmp")   # written whole, then swapped in: the window never reads half of it
    tmp.write_text(json.dumps({"fps": FPS, "clips": made}, indent=1), encoding="utf-8")
    tmp.replace(manifest)
    old = OUT / "frames.js"
    if old.exists():
        old.unlink()   # the baked-text version this replaces


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\Temp\yoclaude-faces\clips"), set(sys.argv[2:]))
