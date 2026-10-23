"""Waiting: fixed sleeps, waiting for the screen to change, and waiting for a condition."""
import re
import time

from .app import _logged, mcp
from .capture import _box, _fingerprint, _grab
from .coords import _MSS, _to_screen
from .ocr import _ocr_lines
from .safety import _guard_read
from .uia import _ui, _ui_walk
from .winapi import _find_window, _windows


@mcp.tool(structured_output=False)
@_logged
def wait(seconds: float = 1.0) -> str:
    """Wait (max 10s) for the UI to settle before the next screenshot. Prefer wait_for_change."""
    time.sleep(max(0.0, min(10.0, seconds)))
    return f"waited {seconds}s"


@mcp.tool(structured_output=False)
@_logged
def wait_for_change(timeout: float = 5.0, settle: float = 0.4, window: str | None = None,
                    region: list[int] | None = None, require_change: bool = True) -> str:
    """Wait until the screen (or one window / region) changes and then stays unchanged for `settle` seconds, or
    until `timeout` (max 60). require_change=False just waits for the area to be still. Scope it with window or
    region so unrelated motion (clocks, other windows) does not count."""
    _guard_read()
    box, _ = _box(window, region)
    timeout = max(0.1, min(60.0, timeout))
    t0 = time.time()
    last = _fingerprint(box)
    last_change = None if require_change else t0
    changed = False
    while time.time() - t0 < timeout:
        time.sleep(0.1)
        cur = _fingerprint(box)
        now = time.time()
        if cur != last:
            last, last_change, changed = cur, now, True
        if last_change is not None and now - last_change >= settle:
            what = "changed, then settled" if changed else "was already still"
            return f"{what} after {now - t0:.1f}s"
    if changed:
        return f"changed but still changing after {timeout}s"
    return f"no change within {timeout}s"


_COLOR = re.compile(r"^#?([0-9a-fA-F]{6})$")


def _pixel_at(x: int, y: int) -> tuple[int, int, int]:
    sx, sy = _to_screen(x, y)
    with _MSS() as sct:
        return tuple(sct.grab({"left": sx, "top": sy, "width": 1, "height": 1}).pixel(0, 0))


def _parse_color(color: str) -> tuple[int, int, int]:
    m = _COLOR.match(color.strip())
    if not m:
        raise ValueError(f"color must be '#rrggbb', got {color!r}")
    h = m.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _near(a, b, tolerance: int) -> bool:
    return all(abs(p - q) <= tolerance for p, q in zip(a, b))


def _control_present(window: str, name: str, control_type: str | None) -> bool:
    """An on-screen control in `window` whose name contains `name`. A window that is not open has no controls."""
    try:
        hwnd, _, _ = _find_window(window)
    except RuntimeError:
        return False
    n, ct = name.lower(), control_type.lower().removesuffix("control") if control_type else None
    hits = _ui_walk(_ui().ControlFromHandle(hwnd), 30, 1,
                    lambda c, typ, p: n in (c.Name or "").lower() and (not ct or typ.lower() == ct))
    return next(hits, None) is not None


def _text_present(window: str | None, region: list[int] | None, text: str) -> bool:
    try:
        box, _ = _box(window, region)
    except RuntimeError:  # window not open (yet)
        return False
    q = " ".join(text.lower().split())
    return any(q in " ".join(line.lower().split()) for line, _ in _ocr_lines(_grab(box)))


@mcp.tool(structured_output=False)
@_logged
def wait_for(control: str | None = None, text: str | None = None, title: str | None = None,
             pixel: list[int] | None = None, color: str | None = None, gone: bool = False,
             window: str | None = None, region: list[int] | None = None, control_type: str | None = None,
             timeout: float = 10.0, interval: float | None = None) -> str:
    """Wait until something is on screen (or gone) instead of sleeping a guessed time. Give exactly one of:
    control: a UI Automation control whose name contains this, in `window` (default "active"; a dialog that is
      still opening counts as not there yet); control_type narrows it (Button, Text, ...).
    text: Windows OCR finds this text (one line, case-insensitive) in `window`/`region` (default the screen).
      Slower (about 0.3-1 s per look); use it where UI Automation sees nothing (canvases, remote desktops).
    title: a visible window whose title contains this.
    pixel: [x, y] (screenshot coordinates) shows `color` ("#rrggbb", within 24 per channel); without color, until
      it differs from its colour when the wait started.
    gone=True: wait for the control/text/window to disappear, or the pixel to stop showing `color`.
    timeout: seconds (max 120). On timeout this RAISES, so a batch or macro stops at the step instead of running on
    blind. interval: seconds between looks (default 0.25, 0.6 for text). Usable as a batch step."""
    conds = [c for c in (control, text, title, pixel) if c]
    if len(conds) != 1:
        raise ValueError("give exactly one of control, text, title or pixel")
    if gone and pixel and not color:
        raise ValueError("gone with pixel needs color (the colour to wait to disappear)")
    timeout = max(0.0, min(120.0, timeout))
    interval = max(0.05, interval if interval is not None else 0.6 if text else 0.25)
    if control:
        what = f"control {control!r}" + (f" ({control_type})" if control_type else "") + f" in {window or 'active'}"
        check = lambda: _control_present(window or "active", control, control_type)
    elif text:
        what = f"text {text!r} in {window or ('region' if region else 'screen')}"
        check = lambda: _text_present(window, region, text)
    elif title:
        what = f"window titled {title!r}"
        check = lambda: any(title.lower() in w[1].lower() for w in _windows())
    else:
        if len(pixel) != 2:
            raise ValueError("pixel is [x, y]")
        if color:
            want = _parse_color(color)
            what = f"pixel ({pixel[0]},{pixel[1]}) = {color}"
            check = lambda: _near(_pixel_at(*pixel), want, 24)
        else:
            start = _pixel_at(*pixel)
            what = f"pixel ({pixel[0]},{pixel[1]}) to change from #{start[0]:02x}{start[1]:02x}{start[2]:02x}"
            check = lambda: not _near(_pixel_at(*pixel), start, 24)
    t0 = time.time()
    while True:
        _guard_read()
        if check() != gone:
            return f"{what}{' gone' if gone else ''} after {time.time() - t0:.1f}s"
        if time.time() - t0 >= timeout:
            raise TimeoutError(f"gave up after {timeout}s waiting for {what}{' to go' if gone else ''}")
        time.sleep(interval)
