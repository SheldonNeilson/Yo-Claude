"""Per frame of each avatar clip: how shut her eyes are (eyeBlink) and how open her jaw is (jawOpen), from mediapipe's
face landmarker blendshapes. Run by make_avatar_clips.py in its own environment (mediapipe + the face_landmarker.task
model; see FACEMESH there). Usage: face_measure.py <clip.mp4> [...] -> JSON {name: {"blink": [...], "jaw": [...], "smile": [...]}}"""
import os
import json
import subprocess
import sys
from pathlib import Path

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

MODEL = os.environ.get("YOCLAUDE_FACE_MODEL", r"D:/Temp/yoclaude-scratch/facemesh/model/face_landmarker.task")
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=MODEL), output_face_blendshapes=True, num_faces=1))


def frames(path):
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


out = {}
for path in sys.argv[1:]:
    blink, jaw, smile = [], [], []
    for f in frames(path):
        r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f)))
        if not r.face_blendshapes:
            blink.append(None); jaw.append(None); smile.append(None); continue
        b = {c.category_name: c.score for c in r.face_blendshapes[0]}
        blink.append(round((b["eyeBlinkLeft"] + b["eyeBlinkRight"]) / 2, 3)); jaw.append(round(b["jawOpen"], 3))
        smile.append(round((b["mouthSmileLeft"] + b["mouthSmileRight"]) / 2, 3))
    out[Path(path).stem] = {"blink": blink, "jaw": jaw, "smile": smile}
print(json.dumps(out))
