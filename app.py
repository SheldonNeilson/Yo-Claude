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
import subprocess
import sys
import threading
import time
import winreg

import pystray
import webview

import icons
import media
import openwith
import taskbar
import workspace
import yo_claude
from sessions import Router, same_folder

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
DATA_DIR = yo_claude.DATA_DIR
LOG_PATH = os.path.join(DATA_DIR, "yo_claude.log")
APP_ID = "YoClaude.App"
UPDATE_CHECK_S = 6 * 3600
try:
    with open(os.path.join(HERE, "VERSION"), encoding="utf-8") as _f:
        VERSION = _f.read().strip()
except OSError:
    VERSION = "dev"
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
    if work == "background" and voice in ("idle", "paused", None):
        return "background"
    return voice or "starting"


# what the floating bar also gets, for its face and its feed of what's happening (besides the display state and levels)
BAR_FEED = {"item", "delta", "opened", "settings", "speech", "mood"}


class App:
    def __init__(self, args):
        self.args = args
        self.settings = yo_claude.Settings()
        self.bus = queue.Queue()
        self.commands = queue.Queue()
        self.router = Router(self.settings, lambda kind, data: self.bus.put((kind, data)))
        self.media = media.MediaServer()
        self.voice_state, self.voice_text, self.voice_hold = "starting", "", 0.0
        self.work_state = "idle"
        self.display = "starting"
        self.ready = {}            # window -> loaded
        self.tick = 0
        self.taskbar = None
        if not self.settings.get("character"):   # once: who had her face on keeps her (Claudia); new installs get Claude
            self.settings["character"] = "female" if self.settings.get("avatar") is True else "male"
            self.settings.save()
        if not self.settings.get("face_off_v1"):   # once: the face is now off unless turned on; keep it for who had it
            if self.settings.get("avatar", True) and "avatar" in self.settings:
                self.settings.setdefault("bar_avatar", True)
                self.settings["avatar"] = True
            self.settings["face_off_v1"] = True
            self.settings.save()
        if not self.settings.get("face_max_v1"):   # once: the sidebar at its widest, so her face shows at its biggest
            self.settings.update(side_width=560, face_max_v1=True)
            self.settings.save()
        folder = self.settings.get("folder")
        self.router.set_folder(folder if folder and os.path.isdir(folder) else None)
        self.api = Api(self)
        scale = ctypes.windll.user32.GetDpiForSystem() / 96
        left, top, right, bottom = (v / scale for v in self.work_area())
        width, height = int((right - left) * 0.82), int((bottom - top) * 0.86)
        x, y = int(left + (right - left - width) / 2), int(top + (bottom - top - height) / 2)
        self.main = webview.create_window(
            self.name(), os.path.join(UI, "index.html"), js_api=self.api, width=width, height=height, x=x, y=y,
            min_size=(760, 480), maximized=self.settings.get("start_maximized", True),   # (View > Start Maximized)
            background_color="#111110", hidden=not self.settings.get("show_window", True))
        self.bar = webview.create_window(
            "Yo Claude bar", os.path.join(UI, "bar.html"), js_api=self.api, width=560, height=56, min_size=(300, 40),
            frameless=True,
            on_top=True, focus=False, background_color="#111110", hidden=True, shadow=False)
        for w in (self.main, self.bar):
            w.events.loaded += lambda w=w: self.ready.__setitem__(w, True)
        self.main.events.loaded += self.on_main_loaded
        self.main_visible = self.settings.get("show_window", True)
        self.main.events.shown += self.dress_main     # title-bar colours only stick once the window is on screen
        self.main.events.closing += self.on_main_closing
        self.main.events.minimized += lambda: self.set_main_visible(False)
        self.main.events.restored += lambda: self.set_main_visible(True)
        self.main.events.maximized += lambda: self.set_main_visible(True)
        self.bar.events.moved += self.on_bar_moved
        self.tray = None

    # --- startup (pywebview calls this on its own thread once the GUI loop runs) ---
    def started(self):
        self.bar_height = 56
        self.dress_main()
        threading.Thread(target=self.ensure_shortcuts, daemon=True).start()
        self.tray = self.make_tray()
        threading.Timer(4, icons.promote_tray_icon, args=(self.settings,)).start()
        threading.Thread(target=self.voice, daemon=True, name="voice").start()
        threading.Thread(target=self.dispatch, daemon=True, name="dispatch").start()
        threading.Thread(target=self.animate, daemon=True, name="tray").start()
        threading.Thread(target=self.live_view, daemon=True, name="live").start()
        if self.settings.get("launch_at_login", True):
            set_launch_at_login(True)
        self.update_bar_visibility()
        threading.Thread(target=self.update_loop, daemon=True, name="updates").start()

    def update_loop(self):
        while True:
            try:
                self.check_updates(quiet=True)
            except Exception as e:
                log.debug("update check: %s", e)
            time.sleep(UPDATE_CHECK_S)

    def live_view(self):
        """While Claude is using the PC, a small picture of the screen about once a second for the transcript."""
        from PIL import ImageGrab
        import base64
        import io
        while True:
            time.sleep(1.0)
            users = [sid for sid, st in list(self.router.work.items()) if st == "using_pc"]
            if not users or not self.main_visible:
                continue
            try:
                img = ImageGrab.grab()
                img.thumbnail((420, 420))
                buf = io.BytesIO()
                img.convert("RGB").save(buf, "JPEG", quality=60)
                url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
            except Exception as e:
                log.debug("live view failed: %s", e)
                continue
            for sid in users:
                self.bus.put(("live", {"session": sid, "image": url}))

    def on_main_loaded(self):
        self.enable_text_menus()
        if not self.settings.get("onboarded"):   # first run: the welcome + training walkthrough
            self.settings["onboarded"] = True
            self.settings.save()
            self.bus.put(("open_training", {}))

    def enable_text_menus(self):
        """pywebview turns WebView2's own right-click menu off outside debug mode, which also hides the spelling
        suggestions under a red squiggle. Turn it back on; the page (menus.js) cancels it everywhere except text
        fields, where it gives spelling suggestions plus cut/copy/paste."""
        try:
            from System import Func, Type   # pythonnet, loaded by pywebview's WinForms backend
            form = self.main.native

            def apply():
                form.browser.webview.CoreWebView2.Settings.AreDefaultContextMenusEnabled = True

            form.Invoke(Func[Type](apply))   # WebView2 settings may only be touched on the UI thread
        except Exception as e:
            log.warning("couldn't enable the text-field menu (spelling suggestions): %s", e)

    # --- updates (installs are git clones of the repo) ---
    def git(self, *args):
        return subprocess.run(["git", "-C", HERE, *args], capture_output=True, text=True,
                              creationflags=subprocess.CREATE_NO_WINDOW)

    def check_updates(self, quiet=False):
        """Fetch; if GitHub has a newer version, say so (quiet: tray notice + badge in the window) or install it and
        restart (from the menus)."""
        if not os.path.isdir(os.path.join(HERE, ".git")):
            if not quiet:
                self.notify("This copy wasn't installed with git, so it can't update itself.")
            return
        if self.git("fetch", "--quiet").returncode:
            if not quiet:
                self.notify("Couldn't reach GitHub to check for updates.")
            return
        behind = self.git("rev-list", "--count", "HEAD..@{upstream}").stdout.strip()
        remote = self.git("show", "@{upstream}:VERSION").stdout.strip() or "?"
        self.update_info = {"current": VERSION, "latest": remote, "behind": int(behind or 0), "checked": time.time()}
        self.bus.put(("update", self.update_info))
        if not behind or behind == "0":
            if not quiet:
                self.notify(f"Yo Claude {VERSION} is up to date.")
            return
        if quiet:
            if self.update_info.get("announced") != remote:
                self.notify(f"Yo Claude {remote} is available (you have {VERSION}). "
                            "Help → Check for updates to install it.")
            self.update_info["announced"] = remote
            return
        if self.replying():
            self.notify("An update is ready, but Claude is in the middle of a reply. "
                        "Check for updates again when it's done.")
            return
        self.notify("Updating Yo Claude… it restarts in a moment. Background tasks keep running.")
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                          os.path.join(HERE, "install.ps1"), "-Update"], cwd=HERE,
                         creationflags=subprocess.CREATE_NEW_CONSOLE)
        self.quit()

    def notify(self, message):
        log.info("Notice: %s", message)
        try:
            self.tray.notify(message, "Yo Claude")
        except Exception:
            pass

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
                    self.write_status()
                elif kind == "notice":
                    self.notify(d["text"])
                elif kind == "announce":   # a session is done: the voice says its short line when it's free
                    self.commands.put(("announce", d["text"]))
                main_events.append({"kind": kind, **d})
                if kind in BAR_FEED:
                    bar_events.append(main_events[-1])
            new_display = display_state(self.voice_state, self.work_state)
            if new_display != self.display or any(e["kind"] in ("state", "work") for e in main_events):
                self.display = new_display
                ev = {"kind": "display", "state": self.display, "voice": self.voice_state, "work": self.work_state,
                      "text": self.voice_text, "hold": self.voice_hold}
                main_events.append(ev)
                bar_events.append(ev)
                self.update_tray()
                self.update_bar_visibility()
                if getattr(self, "taskbar", None):
                    self.taskbar.show(self.display)
            if levels:
                bar_events.append({"kind": "levels", "levels": levels})
                main_events.append({"kind": "levels", "levels": levels})
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
        self.main.hide()        # closing the window keeps Yo Claude running in the tray (and brings the bar back)
        self.settings["show_window"] = False
        self.settings.save()
        self.set_main_visible(False)
        return False

    def show_main(self):
        self.main.show()
        self.main.restore()
        self.dress_main()
        self.settings["show_window"] = True
        self.settings.save()
        self.set_main_visible(True)

    def set_main_visible(self, visible):
        """The bar lives inside the window while it's on screen; the floating bar only shows when it isn't."""
        self.main_visible = visible
        self.update_bar_visibility()

    def dress_main(self):
        """Mascot window icon, and the taskbar button's progress/badge (needs the window to exist)."""
        try:
            hwnd = self.main.native.Handle.ToInt32()
        except Exception:
            return
        taskbar.set_window_icon(hwnd, icons.ICO_PATH)
        taskbar.style_title_bar(hwnd)
        if self.taskbar is None:
            self.taskbar = taskbar.Taskbar(hwnd)
            self.taskbar.show(self.display)

    def ensure_shortcuts(self):
        target = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        key = [target, HERE]
        if self.settings.get("shortcuts") == key:
            return
        try:
            made = icons.make_shortcuts(APP_ID, target, f'"{os.path.join(HERE, "app.py")}"', HERE, icons.ICO_PATH)
            log.info("Shortcuts: %s", ", ".join(made))
            self.settings["shortcuts"] = key
            self.settings.save()
        except Exception as e:
            log.warning("Couldn't create shortcuts: %s", e)

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
        """Keep the bar's bottom edge where it was (default: bottom centre, just above the taskbar).
        Only while it's shown: moving or resizing a hidden pywebview window makes it appear."""
        self.bar_height = height
        if not getattr(self, "bar_shown", False):
            return
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
        if self.main_visible or not self.settings.get("show_bar", True):
            return False
        busy = self.display not in ("idle", "paused")
        held = self.voice_text and self.voice_hold and self.voice_state in ("idle", "paused")
        return self.settings.get("bar_when_idle", True) or busy or bool(held)

    def update_bar_visibility(self):
        want = self.bar_wanted()
        if want != getattr(self, "bar_shown", None):
            self.bar_shown = want
            if want:
                self.bar.show()
                self.style_bar()
                self.place_bar(getattr(self, "bar_height", 56))
            else:
                self.bar.hide()

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
            pystray.MenuItem("More accurate speech recognition (slower)",
                             toggle("accurate_speech", lambda on: self.commands.put(("accurate_speech", on))),
                             checked=lambda item: bool(s.get("accurate_speech", False))),
            pystray.MenuItem("PC control (screen, keyboard, mouse)", toggle("pc_control", lambda on: self.router.reconnect_all()),
                             checked=checked("pc_control")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Floating bar when the window is closed", toggle("show_bar"), checked=checked("show_bar")),
            pystray.MenuItem("Keep floating bar visible when idle", toggle("bar_when_idle"),
                             checked=checked("bar_when_idle")),
            pystray.MenuItem("Launch with Windows", toggle("launch_at_login", set_launch_at_login),
                             checked=checked("launch_at_login")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Training mode…", lambda: self.open_training()),
            pystray.MenuItem("Check for updates…",
                             lambda: threading.Thread(target=self.check_updates, daemon=True).start()),
            pystray.MenuItem("Open log", lambda: os.startfile(LOG_PATH)),
            pystray.MenuItem("Quit", lambda: self.request_quit()),
        )
        icon = pystray.Icon("YoClaude", icons.tray_frame("starting", 0), "Yo Claude – starting", menu)
        icon.run_detached()
        return icon

    def open_training(self):
        self.show_main()
        self.bus.put(("open_training", {}))

    def name(self):
        """Yo Claudia with the female character, Yo Claude with the male one (the default), face shown or not."""
        return "Yo Claudia" if self.settings.get("character") == "female" else "Yo Claude"

    def update_tray(self):
        if self.tray:
            moving = self.settings.get("tray_animate", True)   # (Options > Animated Tray Icon)
            self.tray.icon = icons.tray_frame(self.display, self.tick if moving else 1)
            self.tray.title = f"{self.name()} – {self.display.replace('_', ' ')}"

    def animate(self):
        while True:
            time.sleep(0.2)
            self.tick += 1
            if icons.animated(self.display) or self.tick % 20 in (0, 1):
                self.update_tray()

    def replying(self):
        """Sessions in the middle of a reply (quitting would cut those off; background tasks survive a restart)."""
        return [b for b in self.router.busy_report() if b["state"] != "background"]

    def write_status(self):
        """~/.yoclaude/status.json: what's busy right now, for anything (or anyone) about to restart Yo Claude."""
        try:
            with open(os.path.join(DATA_DIR, "status.json"), "w", encoding="utf-8") as f:
                json.dump({"updated": time.time(), "pid": os.getpid(), "busy": self.router.busy_report()}, f, indent=1)
        except Exception as e:
            log.debug("status.json: %s", e)

    def request_quit(self):
        """From the tray: ask first if a reply is in progress."""
        busy = self.replying()
        if not busy:
            return self.quit()
        self.show_main()
        self.bus.put(("confirm_quit", {"busy": busy}))

    def quit(self):
        self.quitting = True
        self.commands.put("quit")
        self.router.shutdown()   # leaves sessions with background tasks running; picked up again next start
        try:
            os.remove(os.path.join(DATA_DIR, "status.json"))
        except OSError:
            pass
        if self.tray:
            self.tray.stop()
        for w in (self.bar, self.main):
            try:
                w.destroy()
            except Exception:
                pass


def missing(path, cwd=None):
    """Why a path can't be opened: gone, or never existed where we looked."""
    shown = path if not cwd or os.path.isabs(path or "") else os.path.join(cwd, path)
    parent = os.path.dirname(os.path.normpath(shown or ""))
    if parent and not os.path.isdir(parent):
        return f"Folder not found: {parent}"
    return f"File not found: {shown}. It may have been moved, renamed or deleted."


def open_error(full, e):
    win = getattr(e, "winerror", None)
    ext = os.path.splitext(full)[1].lower()
    if win == 1155 or win == 1156:
        return f"No app is set up to open {ext or 'this kind of'} files. Try “open with…” and choose one."
    if win == 5 or isinstance(e, PermissionError):
        return f"Windows refused access to {os.path.basename(full)}."
    if win == 2 or isinstance(e, FileNotFoundError):
        return missing(full)
    return f"Couldn't open {os.path.basename(full)}: {e.strerror or e}"


class Api:
    """Called from the pages' JavaScript (window.pywebview.api.*)."""

    def __init__(self, app):
        self._app = app

    # --- state ---
    def init(self):
        a = self._app
        r = a.router
        if not getattr(self, "reopened", False):   # once per run: back to your last conversation, if it was recent
            self.reopened = True
            r.reopen_last()
        active = r.active
        return {"version": VERSION, "update": getattr(a, "update_info", None), "limits": r.limits,
                "settings": dict(a.settings), "folder": r.folder, "folders": r.meta.data["recent_folders"],
                "workspaces": r.workspaces(), "groups": r.meta.data["groups"], "sessions": r.list(r.folder),
                "active": r.describe(active) if active else None, "items": active.items if active else [],
                "display": {"state": a.display, "voice": a.voice_state, "work": a.work_state, "text": a.voice_text}}

    def fix_text(self, text):
        """The message box, as you pause typing: {"text": your message with spelling and grammar fixed} (the same
        text when there's nothing to fix, the setting's off, or the fix fails)."""
        r = self._app.router
        try:
            return {"text": r.tidy(text, r.active.id if r.active else None).result(20)}
        except Exception as e:
            log.info("Couldn't fix the message: %s", e or type(e).__name__)
            return {"text": text}

    def say_short(self, i):
        """The 🔊 button on Claude's messages: the short spoken version of message `i` in the open session."""
        r = self._app.router
        return r.say_short(r.active.id, i) if r.active else {"error": "Open a session first."}

    def btw_ask(self, sid, question, bid=None):
        """/btw: a side question about session `sid`, answered in a side chat that isn't added to the conversation
        (a follow-up when `bid` is the open side chat). Answers arrive as "btw" events."""
        return self._app.router.btw_ask(sid, question, bid)

    def btw_close(self, sid, bid=None):
        """Close the side chat (discarding it)."""
        return self._app.router.btw_close(sid, bid)

    def say_again(self, text):
        return self._app.router.say_again(text)

    def retry(self):
        """Send your last message in the open session again (the retry button on an error)."""
        return self._app.router.retry()

    def cancel_queued(self, i):
        """Take back a queued message in the open session (it goes back in the box)."""
        r = self._app.router
        return r.cancel_queued(r.active.id, i) if r.active else {"error": "Open a session first."}

    def send_now(self, i):
        """Give a queued message to Claude now, during the reply in progress, instead of after it."""
        r = self._app.router
        return r.send_now(r.active.id, i) if r.active else {"error": "Open a session first."}

    def rewind(self, uuid, mode="both", export=False):
        """Rewind the open session to before one of your messages (see Router.rewind)."""
        r = self._app.router
        return r.rewind(r.active.id, uuid, mode, bool(export)) if r.active else {"error": "Open a session first."}

    def set_loadout(self, kind, name, on):
        """Turn an MCP server ("mcp"), skill ("skill") or plugin ("plugin") on or off for Yo Claude's sessions."""
        return self._app.router.set_loadout(kind, name, bool(on))

    def set_setting(self, key, value):
        a = self._app
        a.settings[key] = value
        a.settings.save()
        if key == "launch_at_login":
            set_launch_at_login(bool(value))
        if key == "pc_control":
            a.router.reconnect_all()
        if key == "accurate_speech":
            a.commands.put(("accurate_speech", bool(value)))
        a.commands.put("settings")
        a.update_bar_visibility()
        a.emit_settings()
        if key == "character":
            try:
                a.main.set_title(a.name())
            except Exception as e:
                log.debug("set_title: %s", e)

    # --- folders ---
    def pick_folder(self):
        result = self._app.main.create_file_dialog(webview.FileDialog.FOLDER)
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
    def new_session(self, cwd="current"):
        """cwd: a folder, null for a chat, or omitted for the folder of the session you're in."""
        r = self._app.router
        return r.describe(r.new_session(cwd, picked=True))

    def add_folder(self):
        result = self._app.main.create_file_dialog(webview.FileDialog.FOLDER)
        if result:
            self._app.router.set_workspace(result[0], True)
            return result[0]
        return None

    def remove_folder(self, folder):
        self._app.router.set_workspace(folder, False)

    def add_extra_dir(self, sid):
        """Pick another folder this session may read and write."""
        s = self._app.router.live.get(sid)
        if not s:
            return "Open the session first."
        result = self._app.main.create_file_dialog(webview.FileDialog.FOLDER)
        if not result:
            return None
        return self._app.router.set_extra_dirs(sid, s.extra_dirs + [result[0]])

    def remove_extra_dir(self, sid, folder):
        s = self._app.router.live.get(sid)
        if s:
            return self._app.router.set_extra_dirs(sid, [d for d in s.extra_dirs if d != folder])

    # --- viewing files: attachments, things Claude made, the file tree ---
    def _resolve(self, path, cwd=None):
        if not path:
            return None
        cwd = cwd or self._cwd()
        full = path if os.path.isabs(path) else os.path.join(cwd or "", path)
        full = os.path.normpath(full)
        return full if os.path.exists(full) else None

    def media(self, path, cwd=None):
        """How to show a file: {kind, url, path, name, size} (kind: image/video/audio/pdf/file)."""
        full = self._resolve(path, cwd)
        if not full or not os.path.isfile(full):
            return {"error": missing(path, cwd)}
        return {"kind": media.kind_of(full), "url": self._app.media.url(full), "path": full,
                "name": os.path.basename(full), "size": os.path.getsize(full)}

    def resolve_media(self, paths, cwd=None):
        """Of the paths mentioned in a reply, the existing images/video/audio/PDFs (shown under the message)."""
        out = []
        for p in (paths or [])[:12]:
            info = self.media(p, cwd)
            if "error" not in info and info["kind"] != "file":
                out.append(info)
        return out

    def resolve_paths(self, paths, cwd=None):
        """Which of the paths a reply mentions exist: {token, path, kind (dir/image/video/audio/pdf/file), name}."""
        out = []
        for token in dict.fromkeys(paths or []):
            if len(out) >= 40:
                break
            full = self._resolve(str(token).strip().strip("'\""), cwd)
            if full:
                kind = "dir" if os.path.isdir(full) else media.kind_of(full)
                info = {"token": token, "path": full, "kind": kind, "name": os.path.basename(full) or full}
                if kind not in ("dir", "file"):
                    info["url"] = self._app.media.url(full)
                out.append(info)
        return out

    def open_with_options(self, path, cwd=None):
        """The apps Windows has for this file's type (default first)."""
        full = self._resolve(path, cwd)
        return openwith.handlers(full) if full and os.path.isfile(full) else []

    def open_with(self, path, handler_id, cwd=None):
        return self._open(path, cwd, "with", handler_id)

    def pop_out(self, path, cwd=None):
        """A file in its own resizable window (video, pictures, PDFs, text)."""
        full = self._resolve(path, cwd)
        if not full or not os.path.isfile(full):
            return missing(path, cwd)
        webview.create_window(os.path.basename(full), self._app.media.url(full), width=1100, height=720,
                              background_color="#000000")
        return None

    def read_any(self, path, cwd=None):
        """Text preview of any file you click on (attachments may live outside the session's folder)."""
        full = self._resolve(path, cwd)
        if not full or not os.path.isfile(full):
            return {"error": missing(path, cwd)}
        return dict(workspace.read_file(os.path.dirname(full), os.path.basename(full)), full=full)

    def save_text(self, path, text, mtime=None, cwd=None):
        """Save a text file edited in the viewer."""
        full = self._resolve(path, cwd)
        if not full or not os.path.isfile(full):
            return {"error": missing(path, cwd)}
        try:
            return workspace.write_text(full, text, mtime)
        except OSError as e:
            log.warning("save %s failed: %s", full, e)
            return {"error": open_error(full, e)}

    def open_path(self, path, how="open", cwd=None):
        return self._open(path, cwd, how)

    def _open(self, path, cwd, how, handler_id=None):
        """Open, open with, show in Explorer or VS Code. Returns a plain-English message when it can't."""
        full = self._resolve(path, cwd)
        if not full:
            return missing(path, cwd)
        try:
            if how == "open":
                os.startfile(full)
            elif how == "with":
                openwith.launch(full, handler_id)
            elif how == "openwith":   # Windows' own "Open with" chooser
                subprocess.Popen(["rundll32.exe", "shell32.dll,OpenAs_RunDLL", full])
            elif how == "reveal":
                subprocess.Popen(["explorer", "/select,", full])
            elif how == "code":
                workspace.open_in_editor(os.path.dirname(full), os.path.basename(full))
            return None
        except OSError as e:
            log.warning("open %s (%s) failed: %s", full, how, e)
            return open_error(full, e)

    def open_url(self, url):
        if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
            import webbrowser
            webbrowser.open(url)

    def open_session(self, sid, cwd):
        self._app.router.open(sid, cwd)

    def list_sessions(self, cwd):
        return self._app.router.list(cwd)

    def send(self, text, attachments=None, images=None):
        """attachments: folder-relative paths; images: data: URLs pasted into the box."""
        text = (text or "").strip()
        attachments, images = attachments or [], images or []
        if not text and not attachments and not images:
            return
        cwd = self._cwd()
        context = "\n\n".join(workspace.attachment_text(cwd, p) for p in attachments) if cwd else ""
        pics = []
        for url in images:
            head, _, data = url.partition(",")
            if head.startswith("data:image/") and ";base64" in head:
                pics.append((head[5:].split(";")[0], data))
        self._app.router.send(text or "(see attached)", context=context, attachments=attachments, images=pics)

    def stop(self):
        self._app.commands.put("stop")
        self._app.router.interrupt()

    def approve(self, sid, aid, allow, always=False):
        self._app.router.approve(sid, aid, bool(allow), bool(always))

    def reorder_queue(self, order):
        """Queued messages dragged into a new order (their indexes, first to go first) in the open session."""
        r = self._app.router
        return r.reorder_queue(r.active.id, order) if r.active else {"error": "Open a session first."}

    def checklist_answer(self, sid, cid, picks, note=""):
        """[submit] on Claude's checklist card: your yes/no (and why) per item go to Claude as your next message."""
        return self._app.router.checklist_answer(sid, cid, picks, note)

    def answer_question(self, sid, aid, answers=None):
        """Answers to Claude's AskUserQuestion card ({question: label or [labels]}); None skips it."""
        if isinstance(answers, dict):
            answers = {str(q): [str(x) for x in a] if isinstance(a, list) else str(a)
                       for q, a in answers.items() if isinstance(a, (str, list))}
        else:
            answers = None
        self._app.router.answer(sid, aid, answers)

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

    def stale_sessions(self):
        return self._app.router.stale()

    def clean_up(self, items):
        return self._app.router.delete_many(items or [])

    def trash(self):
        return self._app.router.trash()

    def restore(self, sid):
        return self._app.router.restore(sid)

    def fork(self, sid, cwd):
        new_id, error = self._app.router.fork(sid, cwd)
        if new_id:
            self._app.router.open(new_id, cwd)
        return error

    # --- workspace (the active session's folder, else the chosen folder) ---
    def _cwd(self):
        r = self._app.router
        return r.active.cwd if r.active else r.folder

    def _ws(self, fn, *args, root=None):
        """fn(folder, *args) in the session's folder, or in `root`: the folder the files tab is browsing (any folder
        on the PC: the file tree can go anywhere)."""
        cwd = root or self._cwd()
        if not cwd:
            return {"error": "No folder. Pick one (top left) to work on code."}
        try:
            return fn(cwd, *args)
        except Exception as e:
            log.warning("%s failed: %s", fn.__name__, e)
            return {"error": str(e)}

    def tree(self, rel="", root=None):
        if root == "::pc":   # above the drives' top folders
            return workspace.drives()
        return self._ws(workspace.list_dir, rel, root=root)

    def add_context_dir(self, path):
        """Files tab, right-click a folder: the open session may also read and write it (its next message on)."""
        s = self._app.router.active
        if not s:
            return "Open a session first."
        if any(same_folder(path, d) for d in [s.cwd, *s.extra_dirs] if d):
            return "That folder is in this session already."
        return self._app.router.set_extra_dirs(s.id, s.extra_dirs + [path])

    def files(self):
        return self._ws(workspace.all_files)

    def commands(self):
        """Claude Code's slash commands for the active session's folder (or any folder's, before one has connected)."""
        known = self._app.router.meta.data.get("commands") or {}
        return known.get(self._cwd() or "") or next(iter(known.values()), [])

    def read_file(self, rel):
        return self._ws(workspace.read_file, rel)

    def git_info(self):
        return self._ws(workspace.git_info)

    def switch_branch(self, name):
        err = self._ws(workspace.switch_branch, name)
        self._app.router.sessions_changed(self._cwd())
        return err

    def create_branch(self, name):
        return self._ws(workspace.create_branch, name)

    def _session(self):
        return self._app.router.active

    def changes(self):
        s = self._session()
        if not s or not s.cwd:
            return {"files": [], "none": "No code session open."}
        if not s.baseline:
            if workspace.is_repo(s.cwd):
                return {"files": [], "none": "Taking a snapshot of the folder…"}
            return {"repo": False, "files": [{"path": p, "status": "M", "add": 0, "del": 0} for p in s.touched],
                    "kind": "tools"}
        out = workspace.changes(s.cwd, s.baseline)
        out["kind"] = s.baseline_kind
        return out

    def file_diff(self, path):
        s = self._session()
        return workspace.file_diff(s.cwd, s.baseline, path) if s and s.baseline else ""

    def revert_file(self, path):
        s = self._session()
        if not s or not s.baseline:
            return "No snapshot for this session."
        return workspace.revert_file(s.cwd, s.baseline, path)

    def open_in_editor(self, rel="", root=None):
        return self._ws(workspace.open_in_editor, rel, root=root)

    def reveal(self, rel="", root=None):
        return self._ws(workspace.reveal, rel, root=root)

    # file explorer (the files tab): each returns {"path"/"paths": ..., "error": plain-English message}
    def new_file(self, folder, name, root=None):
        return self._ws(workspace.create_file, folder or "", name, root=root)

    def new_folder(self, folder, name, root=None):
        return self._ws(workspace.create_folder, folder or "", name, root=root)

    def rename_path(self, rel, name, root=None):
        return self._ws(workspace.rename_path, rel, name, root=root)

    def delete_paths(self, rels, root=None):
        return self._ws(workspace.delete_paths, list(rels or []), root=root)

    def copy_paths(self, rels, dest="", root=None):
        return self._ws(workspace.copy_paths, list(rels or []), dest or "", root=root)

    def move_paths(self, rels, dest="", root=None):
        return self._ws(workspace.move_paths, list(rels or []), dest or "", root=root)

    def duplicate_paths(self, rels, root=None):
        return self._ws(workspace.duplicate_paths, list(rels or []), root=root)

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
        log.debug("bar_resize(%s)", height)
        self._app.place_bar(max(56, min(320, int(height))))

    def compact(self):
        """Expanded -> compact: hide the window, show the bar."""
        a = self._app
        a.settings["show_bar"] = True
        a.main.hide()
        a.settings["show_window"] = False
        a.settings.save()
        a.bar_shown = None
        a.set_main_visible(False)

    def open_log(self):
        os.startfile(LOG_PATH)

    # --- training mode ---
    def train(self, on):
        self._app.commands.put(("train", bool(on)))
        if on:
            self._app.show_main()

    def set_wake_alternates(self, phrases):
        phrases = [p.strip().lower() for p in phrases or [] if p and p.strip()]
        self._app.settings["wake_alternates"] = phrases
        self._app.settings.save()
        self._app.commands.put(("alternates", phrases))
        self._app.emit_settings()

    # --- about, updates, clipboard, folders by path ---
    def about(self):
        a = self._app
        commit = a.git("log", "-1", "--format=%h %cs").stdout.strip() if os.path.isdir(os.path.join(HERE, ".git")) else ""
        return {"version": VERSION, "commit": commit, "folder": HERE, "data": DATA_DIR,
                "python": sys.version.split()[0], "update": getattr(a, "update_info", None)}

    def check_updates(self):
        threading.Thread(target=self._app.check_updates, daemon=True).start()

    def copy_text(self, text):
        """Clipboard via Windows itself (works whatever the page is allowed to do)."""
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(str(text), win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()

    def open_folder_path(self, path):
        """A folder typed or pasted into the folder field: start a session there (and add it to the tree)."""
        path = os.path.normpath(os.path.expandvars(os.path.expanduser((path or "").strip().strip('"'))))
        if not os.path.isdir(path):
            return f"No such folder: {path}"
        self._app.router.set_workspace(path, True)
        self.new_session(path)
        return None

    def paste_text(self):
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        except Exception:
            return ""
        finally:
            win32clipboard.CloseClipboard()

    def repo_url(self):
        url = self._app.git("remote", "get-url", "origin").stdout.strip()
        return url[:-4] if url.endswith(".git") else url

    def open_data_folder(self):
        os.startfile(DATA_DIR)

    def request_quit(self):
        threading.Thread(target=self._app.request_quit, daemon=True).start()

    def quit(self, force=False):
        a = self._app
        if force or not a.replying():
            threading.Thread(target=a.quit, daemon=True).start()

    def stop_task(self, sid, task_id):
        return self._app.router.stop_task(sid, task_id)

    def tasks(self):
        return self._app.router.tasks_list()

    def task_output(self, key):
        return self._app.router.task_output(key)

    def ui_loaded(self, info):
        log.info("Window loaded: %s", str(info)[:300])

    def js_error(self, message):
        log.warning("page error: %s", str(message)[:2000])


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
    # A new port each launch: on pywebview's fixed default (42001) the window's cache can serve an old interface
    # after an update.
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    webview.start(app.started, private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"),
                  icon=icons.make_ico(), http_port=port)
    del mutex


if __name__ == "__main__":
    main()
