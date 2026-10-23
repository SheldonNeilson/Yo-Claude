"""Yo Claude - a voice-first Claude assistant for Windows, for coding and everything else.

    pythonw app.py            # normal (what the shortcut and launch-with-Windows run)
    python app.py --debug     # with a console; also logs what the wake engine hears and saves samples
    python app.py --collect   # never reply: beep on a wake, save every sample

Two windows (an expanded app and a compact bar, both HTML in WebView2 via pywebview), a tray icon, the voice engine
(yo_claude.py) and Claude sessions on the Agent SDK (sessions.py), all talking over one event queue.
"""

import argparse
import ctypes
import json
import logging
import os
import queue
import sys
import threading
import time
import winreg

import pystray
import webview

import icons
import yo_claude
from sessions import Router

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
DATA_DIR = yo_claude.DATA_DIR
LOG_PATH = os.path.join(DATA_DIR, "yo_claude.log")
APP_ID = "YoClaude.App"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
log = logging.getLogger("yo_claude")


def launch_command():
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return f'"{pythonw}" "{os.path.join(HERE, "app.py")}"'


def set_launch_at_login(on):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, "YoClaude", 0, winreg.REG_SZ, launch_command())
        else:
            try:
                winreg.DeleteValue(k, "YoClaude")
            except FileNotFoundError:
                pass


def display_state(voice, work):
    """One state for the bar, tray and taskbar from the voice engine's state and the sessions' work."""
    if work == "awaiting_approval":
        return "approval"
    if work == "using_pc":
        return "using_pc"
    if voice in ("listening", "speaking"):
        return voice
    if work == "thinking" or voice == "thinking":
        return "thinking"
    return voice or "starting"


class App:
    def __init__(self, args):
        self.args = args
        self.settings = yo_claude.Settings()
        self.bus = queue.Queue()
        self.commands = queue.Queue()
        self.router = Router(self.settings, lambda kind, data: self.bus.put((kind, data)))
        self.voice_state, self.voice_text, self.voice_hold = "starting", "", 0.0
        self.work_state = "idle"
        self.display = "starting"
        self.ready = {}            # window -> loaded
        self.tick = 0
        folder = self.settings.get("folder")
        self.router.set_folder(folder if folder and os.path.isdir(folder) else None)
        self.api = Api(self)
        scale = ctypes.windll.user32.GetDpiForSystem() / 96
        left, top, right, bottom = (v / scale for v in self.work_area())
        width, height = int((right - left) * 0.82), int((bottom - top) * 0.86)
        self.main = webview.create_window(
            "Yo Claude", os.path.join(UI, "index.html"), js_api=self.api, width=width, height=height, min_size=(760, 480),
            background_color="#111110", hidden=not self.settings.get("show_window", True))
        self.bar = webview.create_window(
            "Yo Claude bar", os.path.join(UI, "bar.html"), js_api=self.api, width=560, height=56, frameless=True,
            on_top=True, focus=False, background_color="#111110", hidden=True, shadow=False)
        for w in (self.main, self.bar):
            w.events.loaded += lambda w=w: self.ready.__setitem__(w, True)
        self.main.events.closing += self.on_main_closing
        self.bar.events.moved += self.on_bar_moved
        self.tray = None

    # --- startup (pywebview calls this on its own thread once the GUI loop runs) ---
    def started(self):
        self.style_bar()
        self.place_bar(56)
        self.tray = self.make_tray()
        threading.Timer(4, icons.promote_tray_icon, args=(self.settings,)).start()
        threading.Thread(target=self.voice, daemon=True, name="voice").start()
        threading.Thread(target=self.dispatch, daemon=True, name="dispatch").start()
        threading.Thread(target=self.animate, daemon=True, name="tray").start()
        if self.settings.get("launch_at_login", True):
            set_launch_at_login(True)
        self.update_bar_visibility()

    def voice(self):
        try:
            yo_claude.Assistant(self.settings, lambda kind, **d: self.bus.put((kind, d)), self.commands, self.router,
                                save_samples=self.args.debug, collect=self.args.collect).run()
        except Exception:
            log.exception("Voice engine failed to start")
            self.bus.put(("state", {"state": "error", "text": "Voice failed to start. See the log."}))

    # --- the event bus -> windows / tray ---
    def dispatch(self):
        while True:
            events = []
            try:
                events.append(self.bus.get(timeout=0.5))
                deadline = time.time() + 0.06
                while time.time() < deadline:
                    try:
                        events.append(self.bus.get(timeout=max(0, deadline - time.time())))
                    except queue.Empty:
                        break
            except queue.Empty:
                pass
            main_events, bar_events, levels = [], [], []
            for kind, d in events:
                if kind == "level":
                    levels.append(round(d["level"], 1))
                    continue
                if kind == "state":
                    self.voice_state, self.voice_text = d["state"], d.get("text", "")
                    self.voice_hold = d.get("hold", 0.0)
                elif kind == "work":
                    self.work_state = d["state"]
                main_events.append({"kind": kind, **d})
            new_display = display_state(self.voice_state, self.work_state)
            if new_display != self.display or any(e["kind"] in ("state", "work") for e in main_events):
                self.display = new_display
                ev = {"kind": "display", "state": self.display, "voice": self.voice_state, "work": self.work_state,
                      "text": self.voice_text, "hold": self.voice_hold}
                main_events.append(ev)
                bar_events.append(ev)
                self.update_tray()
                self.update_bar_visibility()
            if levels:
                bar_events.append({"kind": "levels", "levels": levels})
                main_events.append({"kind": "levels", "levels": levels[-3:]})
            self.push(self.main, main_events)
            self.push(self.bar, bar_events)

    def push(self, window, events):
        if events and self.ready.get(window):
            try:
                window.evaluate_js(f"window.app && app.events({json.dumps(events, default=str)})")
            except Exception as e:
                log.debug("push failed: %s", e)

    def emit_settings(self):
        self.bus.put(("settings", {"settings": dict(self.settings)}))

    # --- windows ---
    def on_main_closing(self):
        if getattr(self, "quitting", False):
            return True
        self.main.hide()        # closing the window keeps Yo Claude running in the tray
        self.settings["show_window"] = False
        self.settings.save()
        return False

    def show_main(self):
        self.main.show()
        self.main.restore()
        self.settings["show_window"] = True
        self.settings.save()

    def style_bar(self):
        """The bar mustn't steal focus from the window you're working in, and stays off the taskbar."""
        try:
            hwnd = self.bar.native.Handle.ToInt32()
            ex = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
            ctypes.windll.user32.SetWindowLongW(hwnd, -20, ex | 0x08000000 | 0x80)
        except Exception as e:
            log.warning("Couldn't style the bar: %s", e)

    def work_area(self):
        class RECT(ctypes.Structure):
            _fields_ = [(n, ctypes.c_long) for n in ("left", "top", "right", "bottom")]
        r = RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(r), 0)
        return r.left, r.top, r.right, r.bottom

    def place_bar(self, height):
        """Keep the bar's bottom edge where it was (default: bottom centre, just above the taskbar)."""
        scale = ctypes.windll.user32.GetDpiForSystem() / 96
        left, top, right, bottom = (v / scale for v in self.work_area())
        pos = self.settings.get("bar_anchor")
        width = 560
        x, b = pos if pos else ((left + right - width) / 2, bottom - 14)
        self.placing = True
        self.bar.resize(width, int(height))
        self.bar.move(int(x), int(b - height))
        self.bar_height = height
        self.placing = False

    def on_bar_moved(self, x, y):
        if getattr(self, "placing", False):
            return
        self.settings["bar_anchor"] = [x, y + getattr(self, "bar_height", 56)]
        self.settings.save()

    def bar_wanted(self):
        if not self.settings.get("show_bar", True):
            return False
        busy = self.display not in ("idle", "paused")
        held = self.voice_text and self.voice_hold and self.voice_state in ("idle", "paused")
        return self.settings.get("bar_when_idle", True) or busy or bool(held)

    def update_bar_visibility(self):
        want = self.bar_wanted()
        if want != getattr(self, "bar_shown", None):
            self.bar_shown = want
            (self.bar.show if want else self.bar.hide)()
            if want:
                self.style_bar()

    # --- tray ---
    def make_tray(self):
        s = self.settings

        def toggle(key, after=None):
            def action(icon, item):
                s[key] = not s.get(key, True)
                s.save()
                if after:
                    after(s[key])
                self.commands.put("settings")
                self.emit_settings()
                self.update_bar_visibility()
            return action

        def checked(key):
            return lambda item: bool(s.get(key, True))

        menu = pystray.Menu(
            pystray.MenuItem("Open Yo Claude", lambda: self.show_main(), default=True),
            pystray.MenuItem("Talk now", lambda: self.commands.put("talk")),
            pystray.MenuItem("Stop", lambda: self.api.stop()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Listen for “Yo Claude”", toggle("listening"), checked=checked("listening")),
            pystray.MenuItem("Voice replies", toggle("voice_replies"), checked=checked("voice_replies")),
            pystray.MenuItem("PC control (screen, keyboard, mouse)", toggle("pc_control", lambda on: self.router.reconnect_all()),
                             checked=checked("pc_control")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Compact bar", toggle("show_bar"), checked=checked("show_bar")),
            pystray.MenuItem("Keep bar visible when idle", toggle("bar_when_idle"), checked=checked("bar_when_idle")),
            pystray.MenuItem("Launch with Windows", toggle("launch_at_login", set_launch_at_login),
                             checked=checked("launch_at_login")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open log", lambda: os.startfile(LOG_PATH)),
            pystray.MenuItem("Quit", lambda: self.quit()),
        )
        icon = pystray.Icon("YoClaude", icons.tray_frame("starting", 0), "Yo Claude – starting", menu)
        icon.run_detached()
        return icon

    def update_tray(self):
        if self.tray:
            self.tray.icon = icons.tray_frame(self.display, self.tick)
            self.tray.title = f"Yo Claude – {self.display.replace('_', ' ')}"

    def animate(self):
        while True:
            time.sleep(0.2)
            self.tick += 1
            if icons.animated(self.display) or self.tick % 20 in (0, 1):
                self.update_tray()

    def quit(self):
        self.quitting = True
        self.commands.put("quit")
        for s in list(self.router.live.values()):
            try:
                self.router.run(s.disconnect()).result(5)
            except Exception:
                pass
        if self.tray:
            self.tray.stop()
        for w in (self.bar, self.main):
            try:
                w.destroy()
            except Exception:
                pass


class Api:
    """Called from the pages' JavaScript (window.pywebview.api.*)."""

    def __init__(self, app):
        self._app = app

    # --- state ---
    def init(self):
        a = self._app
        r = a.router
        active = r.active
        return {"settings": dict(a.settings), "folder": r.folder, "folders": r.meta.data["recent_folders"],
                "groups": r.meta.data["groups"], "sessions": r.list(r.folder),
                "active": r.describe(active) if active else None, "items": active.items if active else [],
                "display": {"state": a.display, "voice": a.voice_state, "work": a.work_state, "text": a.voice_text}}

    def set_setting(self, key, value):
        a = self._app
        a.settings[key] = value
        a.settings.save()
        if key == "launch_at_login":
            set_launch_at_login(bool(value))
        if key == "pc_control":
            a.router.reconnect_all()
        a.commands.put("settings")
        a.update_bar_visibility()
        a.emit_settings()

    # --- folders ---
    def pick_folder(self):
        result = self._app.main.create_file_dialog(webview.FOLDER_DIALOG)
        if result:
            self.set_folder(result[0])
            return result[0]
        return None

    def set_folder(self, folder):
        a = self._app
        a.router.set_folder(folder)
        a.settings["folder"] = folder
        a.settings.save()
        a.bus.put(("folder", {"folder": a.router.folder, "folders": a.router.meta.data["recent_folders"]}))

    # --- sessions ---
    def new_session(self):
        r = self._app.router
        return r.describe(r.new_session(picked=True))

    def open_url(self, url):
        if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
            import webbrowser
            webbrowser.open(url)

    def open_session(self, sid, cwd):
        self._app.router.open(sid, cwd)

    def list_sessions(self, cwd):
        return self._app.router.list(cwd)

    def send(self, text):
        if text and text.strip():
            self._app.router.send(text.strip())

    def stop(self):
        self._app.commands.put("stop")
        self._app.router.interrupt()

    def approve(self, sid, aid, allow, always=False):
        self._app.router.approve(sid, aid, bool(allow), bool(always))

    def set_permission_mode(self, sid, mode):
        self._app.router.set_permission_mode(sid, mode)

    def set_model(self, sid, model):
        self._app.router.set_model(sid, model)

    def set_effort(self, sid, effort):
        self._app.router.set_effort(sid, effort)

    def rename(self, sid, cwd, title):
        self._app.router.rename(sid, cwd, title)

    def pin(self, sid, cwd, pinned):
        self._app.router.pin(sid, cwd, pinned)

    def set_group(self, sid, cwd, group):
        self._app.router.group(sid, cwd, group)

    def delete(self, sid, cwd):
        return self._app.router.delete(sid, cwd)

    def trash(self):
        return self._app.router.trash()

    def restore(self, sid):
        return self._app.router.restore(sid)

    def fork(self, sid, cwd):
        new_id, error = self._app.router.fork(sid, cwd)
        if new_id:
            self._app.router.open(new_id, cwd)
        return error

    # --- voice / windows ---
    def talk(self):
        self._app.commands.put("talk")

    def open_main(self):
        self._app.show_main()

    def bar_minimise(self):
        self.set_setting("bar_when_idle", False)
        a = self._app
        a.bar_shown = False
        a.bar.hide()

    def bar_resize(self, height):
        self._app.place_bar(max(56, min(220, int(height))))

    def compact(self):
        """Expanded -> compact: hide the window, show the bar."""
        a = self._app
        a.settings["show_bar"] = True
        a.main.hide()
        a.settings["show_window"] = False
        a.settings.save()
        a.bar_shown = None
        a.update_bar_visibility()

    def open_log(self):
        os.startfile(LOG_PATH)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", action="store_true", help="log everything the wake engine hears, save samples")
    ap.add_argument("--collect", action="store_true", help="never reply: beep on a wake, save every sample")
    args = ap.parse_args()
    args.debug = args.debug or args.collect

    os.makedirs(DATA_DIR, exist_ok=True)
    handlers = [logging.FileHandler(LOG_PATH, encoding="utf-8")]
    if sys.stdout:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(message)s", handlers=handlers)
    log.setLevel(logging.DEBUG if args.debug else logging.INFO)

    import win32api, win32event, winerror
    mutex = win32event.CreateMutex(None, False, "Local\\YoClaude")
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        log.info("Already running.")
        return

    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)   # own taskbar button, not Python's
    app = App(args)
    webview.start(app.started, private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"),
                  icon=icons.make_ico())
    del mutex


if __name__ == "__main__":
    main()
