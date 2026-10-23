"""Mouse, keyboard and clipboard tools. All pointer movement goes through SendInput (_move)."""
import ctypes
import difflib
import math
import time
from ctypes import wintypes

import pyautogui

from . import safety
from .app import _logged, _user32, mcp
from .capture import _act
from .coords import _to_screen
from .safety import _guard, _guard_read, _held_buttons, _held_keys, _pause, _release_all


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _MOUSEINPUT(ctypes.Structure):  # used by _move; its size also sets the INPUT union size SendInput validates
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


# ----------------------------------------------------------------------------------- mouse input

def _move(sx: int, sy: int):
    """Move the pointer with a real SendInput mouse-move event. pyautogui.moveTo uses SetCursorPos, which only
    repositions the cursor: pointer-input apps (WinUI Paint, ink canvases) never see the motion, so a held-button
    stroke collapsed to a straight line from press to release."""
    pyautogui.failSafeCheck()
    vl, vt = _user32.GetSystemMetrics(76), _user32.GetSystemMetrics(77)  # SM_X/YVIRTUALSCREEN
    vw, vh = _user32.GetSystemMetrics(78), _user32.GetSystemMetrics(79)  # SM_CX/CYVIRTUALSCREEN
    dx = ((sx - vl) * 65536 + vw // 2) // vw
    dy = ((sy - vt) * 65536 + vh // 2) // vh
    # MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    inp = _INPUT(type=0, mi=_MOUSEINPUT(dx, dy, 0, 0x0001 | 0x8000 | 0x4000, 0, 0))
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))


def _move_to(sx: int, sy: int, duration: float = 0.0):
    """Glide from the current position to (sx, sy) over `duration` seconds (already speed-adjusted)."""
    _glide(pyautogui.position(), (sx, sy), duration)


def _hover(sx: int, sy: int, duration: float = 0.12):
    """Move to a point and let the app see the pointer arrive. Many apps (WinUI/Electron) ignore a button press
    that was not preceded by hover events, which made the first press after a click get dropped."""
    _guard()
    _move_to(sx, sy, duration / safety.SPEED)
    _pause(0.05)
    _move(sx + 1, sy + 1)
    _move(sx, sy)
    _pause(0.03)


def _glide(a, b, duration: float):
    dist = math.hypot(b[0] - a[0], b[1] - a[1])
    steps = max(1, int(dist / 10))
    dt = duration / steps
    for i in range(1, steps + 1):
        _guard()
        _move(round(a[0] + (b[0] - a[0]) * i / steps), round(a[1] + (b[1] - a[1]) * i / steps))
        # at least a short gap per step: a burst of moves gets coalesced and the app misses the corners
        time.sleep(max(dt, 0.004))


def _stroke(points, button: str, duration: float | None):
    """Hover at the first point, press, glide through the rest, release (always released, even on abort)."""
    _hover(*points[0])
    segs = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:])]
    total = sum(segs) or 1.0
    dur = (duration if duration is not None else max(0.2, min(3.0, total / 1200))) / safety.SPEED
    pyautogui.mouseDown(button=button)
    _held_buttons.add(button)
    try:
        _pause(0.04)
        for a, b, ln in zip(points, points[1:], segs):
            _glide(a, b, dur * ln / total)
        _pause(0.03)
    finally:
        pyautogui.mouseUp(button=button)
        _held_buttons.discard(button)


@mcp.tool(structured_output=False)
@_logged
def mouse_move(x: int, y: int, duration: float | None = None):
    """Move the mouse to (x, y) in screenshot coordinates. duration: seconds (default 0.15)."""
    _guard()
    sx, sy = _to_screen(x, y)
    _move_to(sx, sy, (0.15 if duration is None else duration) / safety.SPEED)
    return f"moved to ({x},{y})"


def _click(x, y, button, clicks, verify, shot, shot_window, label):
    _guard()
    if button not in ("left", "right", "middle"):
        raise ValueError("button must be left, right or middle")
    clicks = max(1, min(3, clicks))
    sx, sy = _to_screen(x, y)

    def do():
        _hover(sx, sy)
        pyautogui.click(clicks=clicks, interval=0.08, button=button)

    return _act(do, [(sx, sy)], verify, shot, shot_window, f"{label} {button} x{clicks} at ({x},{y})")


@mcp.tool(structured_output=False)
@_logged
def click(x: int, y: int, button: str = "left", clicks: int = 1, verify: bool = False, shot: bool | str = False,
          shot_window: str | None = None):
    """Click at (x, y) in screenshot coordinates. button: left|right|middle. clicks: 1-3.
    verify: report whether pixels near the click changed (flags ignored clicks).
    shot: True appends a screenshot (shot_window limits it to one window); "diff" appends only the part that
    changed, the cheapest way to see an action's effect."""
    return _click(x, y, button, clicks, verify, shot, shot_window, "clicked")


@mcp.tool(structured_output=False)
@_logged
def double_click(x: int, y: int, verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Double-click (left) at (x, y). See click for verify/shot."""
    return _click(x, y, "left", 2, verify, shot, shot_window, "double-clicked")


@mcp.tool(structured_output=False)
@_logged
def right_click(x: int, y: int, verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Right-click at (x, y), e.g. to open a context menu. See click for verify/shot."""
    return _click(x, y, "right", 1, verify, shot, shot_window, "right-clicked")


@mcp.tool(structured_output=False)
@_logged
def mouse_down(x: int | None = None, y: int | None = None, button: str = "left"):
    """Press and HOLD a mouse button (at x,y, or where the pointer is). Pair with mouse_up; release_all or the
    stop hotkey also release it."""
    _guard()
    if x is not None and y is not None:
        _hover(*_to_screen(x, y))
    pyautogui.mouseDown(button=button)
    _held_buttons.add(button)
    return f"{button} button down"


@mcp.tool(structured_output=False)
@_logged
def mouse_up(x: int | None = None, y: int | None = None, button: str = "left"):
    """Release a held mouse button (optionally moving to x,y first)."""
    _guard()
    if x is not None and y is not None:
        _move_to(*_to_screen(x, y), 0.1 / safety.SPEED)
    pyautogui.mouseUp(button=button)
    _held_buttons.discard(button)
    return f"{button} button up"


@mcp.tool(structured_output=False)
@_logged
def drag(x1: int, y1: int, x2: int, y2: int, button: str = "left", duration: float | None = None,
         verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Press at (x1,y1), drag to (x2,y2), release. Screenshot coordinates. duration: total seconds (default
    scales with length). verify/shot: see click. For multi-segment strokes use path."""
    _guard()
    a, b = _to_screen(x1, y1), _to_screen(x2, y2)
    return _act(lambda: _stroke([a, b], button, duration), [a, b], verify, shot, shot_window,
                f"dragged ({x1},{y1}) -> ({x2},{y2})")


@mcp.tool(structured_output=False)
@_logged
def path(points: list[list[int]], button: str = "left", closed: bool = False, duration: float | None = None,
         verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Press at the first point, move through all the others in order, release - one call per stroke. Use it to
    draw lines, polygons and curves (many close points), or trace shapes. points: [[x,y], ...] in screenshot
    coordinates (2-500 points). closed: also return to the first point. duration: total seconds."""
    _guard()
    if not 2 <= len(points) <= 500 or any(len(p) != 2 for p in points):
        raise ValueError("points must be 2-500 [x, y] pairs")
    pts = [_to_screen(x, y) for x, y in points]
    if closed:
        pts.append(pts[0])
    return _act(lambda: _stroke(pts, button, duration), pts, verify, shot, shot_window,
                f"path of {len(points)} points{' (closed)' if closed else ''}")


@mcp.tool(structured_output=False)
@_logged
def ellipse(cx: int, cy: int, rx: int, ry: int | None = None, button: str = "left", duration: float | None = None,
            verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Draw a circle (ry omitted) or ellipse as one closed stroke around (cx, cy), radii in screenshot pixels.
    Saves computing the points for path. verify/shot: see click."""
    _guard()
    ry = rx if ry is None else ry
    n = max(16, min(120, round(math.pi * (rx + ry) / 4)))  # a point every ~8 px of perimeter
    pts = [_to_screen(round(cx + rx * math.cos(2 * math.pi * i / n)), round(cy + ry * math.sin(2 * math.pi * i / n)))
           for i in range(n + 1)]
    return _act(lambda: _stroke(pts, button, duration), pts, verify, shot, shot_window,
                f"ellipse at ({cx},{cy}) r=({rx},{ry})")


@mcp.tool(structured_output=False)
@_logged
def scroll(amount: int, x: int | None = None, y: int | None = None, verify: bool = False, shot: bool | str = False,
           shot_window: str | None = None):
    """Scroll the wheel at (x, y) (or current position). Positive = up, negative = down. See click for verify/shot."""
    _guard()

    def do():
        if x is not None and y is not None:
            _hover(*_to_screen(x, y))
        pyautogui.scroll(amount * 120)

    pts = [_to_screen(x, y)] if x is not None and y is not None else []
    return _act(do, pts, verify, shot, shot_window, f"scrolled {amount}")


# -------------------------------------------------------------------------------- keyboard input

def _send_unicode(s: str, interval: float):
    """Type characters via KEYEVENTF_UNICODE (works for any character, independent of keyboard layout)."""
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        unit = int.from_bytes(data[i:i + 2], "little")
        for flags in (0x0004, 0x0004 | 0x0002):  # KEYEVENTF_UNICODE, then | KEYEVENTF_KEYUP
            inp = _INPUT(type=1, ki=_KEYBDINPUT(0, unit, flags, 0, 0))
            _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))
        if interval:
            time.sleep(interval)


@mcp.tool(structured_output=False)
@_logged
def type_text(text: str, interval: float = 0.01, verify: bool = False, shot: bool | str = False,
              shot_window: str | None = None):
    """Type text into the focused control. Any Unicode works (emoji, accents, symbols); newline presses Enter and
    tab presses Tab. ASCII goes through normal key events, other characters through Unicode input events (a few
    apps, such as some remote-desktop or game windows, ignore those). verify/shot: see click."""
    _guard()

    def do():
        run = []

        def flush():
            if run:
                pyautogui.write("".join(run), interval=interval)
                run.clear()

        for ch in text:
            _guard()
            if ord(ch) < 128:
                run.append(ch)
            else:
                flush()
                _send_unicode(ch, interval)
        flush()

    return _act(do, [], verify, shot, shot_window, f"typed {len(text)} chars")


_KEY_ALIASES = {"control": "ctrl", "windows": "win", "cmd": "win", "command": "win", "super": "win",
                "meta": "win", "option": "alt", "bksp": "backspace", "spacebar": "space", "caps": "capslock",
                "plus": "+", "minus": "-", "prtsc": "printscreen", "pgup": "pageup", "pgdn": "pagedown",
                "del": "delete", "return": "enter", "escape": "esc"}


def _parse_keys(keys: str) -> list[str]:
    raw = keys.strip().lower()
    if not raw:
        raise ValueError("no keys given")
    tail = []
    if raw.endswith("++"):  # e.g. "ctrl++"
        raw, tail = raw[:-2], ["+"]
    parts = [p.strip() for p in raw.split("+")] if raw else []
    parts = [_KEY_ALIASES.get(p, p) for p in parts + tail]
    bad = [p for p in parts if p not in pyautogui.KEYBOARD_KEYS or p == ""]
    if bad:
        hint = []
        for b in bad:
            close = difflib.get_close_matches(b, pyautogui.KEYBOARD_KEYS, n=3)
            hint.append(f"{b!r}" + (f" (did you mean {', '.join(close)}?)" if close else ""))
        msg = f"unknown key(s): {'; '.join(hint)}. Combine keys with '+', e.g. 'ctrl+shift+s'."
        if not all(difflib.get_close_matches(b, pyautogui.KEYBOARD_KEYS, n=1) for b in bad):
            named = sorted(k for k in pyautogui.KEYBOARD_KEYS if len(k) > 1)
            msg += f" Named keys: {', '.join(named)}; single characters are also valid."
        raise ValueError(msg)
    return parts


def _single_key(key: str) -> str:
    parts = _parse_keys(key)
    if len(parts) != 1:
        raise ValueError("this tool takes a single key; use press_key for combos")
    return parts[0]


@mcp.tool(structured_output=False)
@_logged
def press_key(keys: str, verify: bool = False, shot: bool | str = False, shot_window: str | None = None):
    """Press a key or combo, e.g. 'enter', 'tab', 'ctrl+s', 'alt+f4', 'win+r'. Use '+' to combine. Unknown key
    names are rejected with suggestions. verify/shot: see click."""
    _guard()
    parts = _parse_keys(keys)

    def do():
        if len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts)

    return _act(do, [], verify, shot, shot_window, f"pressed {keys}")


@mcp.tool(structured_output=False)
@_logged
def key_down(key: str):
    """Press and HOLD a key (e.g. 'shift' for a shift-drag). Pair with key_up; release_all or the stop hotkey
    also release it."""
    _guard()
    k = _single_key(key)
    pyautogui.keyDown(k)
    _held_keys.add(k)
    return f"holding {k}"


@mcp.tool(structured_output=False)
@_logged
def key_up(key: str):
    """Release a key held with key_down."""
    _guard()
    k = _single_key(key)
    pyautogui.keyUp(k)
    _held_keys.discard(k)
    return f"released {k}"


@mcp.tool(structured_output=False)
@_logged
def release_all():
    """Release every mouse button and key currently held by this server (mouse_down/key_down). Use after an error."""
    held = sorted(_held_buttons) + sorted(_held_keys)
    _release_all()
    return f"released: {', '.join(held) or 'nothing held'}"


# -------------------------------------------------------------------------------------- clipboard

def _open_clipboard():
    import win32clipboard
    for _ in range(10):  # another app may hold it for a moment
        try:
            win32clipboard.OpenClipboard()
            return win32clipboard
        except Exception:
            time.sleep(0.05)
    raise RuntimeError("could not open the clipboard (another app is holding it)")


@mcp.tool(structured_output=False)
@_logged
def clipboard(text: str | None = None) -> str:
    """Read the clipboard text (no text argument) or set it (text). Setting it and pressing ctrl+v pastes long text
    instantly; reading it after ctrl+c gets text without a screenshot. Logged by length only."""
    if text is None:
        _guard_read()
        cb = _open_clipboard()
        try:
            data = cb.GetClipboardData(cb.CF_UNICODETEXT) if cb.IsClipboardFormatAvailable(cb.CF_UNICODETEXT) else None
        finally:
            cb.CloseClipboard()
        if data is None:
            return "clipboard has no text"
        more = f" (first 20000 shown)" if len(data) > 20000 else ""
        return f"clipboard ({len(data)} chars{more}): {data[:20000]}"
    _guard()
    cb = _open_clipboard()
    try:
        cb.EmptyClipboard()
        cb.SetClipboardText(text, cb.CF_UNICODETEXT)
    finally:
        cb.CloseClipboard()
    return f"clipboard set ({len(text)} chars)"
