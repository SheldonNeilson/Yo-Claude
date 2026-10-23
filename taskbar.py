"""Yo Claude's taskbar button: the state as a progress colour and a mascot badge (ITaskbarList3), and window icons.

thinking -> green marquee, needs your OK -> yellow, error -> red; the badge is the mascot in the state's colour.
"""

import ctypes
import logging
import os
import threading
from ctypes import HRESULT, c_int, c_ulonglong, c_void_p, c_wchar_p
from ctypes.wintypes import HWND

import comtypes
import comtypes.client
from comtypes import COMMETHOD, GUID, IUnknown

import icons

log = logging.getLogger("yo_claude")

TBPF_NOPROGRESS, TBPF_INDETERMINATE, TBPF_NORMAL, TBPF_ERROR, TBPF_PAUSED = 0, 1, 2, 4, 8
PROGRESS = {"thinking": TBPF_INDETERMINATE, "using_pc": TBPF_INDETERMINATE, "listening": TBPF_NOPROGRESS,
            "approval": TBPF_PAUSED, "error": TBPF_ERROR}


class ITaskbarList3(IUnknown):
    _iid_ = GUID("{EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF}")
    _methods_ = [
        COMMETHOD([], HRESULT, "HrInit"),
        COMMETHOD([], HRESULT, "AddTab", (["in"], HWND, "hwnd")),
        COMMETHOD([], HRESULT, "DeleteTab", (["in"], HWND, "hwnd")),
        COMMETHOD([], HRESULT, "ActivateTab", (["in"], HWND, "hwnd")),
        COMMETHOD([], HRESULT, "SetActiveAlt", (["in"], HWND, "hwnd")),
        COMMETHOD([], HRESULT, "MarkFullscreenWindow", (["in"], HWND, "hwnd"), (["in"], c_int, "full")),
        COMMETHOD([], HRESULT, "SetProgressValue", (["in"], HWND, "hwnd"), (["in"], c_ulonglong, "done"),
                  (["in"], c_ulonglong, "total")),
        COMMETHOD([], HRESULT, "SetProgressState", (["in"], HWND, "hwnd"), (["in"], c_int, "flags")),
        COMMETHOD([], HRESULT, "RegisterTab", (["in"], HWND, "tab"), (["in"], HWND, "main")),
        COMMETHOD([], HRESULT, "UnregisterTab", (["in"], HWND, "tab")),
        COMMETHOD([], HRESULT, "SetTabOrder", (["in"], HWND, "tab"), (["in"], HWND, "before")),
        COMMETHOD([], HRESULT, "SetTabActive", (["in"], HWND, "tab"), (["in"], HWND, "main"), (["in"], c_int, "r")),
        COMMETHOD([], HRESULT, "ThumbBarAddButtons", (["in"], HWND, "hwnd"), (["in"], c_int, "n"),
                  (["in"], c_void_p, "buttons")),
        COMMETHOD([], HRESULT, "ThumbBarUpdateButtons", (["in"], HWND, "hwnd"), (["in"], c_int, "n"),
                  (["in"], c_void_p, "buttons")),
        COMMETHOD([], HRESULT, "ThumbBarSetImageList", (["in"], HWND, "hwnd"), (["in"], c_void_p, "himl")),
        COMMETHOD([], HRESULT, "SetOverlayIcon", (["in"], HWND, "hwnd"), (["in"], c_void_p, "hicon"),
                  (["in"], c_wchar_p, "description")),
    ]


CLSID_TaskbarList = GUID("{56FDF344-FD6D-11d0-958A-006097C9A090}")


def load_icon(path, size):
    return ctypes.windll.user32.LoadImageW(None, path, 1, size, size, 0x10)   # IMAGE_ICON, LR_LOADFROMFILE


def set_window_icon(hwnd, ico_path):
    """Title bar + Alt-Tab + taskbar icon for a window (WM_SETICON small and big)."""
    small = load_icon(ico_path, ctypes.windll.user32.GetSystemMetrics(49))
    big = load_icon(ico_path, ctypes.windll.user32.GetSystemMetrics(11))
    ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 0, small)
    ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 1, big)


def colorref(hex_rgb):
    r, g, b = (int(hex_rgb[i:i + 2], 16) for i in (1, 3, 5))
    return ctypes.c_uint(r | g << 8 | b << 16)


def style_title_bar(hwnd, caption="#181816", text="#d97757", border="#4a3e36"):
    """Windows 11: title bar in the app's own colours (dark mode for the buttons, then caption/text/border)."""
    dwm = ctypes.windll.dwmapi
    dark = ctypes.c_int(1)
    dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(dark), 4)          # DWMWA_USE_IMMERSIVE_DARK_MODE
    for attr, color in ((35, caption), (36, text), (34, border)):       # CAPTION_COLOR, TEXT_COLOR, BORDER_COLOR
        c = colorref(color)
        dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(c), 4)


class Taskbar:
    """Runs its COM calls on one thread of its own (COM objects are tied to the thread that made them)."""

    def __init__(self, hwnd):
        self.hwnd = hwnd
        self.overlays = {}
        self.pending = None
        self.wake = threading.Event()
        threading.Thread(target=self.loop, daemon=True, name="taskbar").start()

    def show(self, state):
        self.pending = state
        self.wake.set()

    def overlay_icon(self, state):
        if state not in self.overlays:
            path = os.path.join(icons.DATA_DIR, f"overlay-{state}.ico")
            img = icons.draw(32, icons.STATE_COLORS.get(state, icons.ORANGE), background=(20, 20, 19, 255))
            img.save(path, sizes=[(16, 16), (32, 32)])
            self.overlays[state] = load_icon(path, 16)
        return self.overlays[state]

    def loop(self):
        comtypes.CoInitialize()
        try:
            tb = comtypes.client.CreateObject(CLSID_TaskbarList, interface=ITaskbarList3)
            tb.HrInit()
        except Exception as e:
            log.warning("Taskbar progress/badges unavailable: %s", e)
            return
        shown = None
        while True:
            self.wake.wait()
            self.wake.clear()
            state = self.pending
            if state == shown:
                continue
            shown = state
            try:
                flags = PROGRESS.get(state, TBPF_NOPROGRESS)
                tb.SetProgressState(self.hwnd, flags)
                if flags in (TBPF_PAUSED, TBPF_ERROR):
                    tb.SetProgressValue(self.hwnd, 100, 100)
                quiet = state in ("idle", "starting", None)
                tb.SetOverlayIcon(self.hwnd, None if quiet else self.overlay_icon(state), state or "")
            except Exception as e:
                log.debug("taskbar update failed: %s", e)
