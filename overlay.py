"""Yo Claude's on-screen parts: a floating retro-terminal bar at the bottom of the screen and a tray icon.

The bar shows Claude Code's pixel mascot, a blocky mic level meter, what the assistant is doing, what it heard and
what Claude said, with [_] (minimise to the tray) and [■] (stop) buttons. Click the mascot to talk without the wake
word; drag the bar anywhere. The tray icon's menu switches the wake word, voice replies and PC control on and off.
"""

import ctypes
import math
import os
import queue
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
import winreg
from collections import deque

import pystray
from PIL import Image, ImageDraw, ImageTk

KEY = "#010203"   # transparent colour around the bar
BG = (17, 17, 16)
SCANLINE = (12, 12, 11)
BORDER = (74, 62, 54)
TEXT = "#e8e4da"
DIM = "#8f8a80"
ORANGE = "#d97757"
COLORS = {"starting": "#8f8a80", "idle": "#b06a52", "paused": "#5c5a56", "listening": ORANGE,
          "thinking": "#e8b04b", "speaking": "#9fd17f", "error": "#ff6b6b"}
ACTIVE = ("listening", "thinking", "speaking")
SPINNER = "·✢✳✶✻✽✻✶✳✢"   # Claude Code's thinking glyphs
COLS = 24
MAX_TEXT = 400

# Claude Code's welcome-screen mascot, from its block characters (" ▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝"). Each pixel is
# twice as tall as it is wide, like a quarter of a terminal cell.
CLAWD = ["...############...",
         "...##.######.##...",
         ".################.",
         "...############...",
         "....#.#....#.#...."]
BLINK = CLAWD[:1] + ["...############..."] + CLAWD[2:]
WALK = CLAWD[:4] + [".....#.#..#.#....."]


def blend(rgb, other, t):
    return "#%02x%02x%02x" % tuple(int(a + (b - a) * t) for a, b in zip(other, rgb))


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def loudness(level):
    """RMS (int16) to 0..1 on a log scale: room noise ~0.05, normal speech ~0.7."""
    db = 20 * math.log10(level / 32768 + 1e-9)
    return min(1.0, max(0.0, (db + 62) / 45))


def work_area():
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
    r = RECT()
    ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(r), 0)   # SPI_GETWORKAREA
    return r.left, r.top, r.right, r.bottom


def panel(w, h, border):
    """Square-cornered terminal panel with faint scanlines and a 2px border."""
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    for y in range(0, h, 3):
        d.line((0, y, w, y), fill=SCANLINE)
    d.rectangle((0, 0, w - 1, h - 1), outline=BORDER, width=border)
    return img


def tray_image(color):
    """The mascot on a transparent background, filling the icon's width."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pw, ph = 3.5, 7
    top = (64 - ph * len(CLAWD)) / 2
    for y, row in enumerate(CLAWD):
        for x, c in enumerate(row):
            if c == "#":
                d.rectangle((x * pw + 0.5, top + y * ph, (x + 1) * pw - 0.5, top + (y + 1) * ph - 1), fill=color)
    return img


def promote_tray_icon(settings):
    """Windows 11 hides new tray icons behind the ^ arrow. Show this one on the taskbar, the first time Windows
    lists it; if you later move it back into the overflow in Settings, that choice is left alone."""
    done = set(settings.get("tray_promoted", []))
    root = r"Control Panel\NotifyIconSettings"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root) as k:
            names = [winreg.EnumKey(k, i) for i in range(winreg.QueryInfoKey(k)[0])]
        for name in names:
            if name in done:
                continue
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"{root}\{name}", 0,
                                winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
                try:
                    tip = winreg.QueryValueEx(k, "InitialTooltip")[0]
                except OSError:
                    continue
                if str(tip).startswith("Yo Claude"):
                    winreg.SetValueEx(k, "IsPromoted", 0, winreg.REG_DWORD, 1)
                    done.add(name)
    except OSError:
        return
    settings["tray_promoted"] = sorted(done)
    settings.save()


class Bar:
    def __init__(self, root, settings, events, commands, log_path):
        self.root, self.settings, self.events, self.commands, self.log_path = root, settings, events, commands, log_path
        self.s = root.winfo_fpixels("1i") / 96
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.attributes("-transparentcolor", KEY)
        root.configure(bg=KEY)
        self.W, self.H = self.px(560), self.px(56)
        self.canvas = tk.Canvas(root, width=self.W, height=self.H, bg=KEY, highlightthickness=0)
        self.canvas.pack()
        families = set(tkfont.families())
        mono = next((f for f in ("Cascadia Mono", "Cascadia Code", "Consolas") if f in families), "Courier New")
        self.font = (mono, 10)
        self.label_font = (mono, 9, "bold")
        self.levels = deque([0.0] * COLS, maxlen=COLS)
        self.state, self.text, self.hold_until = "starting", "", 0.0
        self.panel_img, self.panel_key = None, None
        self.buttons = {}          # name -> (x1, y1, x2, y2), from the last draw
        self.hover = None
        self.drag = None
        self.minimised = False     # hidden with [_] until the next conversation starts
        left, top, right, bottom = work_area()
        pos = settings.get("bar_pos")
        self.x = pos[0] if pos else (left + right - self.W) // 2
        self.bottom = pos[1] if pos else bottom - self.px(14)
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<Leave>", lambda e: setattr(self, "hover", None))
        self.canvas.bind("<Button-3>", lambda e: self.commands.put("stop"))
        root.update_idletasks()
        self.no_activate()
        self.place()
        self.tray = self.make_tray()
        threading.Timer(4, promote_tray_icon, args=(settings,)).start()
        self.visible = True
        self.tick()

    def px(self, v):
        return int(v * self.s)

    def no_activate(self):
        """Clicking the bar mustn't steal focus from the window you're working in; also keep it off the taskbar."""
        hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
        ex = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
        ctypes.windll.user32.SetWindowLongW(hwnd, -20, ex | 0x08000000 | 0x80)   # WS_EX_NOACTIVATE | TOOLWINDOW

    def place(self):
        self.root.geometry(f"{self.W}x{self.H}+{self.x}+{self.bottom - self.H}")

    def hit(self, x, y):
        for name, (x1, y1, x2, y2) in self.buttons.items():
            if x1 <= x <= x2 and y1 <= y <= y2:
                return name
        return None

    # --- mouse ---
    def on_press(self, e):
        self.drag = (e.x_root, e.y_root, self.x, self.bottom, False)

    def on_drag(self, e):
        if not self.drag:
            return
        x0, y0, wx, wb, moved = self.drag
        dx, dy = e.x_root - x0, e.y_root - y0
        if moved or abs(dx) + abs(dy) > 4:
            self.drag = (x0, y0, wx, wb, True)
            self.x, self.bottom = wx + dx, wb + dy
            self.place()

    def on_release(self, e):
        moved = self.drag and self.drag[4]
        self.drag = None
        if moved:
            self.settings["bar_pos"] = [self.x, self.bottom]
            self.settings.save()
            return
        button = self.hit(e.x, e.y)
        if button == "minimise":
            self.minimise()
        elif button == "stop":
            self.commands.put("stop")
        elif button == "clawd" or self.state not in ACTIVE:
            self.commands.put("talk")

    def on_motion(self, e):
        self.hover = self.hit(e.x, e.y)
        self.canvas.configure(cursor="hand2" if self.hover or self.state not in ACTIVE else "fleur")

    def minimise(self):
        self.minimised = True
        self.settings["bar_when_idle"] = False
        self.settings.save()
        self.tray.update_menu()

    # --- events from the assistant ---
    def tick(self):
        try:
            while True:
                kind, d = self.events.get_nowait()
                if kind == "level":
                    self.levels.append(loudness(d["level"]))
                elif kind == "state":
                    self.set_state(d["state"], d.get("text", ""), d.get("hold", 0.0))
                elif kind == "settings":
                    if self.settings["bar_when_idle"]:
                        self.minimised = False
                    self.tray.update_menu()
                elif kind == "quit":
                    return self.quit()
        except queue.Empty:
            pass
        self.update_visibility()
        if self.visible:
            self.draw()
        self.root.after(33, self.tick)

    def set_state(self, state, text, hold):
        if state in ACTIVE and self.state not in ACTIVE:
            self.minimised = False   # a new conversation brings the bar back
        self.state, self.text = state, (text or "")
        self.hold_until = time.time() + hold if hold else 0.0
        self.tray.icon = tray_image(COLORS.get(state, COLORS["idle"]))
        self.tray.title = f"Yo Claude – {state}"

    def shown_text(self):
        if self.state in ACTIVE or self.state == "error":
            return self.text
        return self.text if time.time() < self.hold_until else ""

    def update_visibility(self):
        want = not self.minimised and (self.settings["bar_when_idle"] or self.state in ACTIVE
                                       or self.state in ("starting", "error") or bool(self.shown_text()))
        if want != self.visible:
            self.visible = want
            if want:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
            else:
                self.root.withdraw()

    def label(self):
        now = time.time()
        cursor = "█" if int(now * 2) % 2 else " "
        return {
            "starting": "> booting" + cursor,
            "idle": '> say "yo claude"' + cursor,
            "paused": "> wake word off · click to talk",
            "listening": ("> follow-up? " if self.text else "> listening ") + cursor,
            "thinking": SPINNER[int(now * 8) % len(SPINNER)] + " thinking…",
            "speaking": "● claude",
            "error": "! error",
        }.get(self.state, self.state)

    # --- drawing ---
    def draw(self):
        c, s = self.canvas, self.s
        state = self.state
        color = COLORS.get(state, COLORS["idle"])
        rgb = hex_rgb(color)
        now = time.time()
        text = self.shown_text()
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT].rsplit(" ", 1)[0] + "…"

        text_x = self.px(222)
        text_w = self.W - text_x - self.px(92)
        c.delete("all")
        body_h = 0
        if text:   # measure the text to size the bar (it grows upwards for long replies)
            t = c.create_text(0, 0, text=text, font=self.font, width=text_w, anchor="nw")
            x1, y1, x2, y2 = c.bbox(t)
            body_h = min(y2 - y1, self.px(112))
            c.delete(t)
        H = max(self.px(56), body_h + self.px(40)) if text else self.px(56)
        if H != self.H:
            self.H = H
            c.configure(height=H)
            self.place()
        border = max(2, self.px(2))
        if self.panel_key != (self.W, self.H):
            self.panel_img = ImageTk.PhotoImage(panel(self.W, self.H, border))
            self.panel_key = (self.W, self.H)
        c.create_image(0, 0, image=self.panel_img, anchor="nw")
        cy = self.H / 2

        # mascot: blinks when idle, bounces with your voice when listening, walks while talking
        pw, ph = 3 * s, 6 * s
        frame = CLAWD
        if state in ("idle", "starting") and now % 4 < 0.15:
            frame = BLINK
        elif state == "speaking" and int(now * 4) % 2:
            frame = WALK
        bounce = -self.levels[-1] * 4 * s if state == "listening" else 0
        if state == "thinking":
            bounce = -abs(math.sin(now * 5)) * 2 * s
        mx, my = self.px(16), cy - ph * len(frame) / 2 + bounce
        mcolor = color if state in ACTIVE else blend(rgb, BG, 0.75)
        for y, row in enumerate(frame):
            for x, ch in enumerate(row):
                if ch == "#":
                    c.create_rectangle(mx + x * pw, my + y * ph, mx + (x + 1) * pw, my + (y + 1) * ph,
                                       fill=mcolor, width=0)
        self.buttons = {"clawd": (mx, cy - self.px(20), mx + pw * 18, cy + self.px(20))}

        # blocky level meter
        x0, cw, gap = self.px(86), 4 * s, 1 * s
        cell, cells = 3 * s, 4
        for i, lv in enumerate(self.levels):
            if state == "thinking":
                lv = 0.35 + 0.3 * math.sin(now * 6 - i * 0.5)
            elif state == "paused":
                lv = 0.0
            n = min(cells, round(lv * cells))
            fade = 0.3 + 0.7 * (i + 1) / COLS
            if state not in ACTIVE:
                fade *= 0.55
            fill = blend(rgb, BG, fade)
            x = x0 + i * (cw + gap)
            c.create_rectangle(x, cy - cell / 2, x + cw, cy + cell / 2, fill=blend(rgb, BG, 0.25), width=0)
            for k in range(1, n + 1):
                off = k * (cell + gap)
                c.create_rectangle(x, cy - cell / 2 - off, x + cw, cy + cell / 2 - off, fill=fill, width=0)
                c.create_rectangle(x, cy - cell / 2 + off, x + cw, cy + cell / 2 + off, fill=fill, width=0)

        # prompt line + text
        label = self.label()
        if text:
            top = (self.H - body_h - self.px(18)) / 2
            c.create_text(text_x, top, text=label, font=self.label_font, fill=color, anchor="nw")
            c.create_text(text_x, top + self.px(18), text=text, font=self.font, fill=TEXT, width=text_w, anchor="nw")
        else:
            c.create_text(text_x, cy, text=label, font=self.label_font,
                          fill=color if state in ACTIVE else DIM, anchor="w")

        # [■] stop (while active) and [_] minimise
        bx = self.W - self.px(14)
        for name, glyph in (("minimise", "[_]"), ("stop", "[■]")):
            if name == "stop" and state not in ACTIVE:
                continue
            hot = self.hover == name
            fill = (ORANGE if name == "minimise" else "#ff6b6b") if hot else DIM
            t = c.create_text(bx, cy, text=glyph, font=self.label_font, fill=fill, anchor="e")
            x1, y1, x2, y2 = c.bbox(t)
            self.buttons[name] = (x1 - 4, y1 - 6, x2 + 4, y2 + 6)
            bx = x1 - self.px(8)

    # --- tray ---
    def make_tray(self):
        settings = self.settings

        def toggle(key):
            def action(icon, item):
                settings[key] = not settings[key]
                settings.save()
                self.commands.put("settings")
                self.events.put(("settings", {}))
            return action

        def checked(key):
            return lambda item: bool(settings[key])

        menu = pystray.Menu(
            pystray.MenuItem("Talk now", lambda: self.commands.put("talk"), default=True),
            pystray.MenuItem("Stop", lambda: self.commands.put("stop")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Listen for “Yo Claude”", toggle("listening"), checked=checked("listening")),
            pystray.MenuItem("Voice replies", toggle("voice_replies"), checked=checked("voice_replies")),
            pystray.MenuItem("PC control (screen, keyboard, mouse)", toggle("pc_control"), checked=checked("pc_control")),
            pystray.MenuItem("Show bar when idle", toggle("bar_when_idle"), checked=checked("bar_when_idle")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open log", lambda: os.startfile(self.log_path)),
            pystray.MenuItem("Quit", lambda: self.events.put(("quit", {}))),
        )
        icon = pystray.Icon("YoClaude", tray_image(COLORS["starting"]), "Yo Claude – starting", menu)
        icon.run_detached()
        return icon

    def quit(self):
        self.commands.put("quit")
        self.tray.stop()
        self.root.destroy()


def run(settings, events, commands, log_path):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # crisp on high-DPI screens
    except Exception:
        pass
    root = tk.Tk()
    root.title("Yo Claude")
    bar = Bar(root, settings, events, commands, log_path)
    try:
        root.mainloop()
    except KeyboardInterrupt:
        bar.quit()
    time.sleep(0.3)   # let the assistant thread release the mic
