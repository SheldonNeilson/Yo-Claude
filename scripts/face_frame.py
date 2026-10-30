"""Frame a character's start photo like Female 1's, so every face fills the window the same way: the face (from
mediapipe's face landmarks) scaled to her face's size and placed where hers is, in a 480x832 portrait, padding with
the photo's own backdrop colour where it runs out. Runs in the face landmarker's environment (see face_measure.py).

    face_frame.py <reference.png> <photo.png> <out.png>
"""
import os
import sys

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision
from PIL import Image

MODEL = os.environ.get("YOCLAUDE_FACE_MODEL", r"D:/Temp/yoclaude-scratch/facemesh/model/face_landmarker.task")
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=MODEL),
                                                                              num_faces=1))
W, H = 480, 832


def face(im):
    """(centre x, eye line y, face height: forehead to chin), in pixels."""
    a = np.ascontiguousarray(np.asarray(im.convert("RGB")))
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=a))
    if not r.face_landmarks:
        raise SystemExit("no face found")
    pts = np.array([(p.x * im.width, p.y * im.height) for p in r.face_landmarks[0]])
    eyes = pts[[33, 133, 362, 263]]   # the corners of both eyes
    return eyes[:, 0].mean(), eyes[:, 1].mean(), pts[152, 1] - pts[10, 1]   # chin (152) minus forehead (10)


ref_x, ref_y, ref_h = face(Image.open(sys.argv[1]).resize((W, H)))
photo = Image.open(sys.argv[2]).convert("RGB")
x, y, h = face(photo)
s = ref_h / h
big = photo.resize((round(photo.width * s), round(photo.height * s)), Image.LANCZOS)
bg = tuple(int(v) for v in np.median(np.asarray(big)[:20, :20].reshape(-1, 3), axis=0))
out = Image.new("RGB", (W, H), bg)
out.paste(big, (round(ref_x - x * s), round(ref_y - y * s)))
out.save(sys.argv[3])
print(f"face {h:.0f}px -> {ref_h:.0f}px (x{s:.2f}); eyes at {ref_x:.0f},{ref_y:.0f}")
