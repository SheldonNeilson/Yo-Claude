"""Stop hotkey, kill-switch file, read-only mode and held-input bookkeeping.

The flags here are reassigned at run time (the hotkey thread flips _stopped), so other modules must read them as
safety._stopped, never via `from .safety import _stopped`, which would copy the value once at import."""
import ctypes
import json
import os
import threading
import time
from ctypes import wintypes

import pyautogui

from .app import HERE, _log, _user32

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0  # waits are explicit (see _pause) so multi-step strokes are not slowed

READONLY = os.environ.get("SCREEN_CONTROL_READONLY") == "1"
SPEED = max(0.1, float(os.environ.get("SCREEN_CONTROL_SPEED", "1.0")))  # <1 slower, >1 faster
STOP_KEY = os.environ.get("SCREEN_CONTROL_STOP_KEY", "ctrl+alt+x").lower()
KILL_FILE = os.environ.get("SCREEN_CONTROL_KILL_FILE", os.path.join(HERE, "DISABLED"))

_stopped = False
_held_buttons: set[str] = set()
_held_keys: set[str] = set()
_stop_key_status = "not registered"

_VK_NAMES = {"pause": 0x13, "break": 0x13, "esc": 0x1B, "escape": 0x1B, "space": 0x20, "home": 0x24, "end": 0x23,
             "insert": 0x2D, "delete": 0x2E, "pageup": 0x21, "pagedown": 0x22}


def _parse_hotkey(spec: str):
    mods, vk = 0, None
    for p in (x.strip() for x in spec.split("+")):
        if p in ("ctrl", "control"):
            mods |= 0x0002
        elif p == "alt":
            mods |= 0x0001
        elif p == "shift":
            mods |= 0x0004
        elif p in ("win", "windows"):
            mods |= 0x0008
        elif len(p) == 1 and p.isalnum():
            vk = ord(p.upper())
        elif p in _VK_NAMES:
            vk = _VK_NAMES[p]
        elif p.startswith("f") and p[1:].isdigit() and 1 <= int(p[1:]) <= 24:
            vk = 0x70 + int(p[1:]) - 1
        else:
            raise ValueError(f"unsupported stop key part {p!r}")
    if vk is None:
        raise ValueError("stop key needs a non-modifier key")
    return mods, vk


def _release_all():
    for b in list(_held_buttons):
        try:
            pyautogui.mouseUp(button=b)
        except Exception:
            pass
    for k in list(_held_keys):
        try:
            pyautogui.keyUp(k)
        except Exception:
            pass
    _held_buttons.clear()
    _held_keys.clear()


def _hotkey_loop():
    global _stopped, _stop_key_status
    try:
        mods, vk = _parse_hotkey(STOP_KEY)
        if not _user32.RegisterHotKey(None, 1, mods | 0x4000, vk):  # MOD_NOREPEAT
            _stop_key_status = f"{STOP_KEY}: registration failed (key in use?)"
            return
    except ValueError as e:
        _stop_key_status = f"{STOP_KEY}: {e}"
        return
    _stop_key_status = f"{STOP_KEY} toggles stop/resume"
    msg = wintypes.MSG()
    while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        if msg.message == 0x0312:  # WM_HOTKEY
            _stopped = not _stopped
            if _stopped:
                _release_all()
            _log.info(json.dumps({"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "tool": "STOP_HOTKEY",
                                  "result": "stopped" if _stopped else "resumed"}))


def start_hotkey():
    """Register the stop hotkey on its own thread. Called by the server entry point only, so importing these
    modules (tests, scratch scripts) does not grab the user's hotkey."""
    threading.Thread(target=_hotkey_loop, name="stop-hotkey", daemon=True).start()


def _kill_switch() -> str | None:
    """None if the kill-switch file is absent; otherwise its first line, lower-cased ('all' = also block screenshots)."""
    try:
        with open(KILL_FILE, encoding="utf-8", errors="replace") as f:
            return f.readline().strip().lower()
    except FileNotFoundError:
        return None
    except OSError:
        return ""  # exists but unreadable: treat as disabled


def _guard_read():
    """Screenshots and window listing: blocked only when the kill-switch file says 'all'."""
    if _kill_switch() == "all":
        raise RuntimeError(f"screen-control is disabled by the kill-switch file ({KILL_FILE}, mode 'all'); "
                           "the user must delete it to re-enable")


def _guard():
    if _kill_switch() is not None:
        _release_all()
        raise RuntimeError(f"screen-control is disabled by the kill-switch file ({KILL_FILE}); the user must "
                           "delete it to re-enable")
    if READONLY:
        raise RuntimeError("screen-control is in read-only mode (SCREEN_CONTROL_READONLY=1)")
    if _stopped:
        raise RuntimeError(f"input stopped by the user's stop hotkey ({STOP_KEY}); the user must press it again "
                           "to resume")


def _pause(seconds: float):
    time.sleep(seconds / SPEED)
