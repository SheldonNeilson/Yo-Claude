"""Claude Code's pixel mascot, drawn for the tray (animated per state), the window and the taskbar (.ico)."""

import ctypes
import os
import winreg

from PIL import Image, ImageDraw

# From Claude Code's welcome screen block characters (" ▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝"), trimmed to its 16 used
# columns. Pixels are taller than wide, like a quarter of a terminal cell.
CLAWD = ["..############..",
         "..##.######.##..",
         "################",
         "..############..",
         "...#.#....#.#..."]
BLINK = CLAWD[:1] + ["..############.."] + CLAWD[2:]
WALK = CLAWD[:4] + ["....#.#..#.#...."]
LOOK_L = CLAWD[:1] + ["..#.######.###.."] + CLAWD[2:]   # eyes one pixel left
LOOK_R = CLAWD[:1] + ["..###.######.#.."] + CLAWD[2:]

ORANGE = (217, 119, 87)
STATE_COLORS = {
    "starting": (150, 144, 134), "idle": ORANGE, "paused": (110, 108, 104), "listening": (255, 140, 96),
    "thinking": (232, 176, 75), "speaking": (159, 209, 127), "using_pc": (90, 176, 255),
    "approval": (255, 196, 0), "error": (255, 90, 90),
}
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")
ICO_PATH = os.path.join(DATA_DIR, "yo-claude.ico")


def tray_size():
    try:
        return max(16, ctypes.windll.user32.GetSystemMetrics(49))   # SM_CXSMICON
    except Exception:
        return 32


def draw(size, color, frame=CLAWD, dy=0, background=None):
    """The mascot filling a `size` square with whole-pixel cells (crisp, no smoothing)."""
    img = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    cols, rows = len(frame[0]), len(frame)
    cw = max(1, size // cols)
    ch = max(1, min(size // rows, cw * 3))
    ox = (size - cw * cols) // 2
    oy = (size - ch * rows) // 2 + dy
    d = ImageDraw.Draw(img)
    for y, row in enumerate(frame):
        for x, c in enumerate(row):
            if c == "#":
                d.rectangle((ox + x * cw, oy + y * ch, ox + (x + 1) * cw - 1, oy + (y + 1) * ch - 1),
                            fill=color + (255,))
    return img


def tray_frame(state, tick):
    """Tray icon for `state` at animation step `tick` (the app advances it ~5 times a second)."""
    size = tray_size()
    color = STATE_COLORS.get(state, ORANGE)
    frame, dy = CLAWD, 0
    if state in ("idle", "starting"):
        frame = BLINK if tick % 20 == 0 else CLAWD
    elif state == "listening":
        dy = -max(1, size // 16) if tick % 2 else 0
    elif state == "thinking":
        frame = BLINK if tick % 10 == 0 else CLAWD
        k = 0.65 + 0.35 * abs((tick % 6) - 3) / 3
        color = tuple(int(c * k) for c in color)
    elif state == "speaking":
        frame = WALK if tick % 2 else CLAWD
    elif state == "using_pc":
        frame = (LOOK_L, CLAWD, LOOK_R, CLAWD)[tick % 4]
    elif state == "approval":
        if tick % 2:
            color = ORANGE
    return draw(size, color, frame, dy)


def animated(state):
    return state not in ("idle", "paused", "starting", "error")


def make_ico():
    """Multi-size .ico for the window, taskbar and shortcuts (dark rounded square, orange mascot)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    images = []
    for s in sizes:
        bg = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        r = max(2, s // 6)
        ImageDraw.Draw(bg).rounded_rectangle((0, 0, s - 1, s - 1), radius=r, fill=(20, 20, 19, 255))
        pad = max(1, s // 10)
        m = draw(s - 2 * pad, ORANGE)
        bg.alpha_composite(m, (pad, pad))
        images.append(bg)
    images[-1].save(ICO_PATH, sizes=[(s, s) for s in sizes], append_images=images[:-1])
    return ICO_PATH


def promote_tray_icon(settings, tooltip_prefix="Yo Claude"):
    """Windows 11 hides new tray icons behind the ^ arrow. Show this one on the taskbar the first time Windows lists
    it; if you later move it back into the overflow in Settings, that choice is left alone."""
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
                if str(tip).startswith(tooltip_prefix):
                    winreg.SetValueEx(k, "IsPromoted", 0, winreg.REG_DWORD, 1)
                    done.add(name)
    except OSError:
        return
    settings["tray_promoted"] = sorted(done)
    settings.save()
