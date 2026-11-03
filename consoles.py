"""Console windows of programs Claude runs (a Unity batch build, a compiler, a script) pop up on screen and take the keyboard
from whatever you were typing in. This hides them as they appear: any console window whose process was started, through
however many steps, by a claude.exe that Yo Claude runs. Your own terminals (and the one Yo Claude opens for you) aren't
started by Claude, so they are left alone. It listens for windows being shown (a WinEvent hook), so it acts at once.
(Windows only.)"""
import ctypes
import logging
import os
import threading
import time
from ctypes import wintypes

log = logging.getLogger("yo_claude")

EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_SHOW = 0x0003, 0x8002
WINEVENT_OUTOFCONTEXT, OBJID_WINDOW = 0x0000, 0
CONSOLE_CLASSES = {"ConsoleWindowClass"}
typing_at = 0        # when you last typed in the message box (app.Api.typing), 0 = not typing
TYPING_S = 1.5       # a window that appears and takes the foreground this soon after a key in the box gives it back
NEW_WINDOW_S = 2.0   # ...if it appeared (was shown) this recently: a popup, not a window you switched to


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


def processes():
    """pid -> (parent pid, exe name) for every process now."""
    k = ctypes.windll.kernel32
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k.CreateToolhelp32Snapshot(0x2, 0)   # TH32CS_SNAPPROCESS
    out = {}
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            out[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile.lower())
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return out


def started_by_claude(pid, me=None):
    """True when `pid` descends from a claude.exe that descends from this process (Yo Claude)."""
    me = me or os.getpid()
    procs = processes()
    seen, claude = set(), False
    while pid and pid not in seen:
        seen.add(pid)
        if pid == me:
            return claude
        parent, exe = procs.get(pid, (0, ""))
        if exe == "claude.exe":
            claude = True
        pid = parent
    return False


def start():
    if os.name != "nt":
        return
    threading.Thread(target=_run, name="hide-consoles", daemon=True).start()


def _run():
    u = ctypes.windll.user32
    proc_t = ctypes.WINFUNCTYPE(None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND, wintypes.LONG, wintypes.LONG,
                                wintypes.DWORD, wintypes.DWORD)
    me = os.getpid()
    checked = {}   # hwnd -> verdict (a window is checked once)
    shown = {}     # hwnd -> when it was shown
    last_mine = [None]   # this app's window that last had the foreground

    def pid_of(hwnd):
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def give_back(thief):
        """A window popped up while you typed in Yo Claude: put Yo Claude back in front (the keys you type next go there)."""
        ours = last_mine[0]
        if not ours or not u.IsWindow(ours):
            return
        k = ctypes.windll.kernel32
        fg_thread = u.GetWindowThreadProcessId(thief, None)
        me_thread = k.GetCurrentThreadId()
        attached = fg_thread and fg_thread != me_thread and u.AttachThreadInput(me_thread, fg_thread, True)
        try:
            u.SetForegroundWindow(ours)
        finally:
            if attached:
                u.AttachThreadInput(me_thread, fg_thread, False)
        title = ctypes.create_unicode_buffer(120)
        u.GetWindowTextW(thief, title, 120)
        log.info("A window popped up while you typed and took the keyboard: gave it back to Yo Claude (%s)", title.value[:80])

    def on_event(hook, event, hwnd, obj, child, thread, ms):
        try:
            if obj != OBJID_WINDOW or not hwnd:
                return
            if event == EVENT_OBJECT_SHOW and not u.GetParent(hwnd):
                shown[hwnd] = time.time()
                if len(shown) > 2000:
                    shown.clear()
            if event == EVENT_SYSTEM_FOREGROUND:
                if pid_of(hwnd) == me:
                    last_mine[0] = hwnd
                elif typing_at and time.time() - typing_at < TYPING_S and time.time() - shown.get(hwnd, 0) < NEW_WINDOW_S:
                    give_back(hwnd)
            cls = ctypes.create_unicode_buffer(64)
            u.GetClassNameW(hwnd, cls, 64)
            if cls.value not in CONSOLE_CLASSES or not u.IsWindowVisible(hwnd):
                return
            if hwnd not in checked:
                pid = wintypes.DWORD()
                u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                checked[hwnd] = started_by_claude(pid.value, me)
                if len(checked) > 500:
                    checked.clear()
                if checked[hwnd]:
                    title = ctypes.create_unicode_buffer(120)
                    u.GetWindowTextW(hwnd, title, 120)
                    log.info("Hid a console window Claude's command opened (it would take the keyboard): %s", title.value[:100])
            if checked[hwnd]:
                u.ShowWindow(hwnd, 0)   # SW_HIDE: the next window (yours) gets the keyboard back
        except Exception as e:
            log.debug("console hiding: %s", e)

    cb = proc_t(on_event)
    hooks = [u.SetWinEventHook(ev, ev, None, cb, 0, 0, WINEVENT_OUTOFCONTEXT) for ev in (EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND)]
    if not all(hooks):
        log.warning("Couldn't watch for console windows: they may take the keyboard")
        return
    msg = wintypes.MSG()
    while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:   # (the hook calls come in through this thread's message loop)
        u.TranslateMessage(ctypes.byref(msg))
        u.DispatchMessageW(ctypes.byref(msg))
