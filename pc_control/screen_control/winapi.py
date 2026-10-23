"""Top-level window enumeration, lookup by title/#handle, z-order coverage and foregrounding."""
import ctypes
from ctypes import wintypes

from .app import _dwm, _user32
from .safety import _pause

_DWMWA_CLOAKED = 14
_DWMWA_EXTENDED_FRAME_BOUNDS = 9


def _windows(include_minimized=False):
    """Visible, titled top-level windows in z-order (topmost first): [(hwnd, title, (l,t,r,b))]."""
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if not _user32.IsWindowVisible(hwnd):
            return True
        minimized = bool(_user32.IsIconic(hwnd))
        if minimized and not include_minimized:
            return True
        cloaked = ctypes.c_int(0)
        _dwm.DwmGetWindowAttribute(hwnd, _DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        n = _user32.GetWindowTextLengthW(hwnd)
        if cloaked.value or n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        _user32.GetWindowTextW(hwnd, buf, n + 1)
        r = wintypes.RECT()
        # extended frame bounds = the visible window, without the invisible resize border
        _dwm.DwmGetWindowAttribute(hwnd, _DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r))
        if minimized or (r.right - r.left > 0 and r.bottom - r.top > 0):
            out.append((hwnd, buf.value, (r.left, r.top, r.right, r.bottom)))
        return True

    _user32.EnumWindows(cb, 0)
    return out


def _find_window(query: str, include_minimized=False):
    """query: "active", "#<handle>" (from list_windows; picks one of several same-titled windows), or a title
    substring (first match in z-order)."""
    q = query.strip().lower()
    if q == "active":
        fg = _user32.GetForegroundWindow()
        match = [w for w in _windows(include_minimized) if w[0] == fg]
    elif q.startswith("#") and q[1:].isdigit():
        match = [w for w in _windows(include_minimized) if w[0] == int(q[1:])]
    else:
        match = [w for w in _windows(include_minimized) if q in w[1].lower()]
    if not match:
        raise RuntimeError(f"no visible window matching {query!r}; call list_windows to see titles and handles")
    return match[0]


_user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
_NOT_COVERING = {"Program Manager", "NVIDIA GeForce Overlay"}  # full-screen but transparent to the eye


def _pid(hwnd) -> int:
    pid = wintypes.DWORD()
    _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _covering(hwnd) -> list[str]:
    """Titles of other apps' windows above `hwnd` in z-order that overlap it: a capture of `hwnd` shows them, and
    clicks there land on them."""
    wins = _windows()
    idx = next((i for i, w in enumerate(wins) if w[0] == hwnd), None)
    if idx is None:
        return []
    l, t, r, b = wins[idx][2]
    pid = _pid(hwnd)
    return [title for h, title, (l2, t2, r2, b2) in wins[:idx]
            if title not in _NOT_COVERING and _pid(h) != pid and l2 < r and r2 > l and t2 < b and b2 > t]


def _foreground(hwnd) -> bool:
    _user32.keybd_event(0x12, 0, 0, 0)  # tap Alt: lets SetForegroundWindow through the foreground lock
    _user32.keybd_event(0x12, 0, 2, 0)
    _user32.SetForegroundWindow(hwnd)
    _pause(0.15)
    return _user32.GetForegroundWindow() == hwnd


_user32.IsZoomed.argtypes = [wintypes.HWND]
_user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
_user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_int, wintypes.UINT]


def _visible_rect(hwnd):
    r = wintypes.RECT()
    _dwm.DwmGetWindowAttribute(hwnd, _DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r))
    return r.left, r.top, r.right, r.bottom
