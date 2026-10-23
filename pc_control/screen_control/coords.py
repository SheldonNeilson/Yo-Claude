"""Monitors and the mapping between screenshot coordinates and real screen pixels.

_active_monitor is reassigned by screenshot(monitor=N): read it as coords._active_monitor."""
import os
import time

import mss

MAX_WIDTH = int(os.environ.get("SCREEN_CONTROL_MAX_WIDTH", "1280"))

_MSS = getattr(mss, "MSS", None) or mss.mss  # mss.mss is deprecated in newer releases

_active_monitor = 1
_monitor_cache: tuple[float, list] = (0.0, [])


def _monitors():
    """Monitor rectangles, cached for a couple of seconds: every coordinate conversion needs them, and opening an
    mss handle per point made a 500-point path open 500 handles."""
    global _monitor_cache
    t, mons = _monitor_cache
    if not mons or time.monotonic() - t > 2.0:
        with _MSS() as sct:
            mons = [dict(m) for m in sct.monitors[1:]]  # index 0 of mss is the combined desktop
        _monitor_cache = (time.monotonic(), mons)
    return mons


def _mon():
    mons = _monitors()
    return mons[min(_active_monitor, len(mons)) - 1]


def _scale(mon=None):
    mon = mon or _mon()
    return min(1.0, MAX_WIDTH / mon["width"])


def _to_screen(x: int, y: int):
    mon = _mon()
    s = _scale(mon)
    return (mon["left"] + max(0, min(mon["width"] - 1, round(x / s))),
            mon["top"] + max(0, min(mon["height"] - 1, round(y / s))))


def _from_screen(sx: int, sy: int):
    mon = _mon()
    s = _scale(mon)
    return round((sx - mon["left"]) * s), round((sy - mon["top"]) * s)
