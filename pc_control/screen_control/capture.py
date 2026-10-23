"""Screenshots, pixel probes, change detection and the shared verify/shot plumbing of the input tools."""
import hashlib
import io

import pyautogui
from mcp.server.fastmcp import Image
from PIL import Image as PILImage
from PIL import ImageChops, ImageDraw

from . import coords, safety
from .app import LOG_PATH, _logged, mcp
from .coords import _MSS, _from_screen, _mon, _monitors, _scale, _to_screen
from .safety import _guard_read, _kill_switch, _pause
from .winapi import _covering, _find_window


def _box(window: str | None, region: list[int] | None):
    """Resolve a capture box in real virtual-desktop pixels. Returns (box, label)."""
    if window and region:
        raise ValueError("pass either window or region, not both")
    mon = _mon()
    s = _scale(mon)
    if window:
        hwnd, title, (l, t, r, b) = _find_window(window)
        l, t = max(l, mon["left"]), max(t, mon["top"])
        r, b = min(r, mon["left"] + mon["width"]), min(b, mon["top"] + mon["height"])
        if r <= l or b <= t:
            raise RuntimeError(f"window {title!r} is not on the active monitor ({coords._active_monitor})")
        label = f"window {title!r} #{hwnd}"
        cover = _covering(hwnd)
        if cover:
            label += f" (PARTLY COVERED by {', '.join(map(repr, cover[:3]))}: focus it first)"
        return {"left": l, "top": t, "width": r - l, "height": b - t}, label
    if region:
        if len(region) != 4:
            raise ValueError("region is [x, y, width, height] in screenshot coordinates")
        x, y, w, h = region
        l = mon["left"] + max(0, round(x / s))
        t = mon["top"] + max(0, round(y / s))
        r = min(mon["left"] + mon["width"], mon["left"] + round((x + w) / s))
        b = min(mon["top"] + mon["height"], mon["top"] + round((y + h) / s))
        if r <= l or b <= t:
            raise ValueError("region is empty or outside the active monitor")
        return {"left": l, "top": t, "width": r - l, "height": b - t}, "region"
    return dict(mon), ""


def _fingerprint(box: dict) -> str:
    with _MSS() as sct:
        return hashlib.md5(sct.grab(box).raw).hexdigest()


def _grab(box: dict):
    with _MSS() as sct:
        g = sct.grab(box)
    return PILImage.frombytes("RGB", g.size, g.bgra, "raw", "BGRX")


@mcp.tool(structured_output=False)
@_logged
def screen_info() -> str:
    """Monitors, the active monitor and its screenshot size, current mouse position (screenshot coords of the
    active monitor), and safety state (readonly, stop hotkey, log file)."""
    mons = _monitors()
    mon = _mon()
    s = _scale(mon)
    mx, my = pyautogui.position()
    cx, cy = _from_screen(mx, my)
    desc = "; ".join(f"{i}: {m['width']}x{m['height']} at ({m['left']},{m['top']})" for i, m in enumerate(mons, 1))
    return (f"monitors=[{desc}] active={min(coords._active_monitor, len(mons))} "
            f"screenshot={round(mon['width'] * s)}x{round(mon['height'] * s)} mouse=({cx},{cy}) "
            f"readonly={safety.READONLY} stopped={safety._stopped} kill_switch={'ON(' + (_kill_switch() or 'inputs') + ')' if _kill_switch() is not None else 'off'} stop_key=[{safety._stop_key_status}] speed={safety.SPEED} log={LOG_PATH}")


_last_shot: tuple | None = None  # (capture key, image) last returned, so a repeat of it is not sent again


def _changed_pixels(a, b) -> int:
    """Pixels that differ visibly (any channel by more than 16) between two same-size images."""
    diff = ImageChops.difference(a, b)
    if diff.getbbox() is None:
        return 0
    return diff.convert("L").point(lambda v: 255 if v > 16 else 0).histogram()[255]


@mcp.tool(structured_output=False)
@_logged
def screenshot(window: str | None = None, region: list[int] | None = None, scale: float = 1.0,
               cursor: bool = True, monitor: int | None = None, force: bool = False) -> list:
    """Capture the screen (the active monitor; primary by default). All other tools use this image's coordinates.

    window: title substring (case-insensitive) or "active" - return only that window, far cheaper in context.
    region: [x, y, width, height] in full-screenshot coordinates - return only that part (e.g. to zoom).
    scale: output size multiplier (0.1-4). Below 1 saves context, above 1 zooms in on small details.
    cursor: draw a red ring at the mouse position (a marker only; the real cursor is not captured).
    monitor: 1-based monitor number; switches the active monitor for ALL tools until changed.
    force: send the image even if it is identical to the last one returned (by default only a note is sent).

    A crop or scaled image is not in full-screenshot coordinates: the accompanying text gives the offset and scale,
    and screenshot coords are  x = offset_x + px/scale,  y = offset_y + py/scale."""
    global _last_shot
    _guard_read()
    if monitor is not None:
        if not 1 <= monitor <= len(_monitors()):
            raise ValueError(f"monitor must be 1..{len(_monitors())}")
        coords._active_monitor = monitor
    if not 0.1 <= scale <= 4:
        raise ValueError("scale must be between 0.1 and 4")
    mon = _mon()
    s = _scale(mon)
    box, label = _box(window, region)
    with _MSS() as sct:
        shot = sct.grab(box)
    img = PILImage.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    out_scale = s * scale
    size = (max(1, round(img.width * out_scale)), max(1, round(img.height * out_scale)))
    if size[0] * size[1] > 16_000_000:
        raise ValueError("requested image is too large; lower scale or use a smaller region")
    if size != img.size:
        img = img.resize(size, PILImage.LANCZOS)

    mx, my = pyautogui.position()
    cur_note = ""
    cx, cy = _from_screen(mx, my)
    px, py = round((mx - box["left"]) * out_scale), round((my - box["top"]) * out_scale)
    if cursor and 0 <= px < img.width and 0 <= py < img.height:
        d = ImageDraw.Draw(img)
        for r, col in ((10, "white"), (8, "red"), (6, "white")):
            d.ellipse([px - r, py - r, px + r, py + r], outline=col, width=2 if col == "red" else 1)
        d.ellipse([px - 1, py - 1, px + 1, py + 1], fill="red")
    cur_note = f"cursor=({cx},{cy})"

    ox, oy = round((box["left"] - mon["left"]) * s), round((box["top"] - mon["top"]) * s)
    note = f"monitor {min(coords._active_monitor, len(_monitors()))} {img.width}x{img.height}px {cur_note}"
    if label or scale != 1.0:
        note = (f"{label + ': ' if label else ''}offset_x={ox} offset_y={oy} scale={scale} -> "
                f"screenshot x = {ox} + px/{scale}, y = {oy} + py/{scale}; {note}")
    # every image stays in the conversation and is re-read on each later turn, so skip repeats. A few stray pixels
    # (a window edge where something behind it scrolls, a blinking caret) still count as the same picture.
    key = (tuple(box.values()), img.size, cursor)
    if _last_shot and _last_shot[0] == key and not force:
        n = _changed_pixels(_last_shot[1], img)
        if n <= min(64, img.width * img.height // 5000):
            return [f"unchanged: same as the previous screenshot ({n} px differ; image not resent, force=True "
                    f"to resend). {note}"]
    _last_shot = (key, img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return [Image(data=buf.getvalue(), format="png"), note]


@mcp.tool(structured_output=False)
@_logged
def pixels(points: list[list[int]]) -> str:
    """Colours (#rrggbb) at up to 100 [x, y] screenshot-coordinate points. A few tokens instead of an image:
    use it to check that a fill/selection/toggle took effect, or to probe where something is."""
    _guard_read()
    if not 1 <= len(points) <= 100 or any(len(p) != 2 for p in points):
        raise ValueError("points must be 1-100 [x, y] pairs")
    out = []
    with _MSS() as sct:
        for x, y in points:
            sx, sy = _to_screen(x, y)
            r, g, b = sct.grab({"left": sx, "top": sy, "width": 1, "height": 1}).pixel(0, 0)
            out.append(f"({x},{y})=#{r:02x}{g:02x}{b:02x}")
    return " ".join(out)


def _shot_box(shot_window: str | None) -> dict:
    return _box(shot_window, None)[0] if shot_window else dict(_mon())


def _change_areas(mask, cell: int = 16, max_areas: int = 4) -> list[tuple]:
    """Group changed pixels into separate areas (cells within 2 cells of each other join up), so two small
    distant changes - a swatch and a status bar - give two small crops, not one crop spanning both."""
    grid = mask.reduce(cell)
    on = {(x, y) for y in range(grid.height) for x in range(grid.width) if grid.getpixel((x, y))}
    areas = []
    while on:
        stack = [on.pop()]
        x0 = x1 = stack[0][0]
        y0 = y1 = stack[0][1]
        while stack:
            cx, cy = stack.pop()
            x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
            for nx in range(cx - 2, cx + 3):
                for ny in range(cy - 2, cy + 3):
                    if (nx, ny) in on:
                        on.discard((nx, ny))
                        stack.append((nx, ny))
        areas.append((x0 * cell, y0 * cell, min(mask.width, (x1 + 1) * cell), min(mask.height, (y1 + 1) * cell)))
    if len(areas) > max_areas:  # scattered change: one crop of all of it
        areas = [(min(a[0] for a in areas), min(a[1] for a in areas), max(a[2] for a in areas),
                  max(a[3] for a in areas))]
    return sorted(areas, key=lambda a: (a[1], a[0]))


def _diff_shot(before, shot_window: str | None) -> list:
    """Only the parts of the screen/window that changed since `before` was grabbed, as crops in screenshot scale."""
    box = _shot_box(shot_window)
    after = _grab(box)
    if after.size != before.size:  # window moved or resized: a plain screenshot is the honest answer
        return screenshot(window=shot_window, force=True)
    mask = ImageChops.difference(before, after).convert("L").point(lambda v: 255 if v > 16 else 0)
    if mask.getbbox() is None:
        return ["diff: no visible change"]
    mon = _mon()
    s = _scale(mon)
    pad = round(12 / s)
    out = []
    for l, t, r, b in _change_areas(mask):
        l, t = max(0, l - pad), max(0, t - pad)
        r, b = min(after.width, r + pad), min(after.height, b + pad)
        crop = after.crop((l, t, r, b))
        crop = crop.resize((max(1, round(crop.width * s)), max(1, round(crop.height * s))), PILImage.LANCZOS)
        ox, oy = round((box["left"] + l - mon["left"]) * s), round((box["top"] + t - mon["top"]) * s)
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        out += [Image(data=buf.getvalue(), format="png"),
                f"diff area {len(out) // 2 + 1}: {crop.width}x{crop.height}px; screenshot x = {ox} + px, y = {oy} + py"]
    return out


def _finish(parts: list[str], shot: bool | str, shot_window: str | None, before=None):
    """Join result text; optionally append a fresh screenshot (whole screen or one window), or with shot="diff"
    and a `before` grab of the same area, just the changed part."""
    text = " | ".join(p for p in parts if p)
    if not shot:
        return text
    _pause(0.2)
    if shot == "diff" and before is not None:
        return [text, *_diff_shot(before, shot_window)]
    return [text, *screenshot(window=shot_window)]


def _act(do, points, verify: bool, shot: bool | str, shot_window: str | None, msg: str):
    """Run an input action, optionally verifying that pixels near it changed, optionally attaching a screenshot.
    points: real screen pixels the action touches (verify watches their bounding box); empty = whole monitor."""
    shot_before = _grab(_shot_box(shot_window)) if shot == "diff" else None
    box = before = None
    if verify:
        mon = _mon()
        if points:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            pad = 60
            l, t = max(mon["left"], min(xs) - pad), max(mon["top"], min(ys) - pad)
            r = min(mon["left"] + mon["width"], max(xs) + pad)
            b = min(mon["top"] + mon["height"], max(ys) + pad)
            box = {"left": l, "top": t, "width": r - l, "height": b - t}
        else:
            box = dict(mon)
        before = _fingerprint(box)
    do()
    parts = [msg]
    if verify:
        _pause(0.25)
        parts.append("verify: pixels changed" if _fingerprint(box) != before else
                     "verify: NO VISIBLE CHANGE near the action (it may have been ignored)")
    return _finish(parts, shot, shot_window, shot_before)
