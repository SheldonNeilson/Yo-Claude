"""The FastMCP instance, Win32 handles shared by every module, and the per-call log."""
import ctypes
import functools
import inspect
import json
import logging
import logging.handlers
import os
import time
from ctypes import wintypes

from mcp.server.fastmcp import FastMCP

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # real pixels, not DPI-virtualised
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the tool folder, next to server.py
LOG_PATH = os.environ.get("SCREEN_CONTROL_LOG", os.path.join(HERE, "screen-control.log"))
LOG_TEXT = os.environ.get("SCREEN_CONTROL_LOG_TEXT") == "1"

mcp = FastMCP("screen-control")

_user32 = ctypes.windll.user32
_dwm = ctypes.windll.dwmapi
_user32.GetForegroundWindow.restype = wintypes.HWND
_user32.IsWindowVisible.argtypes = [wintypes.HWND]
_user32.IsIconic.argtypes = [wintypes.HWND]
_user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
_user32.SetForegroundWindow.argtypes = [wintypes.HWND]
_user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
_user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

# --------------------------------------------------------------------------------------- logging

_log = logging.getLogger("screen-control")
_log.setLevel(logging.INFO)
try:
    _h = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    _h.setFormatter(logging.Formatter("%(message)s"))
    _log.addHandler(_h)
except OSError:
    _log.addHandler(logging.NullHandler())


def _fg_title() -> str:
    hwnd = _user32.GetForegroundWindow()
    if not hwnd:
        return ""
    n = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    _user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _logged(fn):
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*a, **k):
        try:
            args = dict(sig.bind(*a, **k).arguments)
        except TypeError:
            args = dict(k)
        if fn.__name__ in ("type_text", "clipboard") and not LOG_TEXT and args.get("text") is not None:
            args["text"] = f"<{len(args.get('text') or '')} chars>"
        if fn.__name__ == "ui_act" and not LOG_TEXT and args.get("value") is not None:
            args["value"] = f"<{len(args['value'])} chars>"
        if fn.__name__ == "macro" and not LOG_TEXT and args.get("params"):
            args["params"] = {k: f"<{len(str(v))} chars>" for k, v in args["params"].items()}
        if fn.__name__ in ("batch", "macro") and not LOG_TEXT and args.get("actions"):
            args["actions"] = [{k: f"<{len(str(v))} chars>" if k in ("text", "value") and v is not None else v
                                for k, v in a.items()} if isinstance(a, dict) else a for a in args["actions"]]
        entry = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "tool": fn.__name__, "args": args, "fg": _fg_title()}
        try:
            result = fn(*a, **k)
        except Exception as e:
            entry["error"] = f"{type(e).__name__}: {e}"
            _log.info(json.dumps(entry, default=str, ensure_ascii=False))
            raise
        texts = result if isinstance(result, list) else [result]
        text = " | ".join(t for t in texts if isinstance(t, str))
        if fn.__name__ in ("clipboard", "ui_text", "ui_table") and not LOG_TEXT:  # may hold the user's data
            text = text.split(":", 1)[0]
        if fn.__name__ in ("batch", "macro") and not LOG_TEXT:  # step output may be such data too; keep failures
            head, _, rest = text.partition(" | ")
            at = rest.rfind(" FAILED: ")
            failed = rest[rest.rfind("; ", 0, at) + 2 if "; " in rest[:at] else 0:] if at >= 0 else ""
            text = head + (f" | {failed}" if failed else "")
        entry["result"] = text[:300]
        _log.info(json.dumps(entry, default=str, ensure_ascii=False))
        return result

    return wrapper
