"""Window tools: list, focus, launch, move/resize."""
import ctypes
import os
import time
from ctypes import wintypes

from .app import _logged, _user32, mcp
from .capture import _finish
from .coords import _mon, _scale
from .safety import _guard, _guard_read, _pause
from .winapi import _covering, _find_window, _foreground, _visible_rect, _windows


@mcp.tool(structured_output=False)
@_logged
def list_windows() -> str:
    """List visible windows (handle, title, rectangle in the active monitor's screenshot coordinates), topmost
    first; * marks the foreground one. Pass a title substring, or "#<handle>" when titles repeat, as `window` in
    screenshot()/focus_window()/batch(origin=)."""
    _guard_read()
    mon = _mon()
    s = _scale(mon)
    fg = _user32.GetForegroundWindow()
    lines = []
    for hwnd, title, (l, t, r, b) in _windows():
        lines.append(f"{'*' if hwnd == fg else ' '}#{hwnd} {title!r}  x={round((l - mon['left']) * s)} "
                     f"y={round((t - mon['top']) * s)} w={round((r - l) * s)} h={round((b - t) * s)}")
    return "\n".join(lines) or "no windows"


@mcp.tool(structured_output=False)
@_logged
def focus_window(title: str, shot: bool = False):
    """Bring a window to the foreground, restoring it if minimised. title: a title substring (first match),
    or "#<handle>" from list_windows when several windows share a title. shot: append a screenshot of it."""
    _guard()
    hwnd, full, _ = _find_window(title, include_minimized=True)
    if _user32.IsIconic(hwnd):
        _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    if not _foreground(hwnd):
        msg = f"asked Windows to focus {full!r} #{hwnd} but it did not take the foreground (another app may be holding it)"
    else:
        cover = _covering(hwnd)
        msg = f"focused {full!r} #{hwnd}" + (f"; still covered by always-on-top {', '.join(map(repr, cover))}"
                                            if cover else "")
    return _finish([msg], shot, f"#{hwnd}")


@mcp.tool(structured_output=False)
@_logged
def launch(app: str, args: str = "", wait_for_window: str | None = None, timeout: float = 8.0):
    """Start a program or open a file/URL the way the Run dialog would (e.g. 'mspaint', 'notepad', a path).
    args: command-line arguments. wait_for_window: title substring to wait for; the NEW window with that title is
    then focused and its #handle returned (an older same-titled window is used only if no new one appears).
    Prefer this over typing into Win+R. It is logged like every other action."""
    _guard()
    before = {w[0] for w in _windows(include_minimized=True)}
    if args:
        os.startfile(app, arguments=args)
    else:
        os.startfile(app)
    if not wait_for_window:
        return f"launched {app}"
    q = wait_for_window.lower()
    deadline = time.time() + min(60.0, max(0.5, timeout))
    while time.time() < deadline:
        new = [w for w in _windows() if q in w[1].lower() and w[0] not in before]
        if new:
            hwnd, full, _ = new[0]
            _foreground(hwnd)
            return f"launched {app}; new window {full!r} #{hwnd} is up and focused"
        time.sleep(0.2)
    try:  # single-instance apps reuse an existing window
        hwnd, full, _ = _find_window(wait_for_window)
    except RuntimeError:
        return f"launched {app}; no window matching {wait_for_window!r} appeared within {timeout}s"
    _foreground(hwnd)
    return f"launched {app}; no new window appeared, focused existing {full!r} #{hwnd}"


@mcp.tool(structured_output=False)
@_logged
def set_window(window: str, x: int | None = None, y: int | None = None, width: int | None = None,
               height: int | None = None, state: str | None = None) -> str:
    """Move/resize a window (visible frame, screenshot coordinates; omitted values keep the current ones) and/or
    set state: "maximize", "minimize" or "restore". A fixed position and size keeps coordinates stable between
    runs (and between saved macros). window: title substring, "#handle" or "active"."""
    _guard()
    hwnd, title, _ = _find_window(window, include_minimized=True)
    if state:
        cmd = {"maximize": 3, "minimize": 6, "restore": 9}.get(state.lower())
        if cmd is None:
            raise ValueError("state must be maximize, minimize or restore")
        _user32.ShowWindow(hwnd, cmd)
        _pause(0.3)
    if any(v is not None for v in (x, y, width, height)):
        if _user32.IsZoomed(hwnd) or _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, 9)  # SW_RESTORE: a maximised window ignores SetWindowPos
            _pause(0.3)
        wr = wintypes.RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(wr))
        vl, vt, vr, vb = _visible_rect(hwnd)
        il, it, ir, ib = vl - wr.left, vt - wr.top, wr.right - vr, wr.bottom - vb  # invisible resize borders
        mon = _mon()
        s = _scale(mon)
        nl = mon["left"] + round(x / s) if x is not None else vl
        nt = mon["top"] + round(y / s) if y is not None else vt
        nw = round(width / s) if width is not None else vr - vl
        nh = round(height / s) if height is not None else vb - vt
        _user32.SetWindowPos(hwnd, None, nl - il, nt - it, nw + il + ir, nh + it + ib, 0x0004 | 0x0010)  # NOZORDER|NOACTIVATE
        _pause(0.2)
    if _user32.IsIconic(hwnd):
        return f"window {title!r} #{hwnd} is minimised"
    mon = _mon()
    s = _scale(mon)
    l, t, r, b = _visible_rect(hwnd)
    return (f"window {title!r} #{hwnd} now x={round((l - mon['left']) * s)} y={round((t - mon['top']) * s)} "
            f"w={round((r - l) * s)} h={round((b - t) * s)}")
